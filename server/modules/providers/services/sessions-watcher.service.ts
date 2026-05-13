import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { LLMProvider, RealtimeClientConnection } from '@/shared/types.js';
import { getProjectsWithSessions } from '@/modules/projects/index.js';
import { userDb } from '@/modules/database/index.js';

type WatcherEventType = 'add' | 'change';

/**
 * Builds watch paths for all user home directories.
 * In PAM mode, each user has their own home_dir.
 */
function buildProviderWatchPaths(): Array<{ provider: LLMProvider; rootPath: string }> {
  const paths: Array<{ provider: LLMProvider; rootPath: string }> = [];

  // Collect all distinct user home directories
  const homeDirs = new Set<string>();
  try {
    const users = userDb.getAllActiveUsers();
    for (const user of users) {
      if (user.home_dir) {
        homeDirs.add(user.home_dir);
      }
    }
  } catch {
    // Database may not be ready during early startup
  }
  if (homeDirs.size === 0) {
    homeDirs.add(os.homedir());
  }

  for (const homeDir of homeDirs) {
    paths.push(
      { provider: 'claude', rootPath: path.join(homeDir, '.claude', 'projects') },
      { provider: 'cursor', rootPath: path.join(homeDir, '.cursor', 'chats') },
      { provider: 'codex', rootPath: path.join(homeDir, '.codex', 'sessions') },
      { provider: 'gemini', rootPath: path.join(homeDir, '.gemini', 'sessions') },
      { provider: 'gemini', rootPath: path.join(homeDir, '.gemini', 'tmp') },
    );
  }

  return paths;
}

const WATCHER_IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/*.tmp',
  '**/*.swp',
  '**/.DS_Store',
];

const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

const watchers: FSWatcher[] = [];

type PendingWatcherUpdate = {
  providers: Set<LLMProvider>;
  changeTypes: Set<WatcherEventType>;
  updatedSessionIds: Set<string>;
};

let pendingWatcherUpdate: PendingWatcherUpdate | null = null;
let pendingWatcherUpdateStartedAt: number | null = null;
let pendingWatcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRefreshInFlight = false;
let watcherRescheduleAfterRefresh = false;

/**
 * Filters watcher events to provider-specific session artifact file types.
 */
function isWatcherTargetFile(provider: LLMProvider, filePath: string): boolean {
  if (provider === 'gemini') {
    return filePath.endsWith('.json') || filePath.endsWith('.jsonl');
  }

  return filePath.endsWith('.jsonl');
}

function clearPendingWatcherFlushTimer(): void {
  if (pendingWatcherFlushTimer) {
    clearTimeout(pendingWatcherFlushTimer);
    pendingWatcherFlushTimer = null;
  }
}

function schedulePendingWatcherFlush(): void {
  if (!pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  const elapsed = now - pendingWatcherUpdateStartedAt;
  const remainingMaxWait = Math.max(0, PROJECTS_UPDATE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(PROJECTS_UPDATE_DEBOUNCE_MS, remainingMaxWait);

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(() => {
    void flushPendingWatcherUpdate();
  }, delay);
}

function queuePendingWatcherUpdate(
  eventType: WatcherEventType,
  provider: LLMProvider,
  updatedSessionId: string | null
): void {
  if (!pendingWatcherUpdate) {
    pendingWatcherUpdate = {
      providers: new Set<LLMProvider>(),
      changeTypes: new Set<WatcherEventType>(),
      updatedSessionIds: new Set<string>(),
    };
  }

  pendingWatcherUpdate.providers.add(provider);
  pendingWatcherUpdate.changeTypes.add(eventType);
  if (updatedSessionId) {
    pendingWatcherUpdate.updatedSessionIds.add(updatedSessionId);
  }

  schedulePendingWatcherFlush();
}

async function flushPendingWatcherUpdate(): Promise<void> {
  clearPendingWatcherFlushTimer();

  if (!pendingWatcherUpdate) {
    return;
  }

  if (watcherRefreshInFlight) {
    watcherRescheduleAfterRefresh = true;
    return;
  }

  const queuedUpdate = pendingWatcherUpdate;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = true;

  try {
    const clientsByUserId = new Map<number, Set<RealtimeClientConnection>>();
    const unauthenticatedClients: RealtimeClientConnection[] = [];

    for (const client of connectedClients) {
      const rawUserId = (client as any).userId;
      const userId =
        typeof rawUserId === 'number'
          ? rawUserId
          : typeof rawUserId === 'string' && rawUserId.trim().length > 0 && !Number.isNaN(Number(rawUserId))
            ? Number(rawUserId)
            : null;

      if (userId === null) {
        unauthenticatedClients.push(client);
        continue;
      }

      if (!clientsByUserId.has(userId)) {
        clientsByUserId.set(userId, new Set());
      }
      clientsByUserId.get(userId)!.add(client);
    }

    for (const client of unauthenticatedClients) {
      if (client.readyState === WS_OPEN_STATE) {
        (client as any).send(
          JSON.stringify({
            type: 'error',
            error: 'Unauthorized realtime connection',
          }),
        );
        if (typeof (client as any).close === 'function') {
          (client as any).close(4401, 'Unauthorized');
        }
      }
    }

    for (const [userId, clients] of clientsByUserId) {
      if (clients.size === 0) continue;

      const userProjects = await getProjectsWithSessions({ skipSynchronization: true, userId });
      const changeTypes = Array.from(queuedUpdate.changeTypes);
      const watchProviders = Array.from(queuedUpdate.providers);
      const updatedSessionIds = Array.from(queuedUpdate.updatedSessionIds);

      const updateMessage = JSON.stringify({
        type: 'projects_updated',
        projects: userProjects,
        userId,
        timestamp: new Date().toISOString(),
        changeType: changeTypes[0] ?? 'change',
        updatedSessionId: updatedSessionIds[0] ?? undefined,
        watchProvider: watchProviders[0] ?? undefined,
        changeTypes,
        updatedSessionIds,
        watchProviders,
        batched: true,
      });

      for (const client of clients) {
        if (client.readyState === WS_OPEN_STATE) {
          client.send(updateMessage);
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session watcher refresh failed while broadcasting projects_updated', { error: message });
  } finally {
    watcherRefreshInFlight = false;

    if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
      watcherRescheduleAfterRefresh = false;
      schedulePendingWatcherFlush();
    }
  }
}

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(provider, filePath);
    if (!result.indexed) {
      return;
    }

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });
    queuePendingWatcherUpdate(eventType, provider, result.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 */
export async function initializeSessionsWatcher(): Promise<void> {
  console.log('Setting up session watchers');

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    failures: initialSync.failures,
  });

  for (const { provider, rootPath } of buildProviderWatchPaths()) {
    try {
      await fsPromises.mkdir(rootPath, { recursive: true });

      const watcher = chokidar.watch(rootPath, {
        ignored: WATCHER_IGNORED_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        depth: 6,
        usePolling: true,
        interval: 6_000,
        binaryInterval: 6_000,
      });

      watcher
        .on('add', (filePath: string) => {
          void onUpdate('add', filePath, provider);
        })
        .on('change', (filePath: string) => {
          void onUpdate('change', filePath, provider);
        })
        .on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Session watcher error for provider "${provider}"`, { error: message });
        });

      watchers.push(watcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  clearPendingWatcherFlushTimer();

  await Promise.all(
    watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.length = 0;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
}
