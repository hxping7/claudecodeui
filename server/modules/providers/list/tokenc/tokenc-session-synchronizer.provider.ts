import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

export class TokencSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'tokenc' as const;

  private resolveHome(homeDir?: string): string {
    return path.join(homeDir || os.homedir(), '.tokencode');
  }

  async synchronize(since?: Date, homeDir?: string): Promise<number> {
    const tokencHome = this.resolveHome(homeDir);
    const nameMap = await buildLookupMap(path.join(tokencHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(tokencHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    console.log(`[TokencSessionSynchronizer] Synchronizing sessions from ${tokencHome}, found ${files.length} files`);

    let processed = 0;
    for (const filePath of files) {
      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      const resultSessionId = sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );

      if (processed < 5 || processed % 50 === 0) {
        const sessionInfo = sessionsDb.getSessionById(parsed.sessionId);
        console.log(`[TokencSessionSynchronizer] Session ${processed}: id=${parsed.sessionId}, path=${parsed.projectPath}, user_id=${sessionInfo?.user_id ?? 'NULL'}`);
      }

      processed += 1;
    }

    console.log(`[TokencSessionSynchronizer] Sync complete: processed ${processed} sessions`);
    return processed;
  }

  async synchronizeFile(filePath: string, homeDir?: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const tokencHome = this.resolveHome(homeDir);
    const nameMap = await buildLookupMap(path.join(tokencHome, 'history.jsonl'), 'sessionId', 'display');

    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );

    return parsed.sessionId;
  }

  private async processSessionFile(filePath: string, nameMap: Map<string, string>): Promise<ParsedSession | null> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split('\n').filter((line) => line.trim());

      let sessionId: string | null = null;
      let projectPath: string | null = null;
      let firstUserMessage: string | null = null;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          if (entry.type === 'system' && entry.subtype === 'init' && !sessionId) {
            sessionId = entry.session_id ?? entry.sessionId ?? null;
            projectPath = entry.cwd ?? null;
          }

          if (!sessionId) {
            sessionId = entry.session_id ?? entry.sessionId ?? null;
          }

          if (entry.cwd && !projectPath) {
            projectPath = entry.cwd;
          }

          if (!firstUserMessage && entry.type === 'user' && entry.message?.content) {
            const msg = typeof entry.message.content === 'string'
              ? entry.message.content
              : Array.isArray(entry.message.content)
                ? entry.message.content.map((c: any) => c.text || c.content || '').filter(Boolean).join(' ')
                : null;
            if (msg) {
              firstUserMessage = msg;
            }
          }

          if (!firstUserMessage && entry.type === 'last-prompt' && entry.lastPrompt) {
            firstUserMessage = entry.lastPrompt;
          }

          // Only break early if we have all the information we need
          if (sessionId && projectPath && firstUserMessage) {
            break;
          }
        } catch {
          // Skip malformed JSON lines
        }
      }

      if (!sessionId) {
        const match = filePath.match(/([a-f0-9-]{36})\.jsonl$/);
        if (match?.[1]) {
          sessionId = match[1];
        }
      }

      if (!sessionId || !projectPath) {
        return null;
      }

      // Use nameMap from history.jsonl first, fall back to first user message, then sessionId
      const nameFromHistory = nameMap.get(sessionId);
      const sessionName = normalizeSessionName(
        nameFromHistory || firstUserMessage || undefined,
        sessionId
      );

      return { sessionId, projectPath, sessionName };
    } catch (error) {
      console.error(`[TokencSessionSynchronizer] Error processing file ${filePath}:`, error);
      return null;
    }
  }
}
