import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import os from 'node:os';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';

const PROVIDER = 'tokenc';

type ModelCapabilityInfo = {
  maxInputTokens: number;
  maxOutputTokens: number;
};

type ProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  modelcapbility?: Record<string, ModelCapabilityInfo>;
};

type ProviderSettings = {
  current?: string;
  providers?: Record<string, ProviderConfig>;
};

type TokencToolResult = {
  content: unknown;
  isError: boolean;
  subagentTools?: unknown;
  toolUseResult?: unknown;
};

type TokencHistoryResult =
  | AnyRecord[]
  | {
    messages?: AnyRecord[];
    total?: number;
    hasMore?: boolean;
    tokenUsage?: AnyRecord;
  };

type TokencHistoryMessagesResult =
  | AnyRecord[]
  | {
    messages: AnyRecord[];
    total: number;
    hasMore: boolean;
    offset?: number;
    limit?: number | null;
    tokenUsage?: AnyRecord;
  };

function getModelContextWindow(model: string): number {
  const DEFAULT_CONTEXT_WINDOW = 200000;

  try {
    const homeDir = os.homedir();
    const settingsPath = path.join(homeDir, '.tokencode', 'settings_provider.json');
    const content = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(content) as ProviderSettings;

    if (!settings.providers) {
      return DEFAULT_CONTEXT_WINDOW;
    }

    // Check all providers for model capability
    for (const providerConfig of Object.values(settings.providers)) {
      if (!providerConfig.modelcapbility) {
        continue;
      }

      // Try exact match first
      if (providerConfig.modelcapbility[model]) {
        return providerConfig.modelcapbility[model].maxInputTokens || DEFAULT_CONTEXT_WINDOW;
      }

      // Try case-insensitive substring match
      const modelLower = model.toLowerCase();
      for (const [modelId, capability] of Object.entries(providerConfig.modelcapbility)) {
        if (modelLower.includes(modelId.toLowerCase()) || modelId.toLowerCase().includes(modelLower)) {
          return capability.maxInputTokens || DEFAULT_CONTEXT_WINDOW;
        }
      }
    }
  } catch {
    // File doesn't exist or error reading
  }

  return DEFAULT_CONTEXT_WINDOW;
}

function buildTokencTokenUsage(usage: unknown, model?: string): AnyRecord | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const record = usage as AnyRecord;
  const inputTokens = Number(record.input_tokens || 0);
  const outputTokens = Number(record.output_tokens || 0);
  const cacheCreationInputTokens = Number(record.cache_creation_input_tokens || 0);
  const cacheReadInputTokens = Number(record.cache_read_input_tokens || 0);

  const used = inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens;

  if (used === 0) {
    return undefined;
  }

  // Get context window from settings_provider.json or use default
  const contextWindow = model ? getModelContextWindow(model) : 200000;

  return {
    used,
    total: contextWindow,
    breakdown: {
      input: inputTokens + cacheReadInputTokens,
      output: outputTokens,
      cacheCreation: cacheCreationInputTokens,
      cacheRead: cacheReadInputTokens,
    },
  };
}

async function parseAgentTools(filePath: string): Promise<AnyRecord[]> {
  const tools: AnyRecord[] = [];

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;

        if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type === 'tool_use') {
              tools.push({
                toolId: part.id,
                toolName: part.name,
                toolInput: part.input,
                timestamp: entry.timestamp,
              });
            }
          }
        }

        if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type !== 'tool_result') {
              continue;
            }

            const tool = tools.find((candidate) => candidate.toolId === part.tool_use_id);
            if (!tool) {
              continue;
            }

            tool.toolResult = {
              content: Array.isArray(part.content) ? part.content : [{ type: 'text', text: String(part.content ?? '') }],
              isError: part.isError ?? false,
              subagentTools: undefined,
              toolUseResult: undefined,
            };
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    return tools;
  } catch {
    return [];
  }
}

function buildToolResult(tool: AnyRecord): TokencToolResult {
  return {
    content: tool.toolResult?.content ?? [],
    isError: tool.toolResult?.isError ?? false,
    subagentTools: tool.toolResult?.subagentTools,
    toolUseResult: tool.toolResult?.toolUseResult,
  };
}

export class TokencSessionsProvider implements IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const normalized: NormalizedMessage[] = [];

    if (!raw || typeof raw !== 'object') {
      return normalized;
    }

    const entry = raw as AnyRecord;

    switch (entry.type) {
      case 'system':
        if (entry.subtype === 'init') {
          normalized.push(createNormalizedMessage({
            kind: 'session_created',
            newSessionId: entry.session_id,
            model: entry.model,
            cwd: entry.cwd,
            sessionId: sessionId ?? entry.session_id,
            provider: PROVIDER,
          }));
        }
        break;

      case 'assistant':
        if (entry.message && typeof entry.message === 'object') {
          const message = entry.message as AnyRecord;
          const contentParts = Array.isArray(message.content) ? message.content : [];

          for (const part of contentParts) {
            if (!part || typeof part !== 'object') {
              continue;
            }

            const typedPart = part as AnyRecord;

            if (typedPart.type === 'text' && typedPart.text) {
              normalized.push(createNormalizedMessage({
                id: generateMessageId(),
                sessionId: sessionId ?? '',
                provider: PROVIDER,
                kind: 'text',
                role: 'assistant',
                content: typedPart.text,
                timestamp: new Date().toISOString(),
              }));
            }

            if (typedPart.type === 'tool_use') {
              normalized.push(createNormalizedMessage({
                id: generateMessageId(),
                sessionId: sessionId ?? '',
                provider: PROVIDER,
                kind: 'tool_use',
                role: 'assistant',
                toolName: typedPart.name,
                toolInput: typedPart.input,
                toolId: typedPart.id,
                timestamp: new Date().toISOString(),
              }));
            }

            if (typedPart.type === 'thinking' && typedPart.thinking) {
              normalized.push(createNormalizedMessage({
                id: generateMessageId(),
                sessionId: sessionId ?? '',
                provider: PROVIDER,
                kind: 'thinking',
                role: 'assistant',
                content: typedPart.thinking,
                timestamp: new Date().toISOString(),
              }));
            }
          }
        }
        break;

      case 'user':
        if (entry.message && typeof entry.message === 'object') {
          const message = entry.message as AnyRecord;
          const contentParts = Array.isArray(message.content) ? message.content : [];

          for (const part of contentParts) {
            if (!part || typeof part !== 'object') {
              continue;
            }

            const typedPart = part as AnyRecord;

            if (typedPart.type === 'tool_result') {
              normalized.push(createNormalizedMessage({
                id: generateMessageId(),
                sessionId: sessionId ?? '',
                provider: PROVIDER,
                kind: 'tool_result',
                role: 'user',
                toolId: typedPart.tool_use_id,
                content: Array.isArray(typedPart.content)
                  ? typedPart.content
                  : [{ type: 'text', text: String(typedPart.content ?? '') }],
                isError: typedPart.is_error ?? false,
                timestamp: new Date().toISOString(),
              }));
            }
          }
        }
        break;

      case 'result':
        normalized.push(createNormalizedMessage({
          kind: 'complete',
          exitCode: entry.exit_code ?? (entry.subtype === 'success' ? 0 : 1),
          resultText: typeof entry.result === 'string' ? entry.result : '',
          isNewSession: true,
          sessionId: sessionId ?? '',
          provider: PROVIDER,
          isError: entry.subtype !== 'success',
        }));
        break;
    }

    return normalized;
  }

  async fetchHistory(sessionId: string, options?: FetchHistoryOptions): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);

    if (!session || !session.jsonl_path) {
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset: options?.offset ?? 0,
        limit: options?.limit ?? null,
      };
    }

    const filePath = session.jsonl_path;
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    try {
      const content = await fsp.readFile(filePath, 'utf8');
      const lines = content.split('\n').filter((line) => line.trim());
      const allMessages: NormalizedMessage[] = [];
      let tokenUsage: AnyRecord | undefined;
      let lastModel: string | undefined;

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const normalized = this.normalizeMessage(parsed, sessionId);
          allMessages.push(...normalized);

          // Extract model name from assistant messages
          if (parsed.type === 'assistant' && parsed.message?.model) {
            lastModel = parsed.message.model;
          }

          // Extract token usage from assistant messages
          if (parsed.type === 'assistant' && parsed.message?.usage) {
            const usage = buildTokencTokenUsage(parsed.message.usage, lastModel);
            if (usage) {
              tokenUsage = usage;
            }
          }
        } catch {
          // Skip malformed JSON lines
        }
      }

      const paginatedMessages = allMessages.slice(offset, offset + limit);

      return {
        messages: paginatedMessages,
        total: allMessages.length,
        hasMore: offset + limit < allMessages.length,
        offset,
        limit,
        tokenUsage,
      };
    } catch (error) {
      console.error(`[TokencSessionsProvider] Error reading history file ${filePath}:`, error);
      return {
        messages: [],
        total: 0,
        hasMore: false,
        offset,
        limit,
      };
    }
  }
}
