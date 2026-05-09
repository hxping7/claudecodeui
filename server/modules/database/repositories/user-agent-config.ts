/**
 * User agent config repository - stores per-user API configurations for AI agents
 * Each user can configure their own base URLs, API keys, and default models
 */

import crypto from 'crypto';
import { getConnection } from '@/modules/database/connection.js';
import { appConfigDb } from './app-config.js';

type UserAgentConfigRow = {
  id: number;
  user_id: number;
  anthropic_base_url: string | null;
  anthropic_api_key_encrypted: string | null;
  anthropic_default_model: string | null;
  openai_base_url: string | null;
  openai_api_key_encrypted: string | null;
  openai_default_model: string | null;
  gemini_base_url: string | null;
  gemini_api_key_encrypted: string | null;
  gemini_default_model: string | null;
  cursor_base_url: string | null;
  cursor_api_key_encrypted: string | null;
  cursor_default_model: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type UserAgentConfig = {
  anthropicBaseUrl: string | null;
  anthropicDefaultModel: string | null;
  openaiBaseUrl: string | null;
  openaiDefaultModel: string | null;
  geminiBaseUrl: string | null;
  geminiDefaultModel: string | null;
  cursorBaseUrl: string | null;
  cursorDefaultModel: string | null;
  updatedAt: string | null;
};

// Encryption key derived from JWT_SECRET
const getEncryptionKey = (): Buffer => {
  const secret = appConfigDb.get('jwt_secret') || 'default-secret-change-me';
  return crypto.scryptSync(secret, 'salt', 32);
};

const encrypt = (text: string): string => {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
};

const decrypt = (encryptedText: string): string | null => {
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
};

const PROVIDER_COLUMNS = {
  anthropic: {
    baseUrl: 'anthropic_base_url',
    apiKey: 'anthropic_api_key_encrypted',
    defaultModel: 'anthropic_default_model',
  },
  openai: {
    baseUrl: 'openai_base_url',
    apiKey: 'openai_api_key_encrypted',
    defaultModel: 'openai_default_model',
  },
  gemini: {
    baseUrl: 'gemini_base_url',
    apiKey: 'gemini_api_key_encrypted',
    defaultModel: 'gemini_default_model',
  },
  cursor: {
    baseUrl: 'cursor_base_url',
    apiKey: 'cursor_api_key_encrypted',
    defaultModel: 'cursor_default_model',
  },
} as const;

type Provider = keyof typeof PROVIDER_COLUMNS;

export const userAgentConfigDb = {
  /** Get user's agent configuration (without decrypted API keys) */
  get(userId: number): UserAgentConfig | null {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM user_agent_config WHERE user_id = ?').get(userId) as UserAgentConfigRow | undefined;

    if (!row) return null;

    return {
      anthropicBaseUrl: row.anthropic_base_url,
      anthropicDefaultModel: row.anthropic_default_model,
      openaiBaseUrl: row.openai_base_url,
      openaiDefaultModel: row.openai_default_model,
      geminiBaseUrl: row.gemini_base_url,
      geminiDefaultModel: row.gemini_default_model,
      cursorBaseUrl: row.cursor_base_url,
      cursorDefaultModel: row.cursor_default_model,
      updatedAt: row.updated_at,
    };
  },

  /** Get decrypted API key for a specific provider */
  getDecryptedApiKey(userId: number, provider: Provider): string | null {
    const db = getConnection();
    const columns = PROVIDER_COLUMNS[provider];
    const row = db.prepare(`SELECT ${columns.apiKey} FROM user_agent_config WHERE user_id = ?`).get(userId) as Record<string, string | null> | undefined;
    const encryptedKey = row?.[columns.apiKey];
    if (!encryptedKey) return null;

    return decrypt(encryptedKey);
  },

  /** Get all config for a provider (including decrypted API key) */
  getProviderConfig(userId: number, provider: Provider): { baseUrl: string | null; apiKey: string | null; defaultModel: string | null } | null {
    const db = getConnection();
    const columns = PROVIDER_COLUMNS[provider];
    const row = db.prepare(`
      SELECT ${columns.baseUrl} as baseUrl, ${columns.apiKey} as apiKey, ${columns.defaultModel} as defaultModel
      FROM user_agent_config WHERE user_id = ?
    `).get(userId) as { baseUrl: string | null; apiKey: string | null; defaultModel: string | null } | undefined;

    if (!row) return null;

    return {
      baseUrl: row.baseUrl,
      apiKey: row.apiKey ? decrypt(row.apiKey) : null,
      defaultModel: row.defaultModel,
    };
  },

  /** Update user's agent configuration */
  update(userId: number, config: {
    anthropicBaseUrl?: string | null;
    anthropicApiKey?: string | null;
    anthropicDefaultModel?: string | null;
    openaiBaseUrl?: string | null;
    openaiApiKey?: string | null;
    openaiDefaultModel?: string | null;
    geminiBaseUrl?: string | null;
    geminiApiKey?: string | null;
    geminiDefaultModel?: string | null;
    cursorBaseUrl?: string | null;
    cursorApiKey?: string | null;
    cursorDefaultModel?: string | null;
  }): void {
    const db = getConnection();
    const updates: string[] = [];
    const values: any[] = [];

    // Build dynamic updates
    if (config.anthropicBaseUrl !== undefined) {
      updates.push('anthropic_base_url = ?');
      values.push(config.anthropicBaseUrl);
    }
    if (config.anthropicApiKey !== undefined) {
      updates.push('anthropic_api_key_encrypted = ?');
      values.push(config.anthropicApiKey ? encrypt(config.anthropicApiKey) : null);
    }
    if (config.anthropicDefaultModel !== undefined) {
      updates.push('anthropic_default_model = ?');
      values.push(config.anthropicDefaultModel);
    }
    if (config.openaiBaseUrl !== undefined) {
      updates.push('openai_base_url = ?');
      values.push(config.openaiBaseUrl);
    }
    if (config.openaiApiKey !== undefined) {
      updates.push('openai_api_key_encrypted = ?');
      values.push(config.openaiApiKey ? encrypt(config.openaiApiKey) : null);
    }
    if (config.openaiDefaultModel !== undefined) {
      updates.push('openai_default_model = ?');
      values.push(config.openaiDefaultModel);
    }
    if (config.geminiBaseUrl !== undefined) {
      updates.push('gemini_base_url = ?');
      values.push(config.geminiBaseUrl);
    }
    if (config.geminiApiKey !== undefined) {
      updates.push('gemini_api_key_encrypted = ?');
      values.push(config.geminiApiKey ? encrypt(config.geminiApiKey) : null);
    }
    if (config.geminiDefaultModel !== undefined) {
      updates.push('gemini_default_model = ?');
      values.push(config.geminiDefaultModel);
    }
    if (config.cursorBaseUrl !== undefined) {
      updates.push('cursor_base_url = ?');
      values.push(config.cursorBaseUrl);
    }
    if (config.cursorApiKey !== undefined) {
      updates.push('cursor_api_key_encrypted = ?');
      values.push(config.cursorApiKey ? encrypt(config.cursorApiKey) : null);
    }
    if (config.cursorDefaultModel !== undefined) {
      updates.push('cursor_default_model = ?');
      values.push(config.cursorDefaultModel);
    }

    if (updates.length === 0) return;

    updates.push('updated_at = CURRENT_TIMESTAMP');

    // Use INSERT OR REPLACE pattern
    db.prepare(`
      INSERT INTO user_agent_config (user_id, ${updates.map(u => u.split(' = ')[0]).join(', ')})
      VALUES (?, ${updates.slice(0, -1).map(() => '?').join(', ')})
      ON CONFLICT(user_id) DO UPDATE SET ${updates.join(', ')}
    `).run(userId, ...values);
  },

  /** Delete user's agent configuration */
  delete(userId: number): boolean {
    const db = getConnection();
    const result = db.prepare('DELETE FROM user_agent_config WHERE user_id = ?').run(userId);
    return result.changes > 0;
  },

  /** Get environment variables to inject for AI agents (merges user config with admin config) */
  getEnvForAgent(userId: number, provider: Provider): Record<string, string> {
    const userConfig = this.getProviderConfig(userId, provider);
    const env: Record<string, string> = {};

    if (userConfig?.baseUrl) {
      switch (provider) {
        case 'anthropic':
          env.ANTHROPIC_BASE_URL = userConfig.baseUrl;
          break;
        case 'openai':
          env.OPENAI_BASE_URL = userConfig.baseUrl;
          break;
        case 'gemini':
          env.GEMINI_BASE_URL = userConfig.baseUrl;
          break;
        case 'cursor':
          env.CURSOR_BASE_URL = userConfig.baseUrl;
          break;
      }
    }

    if (userConfig?.apiKey) {
      switch (provider) {
        case 'anthropic':
          env.ANTHROPIC_API_KEY = userConfig.apiKey;
          break;
        case 'openai':
          env.OPENAI_API_KEY = userConfig.apiKey;
          break;
        case 'gemini':
          env.GEMINI_API_KEY = userConfig.apiKey;
          break;
        case 'cursor':
          env.CURSOR_API_KEY = userConfig.apiKey;
          break;
      }
    }

    return env;
  },

  /** Get default model for a provider */
  getDefaultModel(userId: number, provider: Provider): string | null {
    const db = getConnection();
    const columns = PROVIDER_COLUMNS[provider];
    const row = db.prepare(`SELECT ${columns.defaultModel} as defaultModel FROM user_agent_config WHERE user_id = ?`).get(userId) as { defaultModel: string | null } | undefined;
    return row?.defaultModel ?? null;
  },
};
