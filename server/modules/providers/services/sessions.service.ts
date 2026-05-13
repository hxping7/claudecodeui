import fsp from 'node:fs/promises';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Verifies that the session belongs to the given user.
 * Rejects sessions with null user_id when a userId is provided — new sessions
 * should always have user_id set via inference in createSession.
 * @throws AppError if session not found or doesn't belong to user
 */
function verifySessionOwnership(sessionId: string, userId: number): void {
  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    throw new AppError(`Session "${sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }
  // Reject if session has no user_id (shouldn't happen for new data) or belongs to another user
  if (session.user_id === null || session.user_id !== userId) {
    throw new AppError(`Session "${sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Fetches persisted history by session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database.
   */
  fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
    userId?: number,
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);

    if (!session) {
      console.log(`[SessionsService] fetchHistory: session ${sessionId} not found (may still be streaming)`);
      return Promise.resolve({
        messages: [],
        total: 0,
        hasMore: false,
        offset: 0,
        limit: options.limit ?? null,
        tokenUsage: null,
      } satisfies FetchHistoryResult);
    }

    console.log(`[SessionsService] fetchHistory: session=${sessionId}, session.user_id=${session.user_id}, request.userId=${userId ?? 'undefined'}`);

    // Verify ownership if userId provided - reject sessions with null or mismatched user_id
    if (userId !== undefined && (session.user_id === null || session.user_id !== userId)) {
      console.warn(`[SessionsService] fetchHistory: ACCESS DENIED - session.user_id=${session.user_id} does not match userId=${userId}`);
      return Promise.resolve({
        messages: [],
        total: 0,
        hasMore: false,
        offset: 0,
        limit: options.limit ?? null,
        tokenUsage: null,
      } satisfies FetchHistoryResult);
    }

    // Look up project_path from projects table using project_id
    let projectPath = '';
    if (session.project_id) {
      const project = projectsDb.getProjectById(session.project_id);
      if (project) {
        projectPath = project.project_path;
      }
    }

    const provider = session.provider as LLMProvider;
    return providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: options.limit ?? null,
      offset: options.offset ?? 0,
      projectPath,
    });
  },

  /**
   * Deletes one persisted session row by id.
   *
   * When `deletedFromDisk` is true and a session `jsonl_path` exists, the path
   * is deleted from disk before the DB row is removed.
   */
  async deleteSessionById(
    sessionId: string,
    deletedFromDisk = false,
    userId?: number,
  ): Promise<{ sessionId: string; deletedFromDisk: boolean }> {
    // Verify ownership if userId provided
    verifySessionOwnership(sessionId, userId as number);

    const session = sessionsDb.getSessionById(sessionId);

    let removedFromDisk = false;
    if (deletedFromDisk && session?.jsonl_path) {
      removedFromDisk = await removeFileIfExists(session.jsonl_path);
    }

    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return { sessionId, deletedFromDisk: removedFromDisk };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string, userId?: number): { sessionId: string; summary: string } {
    // Verify ownership if userId provided
    verifySessionOwnership(sessionId, userId as number);

    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },
};
