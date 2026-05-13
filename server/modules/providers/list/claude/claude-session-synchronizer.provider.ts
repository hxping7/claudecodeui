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

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;

  private resolveHome(homeDir?: string): string {
    return path.join(homeDir || os.homedir(), '.claude');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date, homeDir?: string): Promise<number> {
    const claudeHome = this.resolveHome(homeDir);
    const nameMap = await buildLookupMap(path.join(claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    console.log(`[ClaudeSessionSynchronizer] Synchronizing sessions from ${claudeHome}, found ${files.length} files`);

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
        console.log(`[ClaudeSessionSynchronizer] Session ${processed}: id=${parsed.sessionId}, path=${parsed.projectPath}, user_id=${sessionInfo?.user_id ?? 'NULL'}`);
      }

      processed += 1;
    }

    console.log(`[ClaudeSessionSynchronizer] Sync complete: processed ${processed} sessions`);
    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string, homeDir?: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    const claudeHome = this.resolveHome(homeDir);
    const nameMap = await buildLookupMap(path.join(claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    const existingSession = sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Claude Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Claude Session'),
      };
    }

    let sessionName = nameMap.get(parsed.sessionId);
    if (!sessionName) {
      sessionName = await this.extractSessionAiTitleFromEnd(filePath, parsed.sessionId);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }

  private async extractSessionAiTitleFromEnd(
    filePath: string,
    sessionId: string
  ): Promise<string | undefined> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split(/\r?\n/);

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) {
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const eventSessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
        const aiTitle = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
        const lastPrompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;

        if ((eventType === 'ai-title' && eventSessionId === sessionId && aiTitle?.trim()) || (eventType === 'last-prompt' && eventSessionId === sessionId && lastPrompt?.trim())) {
          return aiTitle || lastPrompt;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    }

    return undefined;
  }
}
