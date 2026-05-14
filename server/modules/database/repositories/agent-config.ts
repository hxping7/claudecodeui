/**
 * Agent config repository - stores admin-managed API configurations for AI agents
 */

import crypto from 'crypto';
import { getConnection } from '@/modules/database/connection.js';
import { appConfigDb } from './app-config.js';

type AgentConfigRow = {
  id: number;
  anthropic_base_url: string | null;
  anthropic_api_key_encrypted: string | null;
  openai_base_url: string | null;
  openai_api_key_encrypted: string | null;
  gemini_base_url: string | null;
  gemini_api_key_encrypted: string | null;
  cursor_base_url: string | null;
  cursor_api_key_encrypted: string | null;
  tokenc_base_url: string | null;
  tokenc_api_key_encrypted: string | null;
  updated_at: string | null;
  updated_by: number | null;
};

export type AgentConfig = {
  anthropicBaseUrl: string | null;
  openaiBaseUrl: string | null;
  geminiBaseUrl: string | null;
  cursorBaseUrl: string | null;
  tokencBaseUrl: string | null;
  updatedAt: string | null;
  updatedBy: number | null;
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

export const agentConfigDb = {
  /** Get agent configuration (without decrypted API keys) */
  get(): AgentConfig | null {
    const db = getConnection();
    const row = db.prepare('SELECT * FROM agent_config WHERE id = 1').get() as AgentConfigRow | undefined;

    if (!row) return null;

    return {
      anthropicBaseUrl: row.anthropic_base_url,
      openaiBaseUrl: row.openai_base_url,
      geminiBaseUrl: row.gemini_base_url,
      cursorBaseUrl: row.cursor_base_url,
      tokencBaseUrl: row.tokenc_base_url,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  },

  /** Get decrypted API key for a specific provider */
  getDecryptedApiKey(provider: 'anthropic' | 'openai' | 'gemini' | 'cursor'): string | null {
    const db = getConnection();
    const columnMap: Record<string, string> = {
      anthropic: 'anthropic_api_key_encrypted',
      openai: 'openai_api_key_encrypted',
      gemini: 'gemini_api_key_encrypted',
      cursor: 'cursor_api_key_encrypted',
    };

    const column = columnMap[provider];
    if (!column) return null;

    const row = db.prepare(`SELECT ${column} FROM agent_config WHERE id = 1`).get() as Record<string, string | null> | undefined;
    const encryptedKey = row?.[column];
    if (!encryptedKey) return null;

    return decrypt(encryptedKey);
  },

  /** Update agent configuration */
  update(config: {
    anthropicBaseUrl?: string | null;
    anthropicApiKey?: string | null;
    openaiBaseUrl?: string | null;
    openaiApiKey?: string | null;
    geminiBaseUrl?: string | null;
    geminiApiKey?: string | null;
    cursorBaseUrl?: string | null;
    cursorApiKey?: string | null;
    tokencBaseUrl?: string | null;
    tokencApiKey?: string | null;
  }, userId: number): void {
    const db = getConnection();
    const updates: string[] = [];
    const values: any[] = [];

    if (config.anthropicBaseUrl !== undefined) {
      updates.push('anthropic_base_url = ?');
      values.push(config.anthropicBaseUrl);
    }
    if (config.anthropicApiKey !== undefined) {
      updates.push('anthropic_api_key_encrypted = ?');
      values.push(config.anthropicApiKey ? encrypt(config.anthropicApiKey) : null);
    }
    if (config.openaiBaseUrl !== undefined) {
      updates.push('openai_base_url = ?');
      values.push(config.openaiBaseUrl);
    }
    if (config.openaiApiKey !== undefined) {
      updates.push('openai_api_key_encrypted = ?');
      values.push(config.openaiApiKey ? encrypt(config.openaiApiKey) : null);
    }
    if (config.geminiBaseUrl !== undefined) {
      updates.push('gemini_base_url = ?');
      values.push(config.geminiBaseUrl);
    }
    if (config.geminiApiKey !== undefined) {
      updates.push('gemini_api_key_encrypted = ?');
      values.push(config.geminiApiKey ? encrypt(config.geminiApiKey) : null);
    }
    if (config.cursorBaseUrl !== undefined) {
      updates.push('cursor_base_url = ?');
      values.push(config.cursorBaseUrl);
    }
    if (config.cursorApiKey !== undefined) {
      updates.push('cursor_api_key_encrypted = ?');
      values.push(config.cursorApiKey ? encrypt(config.cursorApiKey) : null);
    }
    if (config.tokencBaseUrl !== undefined) {
      updates.push('tokenc_base_url = ?');
      values.push(config.tokencBaseUrl);
    }
    if (config.tokencApiKey !== undefined) {
      updates.push('tokenc_api_key_encrypted = ?');
      values.push(config.tokencApiKey ? encrypt(config.tokencApiKey) : null);
    }

    if (updates.length === 0) return;

    updates.push('updated_at = CURRENT_TIMESTAMP');
    updates.push('updated_by = ?');
    values.push(userId);

    // Use INSERT OR REPLACE to handle both insert and update
    db.prepare(`
      INSERT INTO agent_config (id, ${updates.slice(0, -2).map(u => u.split(' = ')[0]).join(', ')})
      VALUES (1, ${updates.slice(0, -2).map(() => '?').join(', ')})
      ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}
    `).run(...values.slice(0, -2), ...values);
  },

  /** Check if any API keys are configured */
  hasApiKeys(): boolean {
    const db = getConnection();
    const row = db.prepare(`
      SELECT anthropic_api_key_encrypted, openai_api_key_encrypted,
             gemini_api_key_encrypted, cursor_api_key_encrypted
      FROM agent_config WHERE id = 1
    `).get() as Record<string, string | null> | undefined;

    if (!row) return false;
    return Object.values(row).some(v => v !== null);
  },

  /** Get environment variables to inject for AI agents */
  getEnvForAgent(provider: 'anthropic' | 'openai' | 'gemini' | 'cursor' | 'tokenc'): Record<string, string> {
    const config = agentConfigDb.get();
    if (!config) return {};

    const env: Record<string, string> = {};

    switch (provider) {
      case 'anthropic':
        if (config.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = config.anthropicBaseUrl;
        break;
      case 'openai':
        if (config.openaiBaseUrl) env.OPENAI_BASE_URL = config.openaiBaseUrl;
        break;
      case 'gemini':
        if (config.geminiBaseUrl) env.GEMINI_BASE_URL = config.geminiBaseUrl;
        break;
      case 'cursor':
        if (config.cursorBaseUrl) env.CURSOR_BASE_URL = config.cursorBaseUrl;
        break;
      case 'tokenc':
        if (config.tokencBaseUrl) env.TOKENC_BASE_URL = config.tokencBaseUrl;
        break;
    }

    return env;
  },
};