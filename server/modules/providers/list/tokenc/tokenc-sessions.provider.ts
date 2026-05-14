import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord } from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';

const PROVIDER = 'tokenc';

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
  };

type TokencHistoryMessagesResult =
  | AnyRecord[]
  | {
    messages: AnyRecord[];
    total: number;
    hasMore: boolean;
    offset?: number;
    limit?: number | null;
  };

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

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const normalized = this.normalizeMessage(parsed, sessionId);
          allMessages.push(...normalized);
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
