/**
 * User repository.
 *
 * Provides typed CRUD operations for the `users` table.
 * This is a single-user system, but the schema supports multiple
 * users for forward compatibility.
 */

import { getConnection } from '@/modules/database/connection.js';

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: number;
  role: 'superadmin' | 'admin' | 'user';
  home_dir: string | null;
};

type UserPublicRow = Pick<UserRow, 'id' | 'username' | 'created_at' | 'last_login' | 'role' | 'home_dir'>;

type UserGitConfig = {
  git_name: string | null;
  git_email: string | null;
};

type CreateUserResult = {
  id: number | bigint;
  username: string;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const userDb = {
  /** Returns true if at least one user exists in the database. */
  hasUsers(): boolean {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
      count: number;
    };
    return row.count > 0;
  },

  /** Inserts a new user and returns the created ID + username. */
  createUser(username: string, passwordHash: string, role: 'superadmin' | 'admin' | 'user' = 'user'): CreateUserResult {
    const db = getConnection();
    const result = db
      .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, passwordHash, role);
    return { id: result.lastInsertRowid, username };
  },

  /**
   * Looks up a user by username regardless of active status.
   * Used for PAM auth to check if user exists and is disabled.
   */
  getUserByUsernameAny(username: string): UserRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username) as UserRow | undefined;
  },

  /**
   * Looks up an active user by username.
   * Returns the full row (including password hash) for auth verification.
   */
  getUserByUsername(username: string): UserRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM users WHERE username = ? AND is_active = 1')
      .get(username) as UserRow | undefined;
  },

  /** Updates the last_login timestamp. Non-fatal — logs but does not throw. */
  updateLastLogin(userId: number): void {
    try {
      const db = getConnection();
      db.prepare(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to update last login', { error: message });
    }
  },

  /** Returns public user fields by ID (no password hash). */
  getUserById(userId: number): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, role, home_dir FROM users WHERE id = ? AND is_active = 1'
      )
      .get(userId) as UserPublicRow | undefined;
  },

  /** Returns the first active user. Used for single-user mode lookups. */
  getFirstUser(): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        'SELECT id, username, created_at, last_login, role, home_dir FROM users WHERE is_active = 1 LIMIT 1'
      )
      .get() as UserPublicRow | undefined;
  },

  /** Stores the user's preferred git name and email. */
  updateGitConfig(
    userId: number,
    gitName: string,
    gitEmail: string
  ): void {
    const db = getConnection();
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(
      gitName,
      gitEmail,
      userId
    );
  },

  /** Retrieves the user's git identity (name + email). */
  getGitConfig(userId: number): UserGitConfig | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT git_name, git_email FROM users WHERE id = ?')
      .get(userId) as UserGitConfig | undefined;
  },

  /** Marks onboarding as complete for the given user. */
  completeOnboarding(userId: number): void {
    const db = getConnection();
    db.prepare(
      'UPDATE users SET has_completed_onboarding = 1 WHERE id = ?'
    ).run(userId);
  },

  /** Returns true if the user has finished the onboarding flow. */
  hasCompletedOnboarding(userId: number): boolean {
    const db = getConnection();
    const row = db
      .prepare('SELECT has_completed_onboarding FROM users WHERE id = ?')
      .get(userId) as { has_completed_onboarding: number } | undefined;
    return row?.has_completed_onboarding === 1;
  },

  // ===============================
  // Admin methods
  // ===============================

  /** Returns all users (including inactive) for admin management. */
  getAllUsers(): UserRow[] {
    const db = getConnection();
    return db
      .prepare('SELECT * FROM users ORDER BY created_at DESC')
      .all() as UserRow[];
  },

  /** Returns all active users (for multi-user session scanning). */
  getAllActiveUsers(): UserPublicRow[] {
    const db = getConnection();
    return db
      .prepare('SELECT id, username, created_at, last_login, role, home_dir FROM users WHERE is_active = 1')
      .all() as UserPublicRow[];
  },

  /** Returns user by ID (including inactive, without password hash for admin). */
  getUserByIdFull(userId: number): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT id, username, created_at, last_login, role, is_active, git_name, git_email, has_completed_onboarding FROM users WHERE id = ?')
      .get(userId) as UserPublicRow | undefined;
  },

  /** Updates user information (admin only). */
  updateUser(userId: number, updates: Partial<Pick<UserRow, 'username' | 'git_name' | 'git_email' | 'role' | 'home_dir'>>): boolean {
    const db = getConnection();
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.username !== undefined) {
      fields.push('username = ?');
      values.push(updates.username);
    }
    if (updates.git_name !== undefined) {
      fields.push('git_name = ?');
      values.push(updates.git_name);
    }
    if (updates.git_email !== undefined) {
      fields.push('git_email = ?');
      values.push(updates.git_email);
    }
    if (updates.role !== undefined) {
      fields.push('role = ?');
      values.push(updates.role);
    }
    if (updates.home_dir !== undefined) {
      fields.push('home_dir = ?');
      values.push(updates.home_dir);
    }

    if (fields.length === 0) {
      return false;
    }

    values.push(userId);
    const result = db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return result.changes > 0;
  },

  /** Updates user password (admin reset). */
  updatePassword(userId: number, passwordHash: string): boolean {
    const db = getConnection();
    const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
    return result.changes > 0;
  },

  /** Toggles user active status. */
  toggleUserActive(userId: number, isActive: boolean): boolean {
    const db = getConnection();
    const result = db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, userId);
    return result.changes > 0;
  },

  /** Checks if user is admin. */
  isAdmin(userId: number): boolean {
    const db = getConnection();
    const row = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined;
    return row?.role === 'admin' || row?.role === 'superadmin';
  },

  /** Gets user role. */
  getUserRole(userId: number): 'superadmin' | 'admin' | 'user' | null {
    const db = getConnection();
    const row = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined;
    return row?.role as 'superadmin' | 'admin' | 'user' | null;
  },

  /** Counts total users. */
  countUsers(): number {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    return row.count;
  },

  /** Deletes a user and all associated data. */
  deleteUser(userId: number): boolean {
    const db = getConnection();
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return result.changes > 0;
  },
};
