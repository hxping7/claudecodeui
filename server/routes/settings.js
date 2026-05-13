import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import multer from 'multer';
import { spawn } from 'child_process';
import { apiKeysDb, credentialsDb, notificationPreferencesDb, pushSubscriptionsDb, appConfigDb, agentConfigDb, userAgentConfigDb } from '../modules/database/index.js';
import { getPublicKey } from '../services/vapid-keys.js';
import { createNotificationEvent, notifyUserIfEnabled } from '../services/notification-orchestrator.js';
import { requireAdmin } from '../middleware/admin.js';
import { authenticateToken } from '../middleware/auth.js';
import { getCurrentUserHomeDir } from '../claude-sdk.js';

const router = express.Router();

// Helper to get current user's home directory with path validation
const getUserHomeDir = (req) => {
  const userHome = req.user?.home_dir || os.homedir();
  // Validate it's an absolute path (superadmin uses app source directory)
  if (!path.isAbsolute(userHome)) {
    console.error('Invalid home directory path:', userHome);
    return os.homedir();
  }
  return userHome;
};

// Configure multer for logo uploads (admin-only feature, shared path is fine)
const logosDir = path.join(os.homedir(), '.cloudcli', 'logos');
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(logosDir)) {
      fs.mkdirSync(logosDir, { recursive: true });
    }
    cb(null, logosDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `logo-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/svg+xml'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PNG, JPG, GIF, and SVG are allowed.'));
    }
  }
});

// Provider settings file paths - use authenticated user's home directory
const getProviderSettingsPaths = (userHomeDir) => ({
  claude: () => path.join(userHomeDir, '.claude', 'settings.json'),
  cursor: () => path.join(userHomeDir, '.cursor', 'settings.json'),
  codex: () => path.join(userHomeDir, '.codex', 'settings.json'),
  gemini: () => path.join(userHomeDir, '.gemini', 'settings.json'),
});

// Helper wrapper to get settings paths for current user
const getSettingsPath = (req, provider) => {
  const userHome = getUserHomeDir(req);
  return getProviderSettingsPaths(userHome)[provider]();
};

const isNumericId = (value) => typeof value === 'number' && Number.isFinite(value);

const isPamMode = () => (appConfigDb.get('auth_mode') || 'database') === 'linux';

const isSafeOsUsername = (value) => typeof value === 'string' && /^[a-z_][a-z0-9_-]*[$]?$/i.test(value);

const readTextFileAsUser = async (filePath, uid, gid, username) => {
  const script = `
    const fs = require('fs');
    const targetPath = process.env.TARGET_PATH;
    try {
      const content = fs.readFileSync(targetPath, 'utf8');
      process.stdout.write(content);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        process.exit(0);
      }
      throw error;
    }
  `;

  return await new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: getCurrentUserHomeDir() || process.env.HOME || os.homedir(), TARGET_PATH: filePath };
    const attemptDirect = () =>
      spawn(process.execPath, ['-e', script], {
        uid,
        gid,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    const attemptSudo = () =>
      spawn('sudo', ['-n', '-u', username, process.execPath, '-e', script], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    let child;
    try {
      child = attemptDirect();
    } catch (error) {
      if (error && error.code === 'EPERM' && isSafeOsUsername(username)) {
        child = attemptSudo();
      } else {
        reject(error);
        return;
      }
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (error && error.code === 'EPERM' && isSafeOsUsername(username)) {
        const fallback = attemptSudo();
        fallback.stdout.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
        });
        fallback.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        fallback.on('error', reject);
        fallback.on('close', (code) => {
          if (code === 0) {
            resolve(stdout);
            return;
          }
          const err = new Error(stderr || `Failed to read file as user "${username}" via sudo (exit ${code})`);
          err.code = 'READ_AS_USER_FAILED';
          reject(err);
        });
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      if (isSafeOsUsername(username)) {
        console.log(`[readTextFileAsUser] Direct read failed (exit ${code}), trying sudo fallback for user "${username}"`);
        const fallback = attemptSudo();
        let fallbackStdout = '';
        let fallbackStderr = '';
        fallback.stdout.on('data', (chunk) => {
          fallbackStdout += chunk.toString('utf8');
        });
        fallback.stderr.on('data', (chunk) => {
          fallbackStderr += chunk.toString('utf8');
        });
        fallback.on('error', (fallbackError) => {
          console.error(`[readTextFileAsUser] Sudo fallback spawn error:`, fallbackError);
          const err = new Error(stderr || `Failed to read file as uid=${uid} (exit ${code})`);
          err.code = 'READ_AS_USER_FAILED';
          reject(err);
        });
        fallback.on('close', (fallbackCode) => {
          if (fallbackCode === 0) {
            resolve(fallbackStdout);
            return;
          }
          const err = new Error(
            fallbackStderr || stderr || `Failed to read file as user "${username}" via sudo (exit ${fallbackCode})`,
          );
          err.code = 'READ_AS_USER_FAILED';
          reject(err);
        });
        return;
      }
      const err = new Error(stderr || `Failed to read file as uid=${uid} (exit ${code})`);
      err.code = 'READ_AS_USER_FAILED';
      reject(err);
    });
  });
};

const writeTextFileAsUser = async (filePath, content, uid, gid, username) => {
  const script = `
    const fs = require('fs');
    const path = require('path');
    const targetPath = process.env.TARGET_PATH;
    const dir = path.dirname(targetPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      const payload = Buffer.concat(chunks).toString('utf8');
      fs.writeFileSync(targetPath, payload, 'utf8');
      process.exit(0);
    });
  `;

  return await new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: getCurrentUserHomeDir() || process.env.HOME || os.homedir(), TARGET_PATH: filePath };
    const attemptDirect = () =>
      spawn(process.execPath, ['-e', script], {
        uid,
        gid,
        env,
        stdio: ['pipe', 'ignore', 'pipe'],
      });

    const attemptSudo = () =>
      spawn('sudo', ['-n', '-u', username, process.execPath, '-e', script], {
        env,
        stdio: ['pipe', 'ignore', 'pipe'],
      });

    let child;
    try {
      child = attemptDirect();
    } catch (error) {
      if (error && error.code === 'EPERM' && isSafeOsUsername(username)) {
        child = attemptSudo();
      } else {
        reject(error);
        return;
      }
    }

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (error && error.code === 'EPERM' && isSafeOsUsername(username)) {
        const fallback = attemptSudo();
        let fallbackStderr = '';
        fallback.stderr.on('data', (chunk) => {
          fallbackStderr += chunk.toString('utf8');
        });
        fallback.on('error', reject);
        fallback.on('close', (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          const err = new Error(
            fallbackStderr || `Failed to write file as user "${username}" via sudo (exit ${code})`,
          );
          err.code = 'WRITE_AS_USER_FAILED';
          reject(err);
        });
        fallback.stdin.write(content, 'utf8');
        fallback.stdin.end();
        return;
      }
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (isSafeOsUsername(username)) {
        console.log(`[writeTextFileAsUser] Direct write failed (exit ${code}), trying sudo fallback for user "${username}"`);
        const fallback = attemptSudo();
        let fallbackStderr = '';
        fallback.stderr.on('data', (chunk) => {
          fallbackStderr += chunk.toString('utf8');
        });
        fallback.on('error', (fallbackError) => {
          console.error(`[writeTextFileAsUser] Sudo fallback spawn error:`, fallbackError);
          const err = new Error(stderr || `Failed to write file as uid=${uid} (exit ${code})`);
          err.code = 'WRITE_AS_USER_FAILED';
          reject(err);
        });
        fallback.on('close', (fallbackCode) => {
          if (fallbackCode === 0) {
            resolve();
            return;
          }
          const err = new Error(
            fallbackStderr || stderr || `Failed to write file as user "${username}" via sudo (exit ${fallbackCode})`,
          );
          err.code = 'WRITE_AS_USER_FAILED';
          reject(err);
        });
        fallback.stdin.write(content, 'utf8');
        fallback.stdin.end();
        return;
      }
      const err = new Error(stderr || `Failed to write file as uid=${uid} (exit ${code})`);
      err.code = 'WRITE_AS_USER_FAILED';
      reject(err);
    });

    child.stdin.write(content, 'utf8');
    child.stdin.end();
  });
};

// Default visible providers (all providers enabled by default)
const DEFAULT_VISIBLE_PROVIDERS = ['claude', 'cursor', 'codex', 'gemini'];

// ===============================
// API Keys Management
// ===============================

// Get all API keys for the authenticated user
router.get('/api-keys', async (req, res) => {
  try {
    const apiKeys = apiKeysDb.getApiKeys(req.user.id);
    // Don't send the full API key in the list for security
    const sanitizedKeys = apiKeys.map(key => ({
      ...key,
      api_key: key.api_key.substring(0, 10) + '...'
    }));
    res.json({ apiKeys: sanitizedKeys });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// Create a new API key
router.post('/api-keys', async (req, res) => {
  try {
    const { keyName } = req.body;

    if (!keyName || !keyName.trim()) {
      return res.status(400).json({ error: 'Key name is required' });
    }

    const result = apiKeysDb.createApiKey(req.user.id, keyName.trim());
    res.json({
      success: true,
      apiKey: result
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// Delete an API key
router.delete('/api-keys/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params;
    const success = apiKeysDb.deleteApiKey(req.user.id, parseInt(keyId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error deleting API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// Toggle API key active status
router.patch('/api-keys/:keyId/toggle', async (req, res) => {
  try {
    const { keyId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = apiKeysDb.toggleApiKey(req.user.id, parseInt(keyId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error toggling API key:', error);
    res.status(500).json({ error: 'Failed to toggle API key' });
  }
});

// ===============================
// Generic Credentials Management
// ===============================

// Get all credentials for the authenticated user (optionally filtered by type)
router.get('/credentials', async (req, res) => {
  try {
    const { type } = req.query;
    const credentials = credentialsDb.getCredentials(req.user.id, type || null);
    // Don't send the actual credential values for security
    res.json({ credentials });
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// Create a new credential
router.post('/credentials', async (req, res) => {
  try {
    const { credentialName, credentialType, credentialValue, description } = req.body;

    if (!credentialName || !credentialName.trim()) {
      return res.status(400).json({ error: 'Credential name is required' });
    }

    if (!credentialType || !credentialType.trim()) {
      return res.status(400).json({ error: 'Credential type is required' });
    }

    if (!credentialValue || !credentialValue.trim()) {
      return res.status(400).json({ error: 'Credential value is required' });
    }

    const result = credentialsDb.createCredential(
      req.user.id,
      credentialName.trim(),
      credentialType.trim(),
      credentialValue.trim(),
      description?.trim() || null
    );

    res.json({
      success: true,
      credential: result
    });
  } catch (error) {
    console.error('Error creating credential:', error);
    res.status(500).json({ error: 'Failed to create credential' });
  }
});

// Delete a credential
router.delete('/credentials/:credentialId', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const success = credentialsDb.deleteCredential(req.user.id, parseInt(credentialId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error deleting credential:', error);
    res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// Toggle credential active status
router.patch('/credentials/:credentialId/toggle', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = credentialsDb.toggleCredential(req.user.id, parseInt(credentialId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error toggling credential:', error);
    res.status(500).json({ error: 'Failed to toggle credential' });
  }
});

// ===============================
// Notification Preferences
// ===============================

router.get('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.getPreferences(req.user.id);
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error fetching notification preferences:', error);
    res.status(500).json({ error: 'Failed to fetch notification preferences' });
  }
});

router.put('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.updatePreferences(req.user.id, req.body || {});
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error saving notification preferences:', error);
    res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

// ===============================
// Push Subscription Management
// ===============================

router.get('/push/vapid-public-key', async (req, res) => {
  try {
    const publicKey = getPublicKey();
    res.json({ publicKey });
  } catch (error) {
    console.error('Error fetching VAPID public key:', error);
    res.status(500).json({ error: 'Failed to fetch VAPID public key' });
  }
});

router.post('/push/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Missing subscription fields' });
    }
    pushSubscriptionsDb.saveSubscription(req.user.id, endpoint, keys.p256dh, keys.auth);

    // Enable webPush in preferences so the confirmation goes through the full pipeline
    const currentPrefs = notificationPreferencesDb.getPreferences(req.user.id);
    if (!currentPrefs?.channels?.webPush) {
      notificationPreferencesDb.updatePreferences(req.user.id, {
        ...currentPrefs,
        channels: { ...currentPrefs?.channels, webPush: true },
      });
    }

    res.json({ success: true });

    // Send a confirmation push through the full notification pipeline
    const event = createNotificationEvent({
      provider: 'system',
      kind: 'info',
      code: 'push.enabled',
      meta: { message: 'Push notifications are now enabled!' },
      severity: 'info'
    });
    notifyUserIfEnabled({ userId: req.user.id, event });
  } catch (error) {
    console.error('Error saving push subscription:', error);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

router.post('/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }
    pushSubscriptionsDb.removeSubscription(endpoint);

    // Disable webPush in preferences to match subscription state
    const currentPrefs = notificationPreferencesDb.getPreferences(req.user.id);
    if (currentPrefs?.channels?.webPush) {
      notificationPreferencesDb.updatePreferences(req.user.id, {
        ...currentPrefs,
        channels: { ...currentPrefs.channels, webPush: false },
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing push subscription:', error);
    res.status(500).json({ error: 'Failed to remove push subscription' });
  }
});

// Host OS for UI (e.g. hide Cursor agent when the backend runs on Windows).
router.get('/server-env', async (req, res) => {
  try {
    res.json({ platform: process.platform });
  } catch (error) {
    console.error('Error reading server environment:', error);
    res.status(500).json({ error: 'Failed to read server environment' });
  }
});

// ===============================
// Visible Providers Configuration
// ===============================

// Get visible providers configuration
router.get('/visible-providers', authenticateToken, async (req, res) => {
  try {
    const uiConfigValue = appConfigDb.get('ui_config');
    if (uiConfigValue) {
      const uiConfig = JSON.parse(uiConfigValue);
      if (Array.isArray(uiConfig?.allowedProviders) && uiConfig.allowedProviders.length > 0) {
        return res.json({ success: true, visibleProviders: uiConfig.allowedProviders });
      }
    }

    const configValue = appConfigDb.get('visible_providers');
    const visibleProviders = configValue ? JSON.parse(configValue) : DEFAULT_VISIBLE_PROVIDERS;
    res.json({ success: true, visibleProviders });
  } catch (error) {
    console.error('Error fetching visible providers:', error);
    res.status(500).json({ error: 'Failed to fetch visible providers' });
  }
});

// Get authentication mode configuration
router.get('/auth-mode', authenticateToken, async (req, res) => {
  try {
    const configValue = appConfigDb.get('auth_mode');
    const authMode = configValue || 'database';
    res.json({ success: true, authMode });
  } catch (error) {
    console.error('Error fetching auth mode:', error);
    res.status(500).json({ error: 'Failed to fetch auth mode' });
  }
});

// Update authentication mode configuration
router.put('/auth-mode', requireAdmin, async (req, res) => {
  try {
    const { authMode } = req.body;

    if (!authMode || !['database', 'linux'].includes(authMode)) {
      return res.status(400).json({ error: 'authMode must be "database" or "linux"' });
    }

    appConfigDb.set('auth_mode', authMode);
    res.json({ success: true, authMode });
  } catch (error) {
    console.error('Error saving auth mode:', error);
    res.status(500).json({ error: 'Failed to save auth mode' });
  }
});

// Get Linux PAM admin users list
router.get('/linux-admin-users', authenticateToken, async (req, res) => {
  try {
    const adminUsers = appConfigDb.get('linux_admin_users') || '';
    res.json({ success: true, adminUsers: adminUsers.split(',').map(s => s.trim()).filter(Boolean) });
  } catch (error) {
    console.error('Error fetching admin users:', error);
    res.status(500).json({ error: 'Failed to fetch admin users' });
  }
});

// Update Linux PAM admin users list
router.put('/linux-admin-users', requireAdmin, async (req, res) => {
  try {
    const { adminUsers } = req.body;

    if (!Array.isArray(adminUsers)) {
      return res.status(400).json({ error: 'adminUsers must be an array' });
    }

    const adminUsersStr = adminUsers.map(s => s.trim()).filter(Boolean).join(',');
    appConfigDb.set('linux_admin_users', adminUsersStr);
    res.json({ success: true, adminUsers: adminUsers });
  } catch (error) {
    console.error('Error saving admin users:', error);
    res.status(500).json({ error: 'Failed to save admin users' });
  }
});

// Update visible providers configuration
router.put('/visible-providers', requireAdmin, async (req, res) => {
  try {
    const { visibleProviders } = req.body;

    if (!Array.isArray(visibleProviders)) {
      return res.status(400).json({ error: 'visibleProviders must be an array' });
    }

    // Validate that all providers are valid
    const validProviders = ['claude', 'cursor', 'codex', 'gemini'];
    const invalidProviders = visibleProviders.filter(p => !validProviders.includes(p));
    if (invalidProviders.length > 0) {
      return res.status(400).json({ error: `Invalid providers: ${invalidProviders.join(', ')}` });
    }

    // Ensure at least one provider is visible
    if (visibleProviders.length === 0) {
      return res.status(400).json({ error: 'At least one provider must be visible' });
    }

    appConfigDb.set('visible_providers', JSON.stringify(visibleProviders));
    const uiConfigValue = appConfigDb.get('ui_config');
    if (uiConfigValue) {
      const uiConfig = JSON.parse(uiConfigValue);
      uiConfig.allowedProviders = visibleProviders;
      appConfigDb.set('ui_config', JSON.stringify(uiConfig));
    }
    res.json({ success: true, visibleProviders });
  } catch (error) {
    console.error('Error saving visible providers:', error);
    res.status(500).json({ error: 'Failed to save visible providers' });
  }
});

// ===============================
// Agent Configuration (Admin only)
// ===============================

// Get agent configuration
router.get('/agent-config', requireAdmin, async (req, res) => {
  try {
    const config = agentConfigDb.get();
    res.json({ success: true, config });
  } catch (error) {
    console.error('Error fetching agent config:', error);
    res.status(500).json({ error: 'Failed to fetch agent config' });
  }
});

// Update agent configuration
router.put('/agent-config', requireAdmin, async (req, res) => {
  try {
    const {
      anthropicBaseUrl,
      anthropicApiKey,
      openaiBaseUrl,
      openaiApiKey,
      geminiBaseUrl,
      geminiApiKey,
      cursorBaseUrl,
      cursorApiKey,
    } = req.body;

    agentConfigDb.update({
      anthropicBaseUrl: anthropicBaseUrl ?? null,
      anthropicApiKey: anthropicApiKey ?? null,
      openaiBaseUrl: openaiBaseUrl ?? null,
      openaiApiKey: openaiApiKey ?? null,
      geminiBaseUrl: geminiBaseUrl ?? null,
      geminiApiKey: geminiApiKey ?? null,
      cursorBaseUrl: cursorBaseUrl ?? null,
      cursorApiKey: cursorApiKey ?? null,
    }, req.user.id);

    const config = agentConfigDb.get();
    res.json({ success: true, config });
  } catch (error) {
    console.error('Error saving agent config:', error);
    res.status(500).json({ error: 'Failed to save agent config' });
  }
});

// ===============================
// User Agent Configuration (Per-user)
// ===============================

// Get user's agent configuration
router.get('/user-agent-config', async (req, res) => {
  try {
    const config = userAgentConfigDb.get(req.user.id);
    res.json({ success: true, config });
  } catch (error) {
    console.error('Error fetching user agent config:', error);
    res.status(500).json({ error: 'Failed to fetch user agent config' });
  }
});

// Update user's agent configuration
router.put('/user-agent-config', async (req, res) => {
  try {
    const {
      anthropicBaseUrl,
      anthropicApiKey,
      anthropicDefaultModel,
      openaiBaseUrl,
      openaiApiKey,
      openaiDefaultModel,
      geminiBaseUrl,
      geminiApiKey,
      geminiDefaultModel,
      cursorBaseUrl,
      cursorApiKey,
      cursorDefaultModel,
    } = req.body;

    userAgentConfigDb.update(req.user.id, {
      anthropicBaseUrl: anthropicBaseUrl ?? null,
      anthropicApiKey: anthropicApiKey ?? null,
      anthropicDefaultModel: anthropicDefaultModel ?? null,
      openaiBaseUrl: openaiBaseUrl ?? null,
      openaiApiKey: openaiApiKey ?? null,
      openaiDefaultModel: openaiDefaultModel ?? null,
      geminiBaseUrl: geminiBaseUrl ?? null,
      geminiApiKey: geminiApiKey ?? null,
      geminiDefaultModel: geminiDefaultModel ?? null,
      cursorBaseUrl: cursorBaseUrl ?? null,
      cursorApiKey: cursorApiKey ?? null,
      cursorDefaultModel: cursorDefaultModel ?? null,
    });

    const config = userAgentConfigDb.get(req.user.id);
    res.json({ success: true, config });
  } catch (error) {
    console.error('Error saving user agent config:', error);
    res.status(500).json({ error: 'Failed to save user agent config' });
  }
});

// Get user's provider-specific configuration (including decrypted API key for frontend display indicator)
router.get('/user-agent-config/:provider', async (req, res) => {
  try {
    const { provider } = req.params;
    const validProviders = ['anthropic', 'openai', 'gemini', 'cursor'];

    if (!validProviders.includes(provider)) {
      return res.status(400).json({ error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
    }

    const config = userAgentConfigDb.getProviderConfig(req.user.id, provider);
    res.json({
      success: true,
      config: config ? {
        baseUrl: config.baseUrl,
        hasApiKey: !!config.apiKey,
        defaultModel: config.defaultModel,
      } : null
    });
  } catch (error) {
    console.error('Error fetching provider config:', error);
    res.status(500).json({ error: 'Failed to fetch provider config' });
  }
});

// ===============================
// Provider Settings.json Management
// ===============================

// Get provider's settings.json content
router.get('/provider-settings/:provider', async (req, res) => {
  try {
    const { provider } = req.params;
    const validProviders = ['claude', 'cursor', 'codex', 'gemini'];

    if (!validProviders.includes(provider)) {
      return res.status(400).json({ error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
    }

    const settingsPath = getSettingsPath(req, provider);
    const useUserIdentity = isPamMode();
    const hasUserIdentity = isNumericId(req.user?.uid) && isNumericId(req.user?.gid);

    if (useUserIdentity) {
      if (!hasUserIdentity) {
        return res.status(401).json({
          error: 'Missing PAM user identity (uid/gid). Please logout/login to refresh token.',
        });
      }
      try {
        const content = await readTextFileAsUser(settingsPath, req.user.uid, req.user.gid, req.user.username);
        if (content && content.trim().length > 0) {
          return res.json({ success: true, content, path: settingsPath, exists: true });
        }
        return res.json({ success: true, content: '{}', path: settingsPath, exists: false });
      } catch (error) {
        console.error('Error reading provider settings as PAM user:', error);
        throw error;
      }
    }

    // Non-PAM mode: use server process identity
    // Check if file exists
    if (!fs.existsSync(settingsPath)) {
      return res.json({ success: true, content: '{}', path: settingsPath, exists: false });
    }

    let content;
    try {
      content = fs.readFileSync(settingsPath, 'utf8');
    } catch (error) {
      if (error && (error.code === 'EACCES' || error.code === 'EPERM')) {
        if (hasUserIdentity) {
          content = await readTextFileAsUser(settingsPath, req.user.uid, req.user.gid, req.user.username);
        } else {
          const hint = new Error(
            `Permission denied reading provider settings at "${settingsPath}". ` +
              'Your auth token is missing uid/gid; please logout/login to refresh token.',
          );
          hint.code = error.code;
          throw hint;
        }
      }
      throw error;
    }
    res.json({
      success: true,
      content,
      path: settingsPath,
      exists: true
    });
  } catch (error) {
    console.error('Error reading provider settings:', error);
    res.status(500).json({ error: 'Failed to read provider settings' });
  }
});

// Save provider's settings.json content
router.put('/provider-settings/:provider', async (req, res) => {
  try {
    const { provider } = req.params;
    const { content } = req.body;
    const validProviders = ['claude', 'cursor', 'codex', 'gemini'];

    if (!validProviders.includes(provider)) {
      return res.status(400).json({ error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
    }

    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'Content must be a string' });
    }

    // Validate JSON
    try {
      JSON.parse(content);
    } catch (parseError) {
      return res.status(400).json({ error: 'Invalid JSON content' });
    }

    const settingsPath = getSettingsPath(req, provider);
    const settingsDir = path.dirname(settingsPath);
    const useUserIdentity = isPamMode();
    const hasUserIdentity = isNumericId(req.user?.uid) && isNumericId(req.user?.gid);

    console.log('[Settings] Saving provider settings:', { provider, settingsPath, settingsDir });

    if (useUserIdentity) {
      if (!hasUserIdentity) {
        return res.status(401).json({
          error: 'Missing PAM user identity (uid/gid). Please logout/login to refresh token.',
        });
      }

      await writeTextFileAsUser(settingsPath, content, req.user.uid, req.user.gid, req.user.username);
      return res.json({
        success: true,
        path: settingsPath,
        message: 'Settings saved successfully'
      });
    }

    // Non-PAM mode: if we have user identity, always write as that user
    // to ensure correct file ownership (never write as root)
    if (hasUserIdentity) {
      console.log(`[Settings] Non-PAM mode with user identity: writing as uid=${req.user.uid}, gid=${req.user.gid}, username=${req.user.username}`);
      await writeTextFileAsUser(settingsPath, content, req.user.uid, req.user.gid, req.user.username);
      return res.json({
        success: true,
        path: settingsPath,
        message: 'Settings saved successfully'
      });
    }

    // No user identity available: use server process identity
    // Ensure directory exists
    if (!fs.existsSync(settingsDir)) {
      console.log('[Settings] Creating directory:', settingsDir);
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    // Write file
    console.log('[Settings] Writing file:', settingsPath);
    fs.writeFileSync(settingsPath, content, 'utf8');
    console.log('[Settings] File written successfully');

    res.json({
      success: true,
      path: settingsPath,
      message: 'Settings saved successfully'
    });
  } catch (error) {
    console.error('[Settings] Error saving provider settings:', error);
    const privilegeHint =
      error && (error.code === 'WRITE_AS_USER_FAILED' || error.code === 'READ_AS_USER_FAILED' || error.code === 'EPERM')
        ? ' (server 需要具备切换 uid/gid 的权限，例如以 root 运行，或具备等效权限)'
        : '';
    res.status(500).json({ error: 'Failed to save provider settings: ' + error.message + privilegeHint });
  }
});

// ===============================
// Models Configuration from settings.json
// ===============================
// Public endpoint - no authentication required for model mapping
// ===============================

// Get available models from provider settings.json files
router.get('/models', async (req, res) => {
  try {
    const models = {
      claude: [],
      cursor: [],
      codex: [],
      gemini: []
    };

    // Read Claude settings
    const claudeSettingsPath = getProviderSettingsPaths(getUserHomeDir(req)).claude();
    if (fs.existsSync(claudeSettingsPath)) {
      try {
        const content = fs.readFileSync(claudeSettingsPath, 'utf8');
        const settings = JSON.parse(content);
        const env = settings.env || {};

        // Build model list with mapped actual models from settings.json
        // Label format: "Opus Model (glm-5)" if mapped, otherwise just "Opus Model"
        const opusActual = env.ANTHROPIC_DEFAULT_OPUS_MODEL;
        const sonnetActual = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
        const haikuActual = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;

        models.claude = [
          { value: 'default', label: opusActual ? `Default (${opusActual})` : 'Default', envKey: 'ANTHROPIC_MODEL', actualModel: opusActual },
          { value: 'opus', label: opusActual ? `Opus Model (${opusActual})` : 'Opus Model', envKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL', actualModel: opusActual },
          { value: 'sonnet', label: sonnetActual ? `Sonnet Model (${sonnetActual})` : 'Sonnet Model', envKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL', actualModel: sonnetActual },
          { value: 'haiku', label: haikuActual ? `Haiku Model (${haikuActual})` : 'Haiku Model', envKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', actualModel: haikuActual },
          { value: 'opus[1m]', label: 'Opus [1M]', envKey: null, actualModel: null },
          { value: 'sonnet[1m]', label: 'Sonnet [1M]', envKey: null, actualModel: null },
          { value: 'claude-opus-4-6', label: 'Opus 4.6', envKey: null, actualModel: null },
          { value: 'opusplan', label: 'Opus Plan', envKey: null, actualModel: null },
        ];

        // If ANTHROPIC_MODEL is set, it's the default model value
        if (env.ANTHROPIC_MODEL) {
          models.claude.defaultModel = env.ANTHROPIC_MODEL;
          models.claude.defaultActualModel = env.ANTHROPIC_MODEL;
        }
      } catch (e) {
        console.error('Error parsing Claude settings:', e);
      }
    }

    // Read Codex/OpenAI settings
    const codexSettingsPath = getProviderSettingsPaths(getUserHomeDir(req)).codex();
    if (fs.existsSync(codexSettingsPath)) {
      try {
        const content = fs.readFileSync(codexSettingsPath, 'utf8');
        const settings = JSON.parse(content);
        const env = settings.env || {};

        models.codex = [
          { value: 'gpt-5.5', label: 'GPT-5.5', envKey: null, actualModel: null },
          { value: 'gpt-5.4', label: 'GPT-5.4', envKey: null, actualModel: null },
          { value: 'o3', label: 'O3', envKey: null, actualModel: null },
          { value: 'o4-mini', label: 'O4-mini', envKey: null, actualModel: null },
        ];

        if (env.OPENAI_MODEL) {
          models.codex.defaultModel = env.OPENAI_MODEL;
        }
      } catch (e) {
        console.error('Error parsing Codex settings:', e);
      }
    }

    // Read Gemini settings
    const geminiSettingsPath = getProviderSettingsPaths(getUserHomeDir(req)).gemini();
    if (fs.existsSync(geminiSettingsPath)) {
      try {
        const content = fs.readFileSync(geminiSettingsPath, 'utf8');
        const settings = JSON.parse(content);
        const env = settings.env || {};

        models.gemini = [
          { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', envKey: null, actualModel: null },
          { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', envKey: null, actualModel: null },
          { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', envKey: null, actualModel: null },
        ];

        if (env.GEMINI_MODEL) {
          models.gemini.defaultModel = env.GEMINI_MODEL;
        }
      } catch (e) {
        console.error('Error parsing Gemini settings:', e);
      }
    }

    // Read Cursor settings
    const cursorSettingsPath = getProviderSettingsPaths(getUserHomeDir(req)).cursor();
    if (fs.existsSync(cursorSettingsPath)) {
      try {
        const content = fs.readFileSync(cursorSettingsPath, 'utf8');
        const settings = JSON.parse(content);
        const env = settings.env || {};

        models.cursor = [
          { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', envKey: null, actualModel: null },
          { value: 'claude-opus-4-20250514', label: 'Claude Opus 4', envKey: null, actualModel: null },
          { value: 'gpt-4.5-turbo', label: 'GPT-4.5 Turbo', envKey: null, actualModel: null },
          { value: 'gpt-5', label: 'GPT-5', envKey: null, actualModel: null },
        ];

        if (env.CURSOR_MODEL) {
          models.cursor.defaultModel = env.CURSOR_MODEL;
        }
      } catch (e) {
        console.error('Error parsing Cursor settings:', e);
      }
    }

    res.json({ success: true, models });
  } catch (error) {
    console.error('Error fetching models:', error);
    res.status(500).json({ error: 'Failed to fetch models' });
  }
});

// ===============================
// UI Configuration (Admin only)
// ===============================

const DEFAULT_UI_CONFIG = {
  appName: 'CloudCLI',
  logoUrl: null,
  showReportIssue: true,
  showJoinCommunity: true,
  showGitHubStar: true,
  showVersion: true,
  showSettingsAgents: true,
  showSettingsAppearance: true,
  showSettingsGit: true,
  showSettingsApi: true,
  showSettingsTasks: true,
  showSettingsPlugins: true,
  showSettingsNotifications: true,
  showSettingsAbout: true,
  allowedProviders: ['claude', 'cursor', 'codex', 'gemini'],
};

// Get UI configuration
router.get('/ui-config', async (req, res) => {
  try {
    const configValue = appConfigDb.get('ui_config');
    const uiConfig = configValue ? { ...DEFAULT_UI_CONFIG, ...JSON.parse(configValue) } : DEFAULT_UI_CONFIG;
    res.json({ success: true, config: uiConfig });
  } catch (error) {
    console.error('Error fetching UI config:', error);
    res.status(500).json({ error: 'Failed to fetch UI config' });
  }
});

// Update UI configuration (Admin only)
router.put('/ui-config', requireAdmin, async (req, res) => {
  try {
    const {
      appName,
      logoUrl,
      showReportIssue,
      showJoinCommunity,
      showGitHubStar,
      showVersion,
      showSettingsAgents,
      showSettingsAppearance,
      showSettingsGit,
      showSettingsApi,
      showSettingsTasks,
      showSettingsPlugins,
      showSettingsNotifications,
      showSettingsAbout,
      allowedProviders,
    } = req.body;

    const currentConfigValue = appConfigDb.get('ui_config');
    const currentConfig = currentConfigValue ? JSON.parse(currentConfigValue) : DEFAULT_UI_CONFIG;

    // Validate allowedProviders if provided
    let validatedProviders = currentConfig.allowedProviders;
    if (Array.isArray(allowedProviders)) {
      const validProviders = ['claude', 'cursor', 'codex', 'gemini'];
      validatedProviders = allowedProviders.filter(p => validProviders.includes(p));
      // Ensure at least one provider is allowed
      if (validatedProviders.length === 0) {
        validatedProviders = ['claude'];
      }
    }

    const newConfig = {
      appName: typeof appName === 'string' ? appName : currentConfig.appName,
      logoUrl: logoUrl !== undefined ? logoUrl : currentConfig.logoUrl,
      showReportIssue: typeof showReportIssue === 'boolean' ? showReportIssue : currentConfig.showReportIssue,
      showJoinCommunity: typeof showJoinCommunity === 'boolean' ? showJoinCommunity : currentConfig.showJoinCommunity,
      showGitHubStar: typeof showGitHubStar === 'boolean' ? showGitHubStar : currentConfig.showGitHubStar,
      showVersion: typeof showVersion === 'boolean' ? showVersion : currentConfig.showVersion,
      showSettingsAgents: typeof showSettingsAgents === 'boolean' ? showSettingsAgents : currentConfig.showSettingsAgents,
      showSettingsAppearance: typeof showSettingsAppearance === 'boolean' ? showSettingsAppearance : currentConfig.showSettingsAppearance,
      showSettingsGit: typeof showSettingsGit === 'boolean' ? showSettingsGit : currentConfig.showSettingsGit,
      showSettingsApi: typeof showSettingsApi === 'boolean' ? showSettingsApi : currentConfig.showSettingsApi,
      showSettingsTasks: typeof showSettingsTasks === 'boolean' ? showSettingsTasks : currentConfig.showSettingsTasks,
      showSettingsPlugins: typeof showSettingsPlugins === 'boolean' ? showSettingsPlugins : currentConfig.showSettingsPlugins,
      showSettingsNotifications: typeof showSettingsNotifications === 'boolean' ? showSettingsNotifications : currentConfig.showSettingsNotifications,
      showSettingsAbout: typeof showSettingsAbout === 'boolean' ? showSettingsAbout : currentConfig.showSettingsAbout,
      allowedProviders: validatedProviders,
    };

    appConfigDb.set('ui_config', JSON.stringify(newConfig));
    res.json({ success: true, config: newConfig });
  } catch (error) {
    console.error('Error saving UI config:', error);
    res.status(500).json({ error: 'Failed to save UI config' });
  }
});

// Upload logo image (Admin only)
router.post('/upload-logo', requireAdmin, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileName = req.file.filename;
    const logoUrl = `/api/settings/logo/${fileName}`;

    // Update UI config with new logo URL
    const currentConfigValue = appConfigDb.get('ui_config');
    const currentConfig = currentConfigValue ? JSON.parse(currentConfigValue) : DEFAULT_UI_CONFIG;
    currentConfig.logoUrl = logoUrl;
    appConfigDb.set('ui_config', JSON.stringify(currentConfig));

    res.json({ success: true, logoUrl });
  } catch (error) {
    console.error('Error uploading logo:', error);
    res.status(500).json({ error: 'Failed to upload logo' });
  }
});

export default router;
