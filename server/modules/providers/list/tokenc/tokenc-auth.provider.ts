import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type TokencCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class TokencProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      spawn.sync('tokenc', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async getStatus(homeDir?: string, _uid?: number, _gid?: number): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'tokenc',
        authenticated: false,
        email: null,
        method: null,
        error: 'Tokenc CLI is not installed',
      };
    }

    const credentials = await this.checkCredentials(homeDir);

    return {
      installed,
      provider: 'tokenc',
      authenticated: credentials.authenticated,
      email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  private async loadSettingsEnv(homeDir?: string): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(homeDir || os.homedir(), '.tokencode', 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  private async checkCredentials(homeDir?: string): Promise<TokencCredentialsStatus> {
    if (process.env.TOKENC_API_KEY?.trim()) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { authenticated: true, email: 'API Key Auth (Anthropic)', method: 'api_key' };
    }

    const settingsEnv = await this.loadSettingsEnv(homeDir);
    if (readOptionalString(settingsEnv.TOKENC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth (Anthropic)', method: 'api_key' };
    }

    try {
      const credPath = path.join(homeDir || os.homedir(), '.tokencode', '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      const creds = readObjectRecord(JSON.parse(content)) ?? {};
      const oauth = readObjectRecord(creds.oauth);
      const accessToken = readOptionalString(oauth?.accessToken);

      if (accessToken) {
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const email = readOptionalString(creds.email) ?? readOptionalString(creds.user) ?? null;
        if (!expiresAt || Date.now() < expiresAt) {
          return {
            authenticated: true,
            email,
            method: 'credentials_file',
          };
        }

        return {
          authenticated: false,
          email,
          method: 'credentials_file',
          error: 'OAuth token has expired. Please re-authenticate',
        };
      }

      return { authenticated: false, email: null, method: null };
    } catch {
      return { authenticated: false, email: null, method: null };
    }
  }
}
