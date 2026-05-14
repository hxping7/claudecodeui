import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfig,
} from '@/shared/utils.js';

export class TokencMcpProvider extends McpProvider {
  constructor() {
    super('tokenc', ['user', 'local', 'project'], ['stdio', 'http', 'sse']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string, homeDir: string): Promise<Record<string, unknown>> {
    if (scope === 'project') {
      const filePath = path.join(workspacePath, '.mcp.json');
      const config = await readJsonConfig(filePath);
      return readObjectRecord(config.mcpServers) ?? {};
    }

    const filePath = path.join(homeDir, '.tokencode.json');
    const config = await readJsonConfig(filePath);
    if (scope === 'user') {
      return readObjectRecord(config.mcpServers) ?? {};
    }

    const projects = readObjectRecord(config.projects) ?? {};
    const projectConfig = readObjectRecord(projects[workspacePath]) ?? {};
    return readObjectRecord(projectConfig.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
    homeDir: string,
    uid?: number,
    gid?: number,
  ): Promise<void> {
    if (scope === 'project') {
      const filePath = path.join(workspacePath, '.mcp.json');
      const config = await readJsonConfig(filePath);
      config.mcpServers = servers;
      await writeJsonConfig(filePath, config, uid, gid);
      return;
    }

    const filePath = path.join(homeDir, '.tokencode.json');
    const config = await readJsonConfig(filePath);
    if (scope === 'user') {
      config.mcpServers = servers;
    } else {
      const configRecord = config as Record<string, unknown>;
      if (!configRecord.projects) {
        configRecord.projects = {};
      }
      const projects = configRecord.projects as Record<string, unknown>;
      if (!projects[workspacePath]) {
        projects[workspacePath] = {};
      }
      (projects[workspacePath] as Record<string, unknown>).mcpServers = servers;
    }

    await writeJsonConfig(filePath, config, uid, gid);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
        env_vars: input.envVars ?? [],
        cwd: input.cwd,
      };
    }

    if (input.transport === 'sse') {
      if (!input.url?.trim()) {
        throw new AppError('url is required for SSE MCP servers.', {
          code: 'MCP_URL_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        url: input.url,
        headers: input.headers ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      url: input.url,
      bearer_token_env_var: input.bearerTokenEnvVar,
      http_headers: input.headers ?? {},
      env_http_headers: input.envHttpHeaders ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    if (!rawConfig || typeof rawConfig !== 'object') {
      return null;
    }

    const config = rawConfig as Record<string, unknown>;
    if (typeof config.command === 'string') {
      return {
        provider: 'tokenc',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
        cwd: readOptionalString(config.cwd),
        envVars: readStringArray(config.env_vars),
      };
    }

    if (typeof config.url === 'string') {
      return {
        provider: 'tokenc',
        name,
        scope,
        transport: readOptionalString(config.headers) ? 'http' : 'sse',
        url: config.url,
        headers: readStringRecord(config.http_headers),
        bearerTokenEnvVar: readOptionalString(config.bearer_token_env_var),
        envHttpHeaders: readStringRecord(config.env_http_headers),
      };
    }

    return null;
  }
}
