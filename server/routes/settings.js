import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import multer from 'multer';
import { apiKeysDb, credentialsDb, notificationPreferencesDb, pushSubscriptionsDb, appConfigDb, agentConfigDb, userAgentConfigDb } from '../modules/database/index.js';
import { getPublicKey } from '../services/vapid-keys.js';
import { createNotificationEvent, notifyUserIfEnabled } from '../services/notification-orchestrator.js';
import { requireAdmin } from '../middleware/admin.js';

const router = express.Router();

// Configure multer for logo uploads
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

// Provider settings file paths
const PROVIDER_SETTINGS_PATHS = {
  claude: () => path.join(os.homedir(), '.claude', 'settings.json'),
  cursor: () => path.join(os.homedir(), '.cursor', 'settings.json'),
  codex: () => path.join(os.homedir(), '.codex', 'settings.json'),
  gemini: () => path.join(os.homedir(), '.gemini', 'settings.json'),
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
router.get('/visible-providers', async (req, res) => {
  try {
    const configValue = appConfigDb.get('visible_providers');
    const visibleProviders = configValue ? JSON.parse(configValue) : DEFAULT_VISIBLE_PROVIDERS;
    res.json({ success: true, visibleProviders });
  } catch (error) {
    console.error('Error fetching visible providers:', error);
    res.status(500).json({ error: 'Failed to fetch visible providers' });
  }
});

// Update visible providers configuration
router.put('/visible-providers', async (req, res) => {
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

    const settingsPath = PROVIDER_SETTINGS_PATHS[provider]();

    // Check if file exists
    if (!fs.existsSync(settingsPath)) {
      // Return empty object if file doesn't exist
      return res.json({
        success: true,
        content: '{}',
        path: settingsPath,
        exists: false
      });
    }

    const content = fs.readFileSync(settingsPath, 'utf8');
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

    const settingsPath = PROVIDER_SETTINGS_PATHS[provider]();
    const settingsDir = path.dirname(settingsPath);

    // Ensure directory exists
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    // Write file
    fs.writeFileSync(settingsPath, content, 'utf8');

    res.json({
      success: true,
      path: settingsPath,
      message: 'Settings saved successfully'
    });
  } catch (error) {
    console.error('Error saving provider settings:', error);
    res.status(500).json({ error: 'Failed to save provider settings' });
  }
});

// ===============================
// Models Configuration from settings.json
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
    const claudeSettingsPath = PROVIDER_SETTINGS_PATHS.claude();
    if (fs.existsSync(claudeSettingsPath)) {
      try {
        const content = fs.readFileSync(claudeSettingsPath, 'utf8');
        const settings = JSON.parse(content);
        const env = settings.env || {};

        // Extract model configuration from env
        models.claude = [
          { value: 'opus', label: 'Opus', envKey: 'ANTHROPIC_DEFAULT_OPUS_MODEL', actualModel: env.ANTHROPIC_DEFAULT_OPUS_MODEL },
          { value: 'sonnet', label: 'Sonnet', envKey: 'ANTHROPIC_DEFAULT_SONNET_MODEL', actualModel: env.ANTHROPIC_DEFAULT_SONNET_MODEL },
          { value: 'haiku', label: 'Haiku', envKey: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', actualModel: env.ANTHROPIC_DEFAULT_HAIKU_MODEL },
          { value: 'opus[1m]', label: 'Opus [1M]', envKey: null, actualModel: null },
          { value: 'sonnet[1m]', label: 'Sonnet [1M]', envKey: null, actualModel: null },
        ];

        // If ANTHROPIC_MODEL is set, it's the default model
        if (env.ANTHROPIC_MODEL) {
          models.claude.defaultModel = env.ANTHROPIC_MODEL;
        }
      } catch (e) {
        console.error('Error parsing Claude settings:', e);
      }
    }

    // Read Codex/OpenAI settings
    const codexSettingsPath = PROVIDER_SETTINGS_PATHS.codex();
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
    const geminiSettingsPath = PROVIDER_SETTINGS_PATHS.gemini();
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
    const cursorSettingsPath = PROVIDER_SETTINGS_PATHS.cursor();
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
    } = req.body;

    const currentConfigValue = appConfigDb.get('ui_config');
    const currentConfig = currentConfigValue ? JSON.parse(currentConfigValue) : DEFAULT_UI_CONFIG;

    const newConfig = {
      appName: typeof appName === 'string' ? appName : currentConfig.appName,
      logoUrl: typeof logoUrl === 'string' ? logoUrl : currentConfig.logoUrl,
      showReportIssue: typeof showReportIssue === 'boolean' ? showReportIssue : currentConfig.showReportIssue,
      showJoinCommunity: typeof showJoinCommunity === 'boolean' ? showJoinCommunity : currentConfig.showJoinCommunity,
      showGitHubStar: typeof showGitHubStar === 'boolean' ? showGitHubStar : currentConfig.showGitHubStar,
      showVersion: typeof showVersion === 'boolean' ? showVersion : currentConfig.showVersion,
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

// Serve logo image
router.get('/logo/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(logosDir, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Logo not found' });
    }

    res.sendFile(filePath);
  } catch (error) {
    console.error('Error serving logo:', error);
    res.status(500).json({ error: 'Failed to serve logo' });
  }
});

export default router;
