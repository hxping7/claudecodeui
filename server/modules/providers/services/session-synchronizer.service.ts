import os from 'node:os';

import { userDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider } from '@/shared/types.js';
import { scanStateDb } from '@/modules/database/index.js';

type SessionSynchronizeResult = {
  processedByProvider: Record<LLMProvider, number>;
  failures: string[];
};

/**
 * Returns all distinct user home directories that should be scanned.
 * In PAM mode, each user has their own home_dir. Falls back to os.homedir()
 * when no user home directories are found.
 */
function getUserHomeDirs(): string[] {
  try {
    const users = userDb.getAllActiveUsers();
    const dirs = users
      .map((u: { home_dir?: string | null }) => u.home_dir)
      .filter((d: string | null | undefined): d is string => typeof d === 'string' && d.length > 0);
    if (dirs.length > 0) {
      return [...new Set(dirs)];
    }
  } catch {
    // Database may not be ready during early startup
  }
  return [os.homedir()];
}

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 */
export const sessionSynchronizerService = {
  /**
   * Runs all provider synchronizers across all user home directories and updates scan_state.last_scanned_at.
   */
  async synchronizeSessions(): Promise<SessionSynchronizeResult> {
    const lastScanAt = scanStateDb.getLastScannedAt();
    const scanBoundary = new Date();
    const processedByProvider: Record<LLMProvider, number> = {
      claude: 0,
      codex: 0,
      cursor: 0,
      gemini: 0,
      tokenc: 0,
    };
    const failures: string[] = [];
    const homeDirs = getUserHomeDirs();

    for (const homeDir of homeDirs) {
      const results = await Promise.allSettled(
        providerRegistry.listProviders().map(async (provider) => ({
          provider: provider.id,
          processed: await provider.sessionSynchronizer.synchronize(lastScanAt ?? undefined, homeDir),
        }))
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          processedByProvider[result.value.provider] += result.value.processed;
          continue;
        }

        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push(reason);
      }
    }

    if (failures.length === 0) {
      scanStateDb.updateLastScannedAt(scanBoundary);
    } else {
      console.warn(
        `[Sessions] Skipping scan_state cursor advance because ${failures.length} provider sync(s) failed.`,
      );
    }

    return {
      processedByProvider,
      failures,
    };
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null }> {
    // Try to infer homeDir from the file path
    const homeDirs = getUserHomeDirs();
    let matchingHomeDir: string | undefined;
    for (const dir of homeDirs) {
      if (filePath.startsWith(dir)) {
        matchingHomeDir = dir;
        break;
      }
    }

    const resolvedProvider = providerRegistry.resolveProvider(provider);
    const sessionId = await resolvedProvider.sessionSynchronizer.synchronizeFile(filePath, matchingHomeDir);
    return {
      provider,
      indexed: Boolean(sessionId),
      sessionId,
    };
  },
};
