import { getConnection } from '@/modules/database/connection.js';
import { projectsDb, userDb } from '@/modules/database/index.js';
import { normalizeProjectPath } from '@/shared/utils.js';

type SessionRow = {
  session_id: string;
  provider: string;
  project_id: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  user_id: number | null;
  created_at: string;
  updated_at: string;
};

type SessionMetadataLookupRow = Pick<
  SessionRow,
  'session_id' | 'provider' | 'project_id' | 'jsonl_path' | 'custom_name' | 'created_at' | 'updated_at' | 'user_id'
>;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

/**
 * Resolves a project_id from a project path.
 * If multiple projects share the same path, returns the first active one.
 * If no project exists, creates one automatically.
 */
/**
 * Infers a user_id from a project path by matching against user home directories.
 * Falls back to null if no match found.
 */
function inferUserIdFromPath(projectPath: string): number | null {
  try {
    const users = userDb.getAllActiveUsers();
    // Sort by home_dir length descending so longer (more specific) paths match first
    const sorted = [...users].sort((a, b) => (b.home_dir?.length ?? 0) - (a.home_dir?.length ?? 0));
    for (const user of sorted) {
      if (user.home_dir && projectPath.startsWith(user.home_dir)) {
        return user.id;
      }
    }
  } catch {
    // Database may not be ready
  }
  return null;
}

function resolveOrCreateProjectIdFromPath(projectPath: string, userId?: number): string | null {
  const normalizedPath = normalizeProjectPath(projectPath);
  const projects = projectsDb.getProjectsByPath(normalizedPath);

  if (projects.length > 0) {
    // Prefer the project matching the given userId, otherwise take the first one
    if (userId) {
      const userProject = projects.find(p => p.user_id === userId);
      if (userProject) {
        return userProject.project_id;
      }
    }
    return projects[0].project_id;
  }

  // If userId not provided, try to infer from path
  const effectiveUserId = userId ?? inferUserIdFromPath(normalizedPath);

  // No project found, create one automatically
  const result = projectsDb.createProjectPath(normalizedPath, null, effectiveUserId ?? undefined);
  if (result.outcome === 'created' && result.project) {
    console.log(`[Sessions] Auto-created project for path: ${normalizedPath}, user_id: ${effectiveUserId ?? null}`);
    return result.project.project_id;
  }

  return null;
}

export const sessionsDb = {
  /**
   * Creates or updates a session.
   * Accepts either projectId or projectPath (will be resolved to projectId).
   */
  createSession(
    sessionId: string,
    provider: string,
    projectIdOrPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null,
    userId?: number
  ): string {
    const db = getConnection();
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);

    // Determine if we got a project_id or project_path
    // If it looks like a UUID, it's a project_id; otherwise, resolve it as a path
    let projectId: string | null = projectIdOrPath;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectIdOrPath);
    if (!isUuid) {
      projectId = resolveOrCreateProjectIdFromPath(projectIdOrPath, userId);
    }

    // If no project found, we can't create the session (foreign key constraint)
    if (!projectId) {
      console.warn(`[Sessions] Cannot create session ${sessionId}: failed to resolve project for ${projectIdOrPath}`);
      return sessionId;
    }

    // Determine effective userId: use provided value, then infer from path, then from project row
    let effectiveUserId = userId ?? null;
    if (!effectiveUserId && !isUuid) {
      effectiveUserId = inferUserIdFromPath(projectIdOrPath);
    }
    if (!effectiveUserId && projectId) {
      const project = projectsDb.getProjectById(projectId);
      effectiveUserId = project?.user_id ?? null;
    }

    db.prepare(
      `INSERT INTO sessions (session_id, provider, custom_name, project_id, jsonl_path, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         updated_at = excluded.updated_at,
         project_id = excluded.project_id,
         jsonl_path = excluded.jsonl_path,
         user_id = COALESCE(excluded.user_id, sessions.user_id),
         custom_name = COALESCE(excluded.custom_name, sessions.custom_name)`
    ).run(
      sessionId,
      provider,
      customName ?? null,
      projectId,
      jsonlPath ?? null,
      effectiveUserId,
      createdAtValue,
      updatedAtValue
    );

    return sessionId;
  },

  updateSessionCustomName(sessionId: string, customName: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE sessions
       SET custom_name = ?
       WHERE session_id = ?`
    ).run(customName, sessionId);
  },

  getSessionById(sessionId: string): SessionMetadataLookupRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT session_id, provider, project_id, jsonl_path, custom_name, user_id, created_at, updated_at
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(sessionId) as SessionMetadataLookupRow | undefined;

    return row ?? null;
  },

  getAllSessions(): SessionRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, provider, project_id, jsonl_path, custom_name, user_id, created_at, updated_at
         FROM sessions`
      )
      .all() as SessionRow[];
  },

  getSessionsByProjectId(projectId: string): SessionRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, provider, project_id, jsonl_path, custom_name, user_id, created_at, updated_at
         FROM sessions
         WHERE project_id = ?`
      )
      .all(projectId) as SessionRow[];
  },

  getSessionsByProjectIdPage(projectId: string, limit: number, offset: number): SessionRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, provider, project_id, jsonl_path, custom_name, user_id, created_at, updated_at
         FROM sessions
         WHERE project_id = ?
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(projectId, limit, offset) as SessionRow[];
  },

  countSessionsByProjectId(projectId: string): number {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_id = ?`
      )
      .get(projectId) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  deleteSessionsByProjectId(projectId: string): void {
    const db = getConnection();
    db.prepare(`DELETE FROM sessions WHERE project_id = ?`).run(projectId);
  },

  getSessionName(sessionId: string, provider: string): string | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`
      )
      .get(sessionId, provider) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  deleteSessionById(sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId).changes > 0;
  },

  // ===============================
  // Multi-tenant methods (user isolation)
  // ===============================

  /** Get all sessions for a specific user */
  getSessionsByUserId(userId: number): SessionRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, provider, project_id, jsonl_path, custom_name, user_id, created_at, updated_at
         FROM sessions
         WHERE user_id = ?
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC`
      )
      .all(userId) as SessionRow[];
  },

  /** Get sessions by project for a specific user */
  getSessionsByUserIdAndProjectId(userId: number, projectId: string): SessionRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT session_id, provider, project_id, jsonl_path, custom_name, user_id, created_at, updated_at
         FROM sessions
         WHERE user_id = ? AND project_id = ?
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC`
      )
      .all(userId, projectId) as SessionRow[];
  },

  /** Delete session only if it belongs to the user */
  deleteSessionByIdAndUserId(userId: number, sessionId: string): boolean {
    const db = getConnection();
    return db.prepare('DELETE FROM sessions WHERE session_id = ? AND user_id = ?').run(sessionId, userId).changes > 0;
  },

  // ===============================
  // Legacy compatibility methods (for migration period)
  // ===============================

  /** @deprecated Use getSessionsByProjectId instead */
  getSessionsByProjectPath(projectPath: string): SessionRow[] {
    const db = getConnection();
    const normalizedPath = normalizeProjectPath(projectPath);
    // Find sessions through projects table
    return db
      .prepare(
        `SELECT s.session_id, s.provider, s.project_id, s.jsonl_path, s.custom_name, s.user_id, s.created_at, s.updated_at
         FROM sessions s
         JOIN projects p ON s.project_id = p.project_id
         WHERE p.project_path = ?`
      )
      .all(normalizedPath) as SessionRow[];
  },

  /** @deprecated Use getSessionsByProjectIdPage instead */
  getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): SessionRow[] {
    const db = getConnection();
    const normalizedPath = normalizeProjectPath(projectPath);
    return db
      .prepare(
        `SELECT s.session_id, s.provider, s.project_id, s.jsonl_path, s.custom_name, s.user_id, s.created_at, s.updated_at
         FROM sessions s
         JOIN projects p ON s.project_id = p.project_id
         WHERE p.project_path = ?
         ORDER BY datetime(COALESCE(s.updated_at, s.created_at)) DESC, s.session_id DESC
         LIMIT ? OFFSET ?`
      )
      .all(normalizedPath, limit, offset) as SessionRow[];
  },

  /** @deprecated Use countSessionsByProjectId instead */
  countSessionsByProjectPath(projectPath: string): number {
    const db = getConnection();
    const normalizedPath = normalizeProjectPath(projectPath);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM sessions s
         JOIN projects p ON s.project_id = p.project_id
         WHERE p.project_path = ?`
      )
      .get(normalizedPath) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  /** @deprecated Use deleteSessionsByProjectId instead */
  deleteSessionsByProjectPath(projectPath: string): void {
    const db = getConnection();
    const normalizedPath = normalizeProjectPath(projectPath);
    db.prepare(
      `DELETE FROM sessions WHERE project_id IN (
        SELECT project_id FROM projects WHERE project_path = ?
      )`
    ).run(normalizedPath);
  },
};
