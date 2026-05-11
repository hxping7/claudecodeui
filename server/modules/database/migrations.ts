import { Database } from 'better-sqlite3';

import {
  AGENT_CONFIG_TABLE_SCHEMA_SQL,
  APP_CONFIG_TABLE_SCHEMA_SQL,
  LAST_SCANNED_AT_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
  USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL,
  USER_AGENT_CONFIG_TABLE_SCHEMA_SQL,
  VAPID_KEYS_TABLE_SCHEMA_SQL,
} from '@/modules/database/schema.js';

const SQLITE_UUID_SQL = `
lower(hex(randomblob(4))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(2))) || '-' ||
lower(hex(randomblob(6)))
`;

type TableInfoRow = {
  name: string;
  pk: number;
};

const addColumnToTableIfNotExists = (
  db: Database,
  tableName: string,
  columnNames: string[],
  columnName: string,
  columnType: string
) => {
  if (!columnNames.includes(columnName)) {
    console.log(`Running migration: Adding ${columnName} column to ${tableName} table`);
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
};

const tableExists = (db: Database, tableName: string): boolean =>
  Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );

const getTableInfo = (db: Database, tableName: string): TableInfoRow[] =>
  db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];

const migrateLegacySessionNames = (db: Database): void => {
  const hasLegacySessionNamesTable = tableExists(db, 'session_names');
  const hasSessionsTable = tableExists(db, 'sessions');

  if (!hasLegacySessionNamesTable) {
    return;
  }

  if (hasSessionsTable) {
    console.log('Running migration: Merging session_names into sessions');
    db.exec(`
      INSERT INTO sessions (session_id, provider, custom_name, created_at, updated_at)
      SELECT
        session_id,
        COALESCE(provider, 'claude'),
        custom_name,
        COALESCE(created_at, CURRENT_TIMESTAMP),
        COALESCE(updated_at, CURRENT_TIMESTAMP)
      FROM session_names
      WHERE true
      ON CONFLICT(session_id) DO UPDATE SET
        provider = excluded.provider,
        custom_name = COALESCE(excluded.custom_name, sessions.custom_name),
        created_at = COALESCE(sessions.created_at, excluded.created_at),
        updated_at = COALESCE(excluded.updated_at, sessions.updated_at)
    `);
    db.exec('DROP TABLE session_names');
    return;
  }

  console.log('Running migration: Renaming session_names table to sessions');
  db.exec('ALTER TABLE session_names RENAME TO sessions');
};

const migrateLegacyWorkspaceTableIntoProjects = (db: Database): void => {
  db.exec(PROJECTS_TABLE_SCHEMA_SQL);

  if (!tableExists(db, 'workspace_original_paths')) {
    return;
  }

  console.log('Running migration: Migrating workspace_original_paths data into projects');
  // For each workspace path, insert only if no project exists for that path
  db.exec(`
    INSERT INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      CASE
        WHEN workspace_id IS NULL OR trim(workspace_id) = ''
        THEN ${SQLITE_UUID_SQL}
        ELSE workspace_id
      END,
      workspace_path,
      custom_workspace_name,
      COALESCE(isStarred, 0),
      0
    FROM workspace_original_paths
    WHERE workspace_path IS NOT NULL AND trim(workspace_path) <> ''
      AND workspace_path NOT IN (SELECT project_path FROM projects WHERE project_path IS NOT NULL)
  `);
};

const rebuildProjectsTableWithPrimaryKeySchema = (db: Database): void => {
  const hasProjectsTable = tableExists(db, 'projects');
  if (!hasProjectsTable) {
    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    return;
  }

  const projectsTableInfo = getTableInfo(db, 'projects');
  const columnNames = projectsTableInfo.map((column) => column.name);
  const hasProjectIdPrimaryKey = projectsTableInfo.some(
    (column) => column.name === 'project_id' && column.pk === 1,
  );

  if (hasProjectIdPrimaryKey) {
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'custom_project_name', 'TEXT DEFAULT NULL');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isStarred', 'BOOLEAN DEFAULT 0');
    addColumnToTableIfNotExists(db, 'projects', columnNames, 'isArchived', 'BOOLEAN DEFAULT 0');
    db.exec(`
      UPDATE projects
      SET project_id = ${SQLITE_UUID_SQL}
      WHERE project_id IS NULL OR trim(project_id) = ''
    `);
    return;
  }

  console.log('Running migration: Rebuilding projects table to enforce project_id primary key');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const customProjectNameExpression = columnNames.includes('custom_project_name')
    ? 'custom_project_name'
    : columnNames.includes('custom_workspace_name')
      ? 'custom_workspace_name'
      : 'NULL';

  const isStarredExpression = columnNames.includes('isStarred') ? 'COALESCE(isStarred, 0)' : '0';

  const isArchivedExpression = columnNames.includes('isArchived') ? 'COALESCE(isArchived, 0)' : '0';

  const projectIdExpression = columnNames.includes('project_id')
    ? `CASE
         WHEN project_id IS NULL OR trim(project_id) = ''
         THEN ${SQLITE_UUID_SQL}
         ELSE project_id
       END`
    : SQLITE_UUID_SQL;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS projects__new');
    db.exec(`
      CREATE TABLE projects__new (
        project_id TEXT PRIMARY KEY NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          ${projectPathExpression} AS project_path,
          ${customProjectNameExpression} AS custom_project_name,
          ${isStarredExpression} AS isStarred,
          ${isArchivedExpression} AS isArchived,
          ${projectIdExpression} AS candidate_project_id,
          rowid AS source_rowid
        FROM projects
        WHERE ${projectPathExpression} IS NOT NULL AND trim(${projectPathExpression}) <> ''
      ),
      deduped_paths AS (
        SELECT
          project_path,
          custom_project_name,
          isStarred,
          isArchived,
          candidate_project_id,
          source_rowid,
          ROW_NUMBER() OVER (PARTITION BY project_path ORDER BY source_rowid) AS project_path_rank
        FROM source_rows
      ),
      prepared_rows AS (
        SELECT
          CASE
            WHEN ROW_NUMBER() OVER (PARTITION BY candidate_project_id ORDER BY source_rowid) = 1
            THEN candidate_project_id
            ELSE ${SQLITE_UUID_SQL}
          END AS project_id,
          project_path,
          custom_project_name,
          isStarred,
          isArchived
        FROM deduped_paths
        WHERE project_path_rank = 1
      )
      INSERT INTO projects__new (
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      )
      SELECT
        project_id,
        project_path,
        custom_project_name,
        isStarred,
        isArchived
      FROM prepared_rows
    `);
    db.exec('DROP TABLE projects');
    db.exec('ALTER TABLE projects__new RENAME TO projects');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

const rebuildSessionsTableWithProjectSchema = (db: Database): void => {
  const hasSessions = tableExists(db, 'sessions');
  if (!hasSessions) {
    db.exec(SESSIONS_TABLE_SCHEMA_SQL);
    return;
  }

  const sessionsTableInfo = getTableInfo(db, 'sessions');
  const columnNames = sessionsTableInfo.map((column) => column.name);
  const primaryKeyColumns = sessionsTableInfo
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);

  // If sessions already has project_id, it has been migrated to the new schema
  // The migrateToMultipleProjectsPerDirectory function handles this case
  if (columnNames.includes('project_id')) {
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'jsonl_path', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'created_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'updated_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
    db.exec('UPDATE sessions SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)');
    db.exec('UPDATE sessions SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)');
    return;
  }

  const shouldRebuild =
    !columnNames.includes('project_path') ||
    primaryKeyColumns.length !== 1 ||
    primaryKeyColumns[0] !== 'session_id' ||
    !columnNames.includes('provider');

  if (!shouldRebuild) {
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'jsonl_path', 'TEXT');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'created_at', 'DATETIME');
    addColumnToTableIfNotExists(db, 'sessions', columnNames, 'updated_at', 'DATETIME');
    db.exec('UPDATE sessions SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP)');
    db.exec('UPDATE sessions SET updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)');
    return;
  }

  console.log('Running migration: Rebuilding sessions table to project-based schema');

  const projectPathExpression = columnNames.includes('project_path')
    ? 'project_path'
    : columnNames.includes('workspace_path')
      ? 'workspace_path'
      : 'NULL';

  const providerExpression = columnNames.includes('provider')
    ? "COALESCE(provider, 'claude')"
    : "'claude'";

  const customNameExpression = columnNames.includes('custom_name')
    ? 'custom_name'
    : 'NULL';

  const jsonlPathExpression = columnNames.includes('jsonl_path')
    ? 'jsonl_path'
    : 'NULL';

  const createdAtExpression = columnNames.includes('created_at')
    ? 'COALESCE(created_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  const updatedAtExpression = columnNames.includes('updated_at')
    ? 'COALESCE(updated_at, CURRENT_TIMESTAMP)'
    : 'CURRENT_TIMESTAMP';

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec('DROP TABLE IF EXISTS sessions__new');
    db.exec(`
      CREATE TABLE sessions__new (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id),
        FOREIGN KEY (project_path) REFERENCES projects(project_path)
        ON DELETE SET NULL
        ON UPDATE CASCADE
      )
    `);
    db.exec(`
      WITH source_rows AS (
        SELECT
          session_id,
          ${providerExpression} AS provider,
          ${customNameExpression} AS custom_name,
          ${projectPathExpression} AS project_path,
          ${jsonlPathExpression} AS jsonl_path,
          ${createdAtExpression} AS created_at,
          ${updatedAtExpression} AS updated_at,
          rowid AS source_rowid
        FROM sessions
        WHERE session_id IS NOT NULL AND trim(session_id) <> ''
      ),
      ranked_rows AS (
        SELECT
          session_id,
          provider,
          custom_name,
          project_path,
          jsonl_path,
          created_at,
          updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, source_rowid DESC
          ) AS session_rank
        FROM source_rows
      )
      INSERT INTO sessions__new (
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        provider,
        custom_name,
        project_path,
        jsonl_path,
        created_at,
        updated_at
      FROM ranked_rows
      WHERE session_rank = 1
    `);
    db.exec('DROP TABLE sessions');
    db.exec('ALTER TABLE sessions__new RENAME TO sessions');
    db.exec('COMMIT');
  } catch (migrationError) {
    db.exec('ROLLBACK');
    throw migrationError;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
};

const ensureProjectsForSessionPaths = (db: Database): void => {
  if (!tableExists(db, 'sessions')) {
    return;
  }

  // Check if sessions table still has project_path column (legacy schema)
  const sessionsTableInfo = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  const sessionsColumnNames = sessionsTableInfo.map((col) => col.name);

  if (!sessionsColumnNames.includes('project_path')) {
    // Sessions table has already been migrated to use project_id
    return;
  }

  // Insert projects for sessions that don't have one yet
  // Use INSERT OR IGNORE to handle duplicate project_path (now allowed)
  db.exec(`
    INSERT OR IGNORE INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
    SELECT
      ${SQLITE_UUID_SQL},
      project_path,
      NULL,
      0,
      0
    FROM sessions
    WHERE project_path IS NOT NULL AND trim(project_path) <> ''
      AND project_path NOT IN (SELECT project_path FROM projects WHERE project_path IS NOT NULL)
  `);
};

const migrateExistingDataToFirstAdmin = (db: Database): void => {
  // Get the first admin user (or the first user if no admin exists)
  const adminUser = db
    .prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
    .get() as { id: number } | undefined;

  const firstUser = db
    .prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1')
    .get() as { id: number } | undefined;

  const targetUserId = adminUser?.id ?? firstUser?.id;

  if (!targetUserId) {
    console.log('No users found for data migration');
    return;
  }

  // If no admin exists, promote the first user to admin
  if (!adminUser && firstUser) {
    console.log('Running migration: Promoting first user to admin');
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(firstUser.id);
  }

  // Migrate existing sessions to the target user
  const sessionsUpdated = db
    .prepare('UPDATE sessions SET user_id = ? WHERE user_id IS NULL')
    .run(targetUserId);
  if (sessionsUpdated.changes > 0) {
    console.log(`Running migration: Migrated ${sessionsUpdated.changes} sessions to user ${targetUserId}`);
  }

  // Migrate existing projects to the target user
  const projectsUpdated = db
    .prepare('UPDATE projects SET user_id = ? WHERE user_id IS NULL')
    .run(targetUserId);
  if (projectsUpdated.changes > 0) {
    console.log(`Running migration: Migrated ${projectsUpdated.changes} projects to user ${targetUserId}`);
  }
};

/**
 * Migration to allow multiple projects per directory
 * - Removes UNIQUE constraint from project_path
 * - Adds project_id to sessions table
 */
const migrateToMultipleProjectsPerDirectory = (db: Database): void => {
  // Check if sessions table has project_id column
  const sessionsTableInfo = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  const sessionsColumnNames = sessionsTableInfo.map((col) => col.name);

  if (!sessionsColumnNames.includes('project_id')) {
    console.log('Running migration: Adding project_id to sessions table');

    // Rebuild sessions table with project_id instead of project_path
    db.exec('PRAGMA foreign_keys = OFF');

    try {
      db.exec('BEGIN TRANSACTION');

      // Create new sessions table
      db.exec(`
        CREATE TABLE sessions_new (
          session_id TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'claude',
          custom_name TEXT,
          project_id TEXT,
          jsonl_path TEXT,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (session_id)
        )
      `);

      // Copy data, mapping project_path to project_id
      db.exec(`
        INSERT INTO sessions_new (session_id, provider, custom_name, project_id, jsonl_path, user_id, created_at, updated_at)
        SELECT s.session_id, s.provider, s.custom_name, p.project_id, s.jsonl_path, s.user_id, s.created_at, s.updated_at
        FROM sessions s
        LEFT JOIN projects p ON s.project_path = p.project_path
      `);

      // Drop old table and rename
      db.exec('DROP TABLE sessions');
      db.exec('ALTER TABLE sessions_new RENAME TO sessions');

      db.exec('COMMIT');
      console.log('Migration completed: sessions now uses project_id');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }

    // Create index
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id)');
  }

  // Check if projects table still has UNIQUE on project_path
  const projectsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get() as { sql: string } | undefined;

  if (projectsSql?.sql?.includes('project_path TEXT NOT NULL UNIQUE')) {
    console.log('Running migration: Removing UNIQUE constraint from project_path');

    db.exec('PRAGMA foreign_keys = OFF');

    try {
      db.exec('BEGIN TRANSACTION');

      // Create new projects table without UNIQUE on project_path
      db.exec(`
        CREATE TABLE projects_new (
          project_id TEXT PRIMARY KEY NOT NULL,
          project_path TEXT NOT NULL,
          custom_project_name TEXT DEFAULT NULL,
          isStarred BOOLEAN DEFAULT 0,
          isArchived BOOLEAN DEFAULT 0,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
        )
      `);

      // Copy data
      db.exec(`
        INSERT INTO projects_new SELECT * FROM projects
      `);

      // Drop old table and rename
      db.exec('DROP TABLE projects');
      db.exec('ALTER TABLE projects_new RENAME TO projects');

      db.exec('COMMIT');
      console.log('Migration completed: project_path UNIQUE constraint removed');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
};

export const runMigrations = (db: Database) => {
  try {
    const usersTableInfo = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const userColumnNames = usersTableInfo.map((column) => column.name);

    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_name', 'TEXT');
    addColumnToTableIfNotExists(db, 'users', userColumnNames, 'git_email', 'TEXT');
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'has_completed_onboarding',
      'BOOLEAN DEFAULT 0'
    );
    addColumnToTableIfNotExists(
      db,
      'users',
      userColumnNames,
      'role',
      "TEXT DEFAULT 'user' CHECK(role IN ('admin', 'user'))"
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)');

    db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
    db.exec(USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL);
    db.exec(VAPID_KEYS_TABLE_SCHEMA_SQL);
    db.exec(PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL);
    db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)');

    db.exec(PROJECTS_TABLE_SCHEMA_SQL);
    rebuildProjectsTableWithPrimaryKeySchema(db);

    migrateLegacyWorkspaceTableIntoProjects(db);
    rebuildSessionsTableWithProjectSchema(db);
    migrateLegacySessionNames(db);
    ensureProjectsForSessionPaths(db);

    db.exec('CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id)');
    // Index on project_path only if column exists (legacy schema)
    // After migrateToMultipleProjectsPerDirectory, sessions uses project_id instead
    const sessionsInfoForIndex = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    const sessionsColumnsForIndex = sessionsInfoForIndex.map((col) => col.name);
    if (sessionsColumnsForIndex.includes('project_path')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_starred ON projects(isStarred)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_is_archived ON projects(isArchived)');

    // Multi-tenant migrations: Add user_id to sessions and projects tables
    const sessionsTableInfo = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    const sessionsColumnNames = sessionsTableInfo.map((column) => column.name);
    addColumnToTableIfNotExists(
      db,
      'sessions',
      sessionsColumnNames,
      'user_id',
      'INTEGER REFERENCES users(id) ON DELETE CASCADE'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)');

    const projectsTableInfo = db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
    const projectsColumnNames = projectsTableInfo.map((column) => column.name);
    addColumnToTableIfNotExists(
      db,
      'projects',
      projectsColumnNames,
      'user_id',
      'INTEGER REFERENCES users(id) ON DELETE CASCADE'
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)');

    // Add home_dir column to users table for PAM mode
    const usersTableInfoForHomeDir = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const usersColumnNamesForHomeDir = usersTableInfoForHomeDir.map((column) => column.name);
    addColumnToTableIfNotExists(db, 'users', usersColumnNamesForHomeDir, 'home_dir', 'TEXT');

    // Agent config table
    db.exec(AGENT_CONFIG_TABLE_SCHEMA_SQL);

    // User agent config table (per-user configuration)
    db.exec(USER_AGENT_CONFIG_TABLE_SCHEMA_SQL);

    // Migration: Allow multiple projects per directory
    // 1. Remove UNIQUE constraint from project_path
    // 2. Add project_id to sessions table
    migrateToMultipleProjectsPerDirectory(db);

    db.exec('DROP INDEX IF EXISTS idx_session_names_lookup');
    db.exec('DROP INDEX IF EXISTS idx_sessions_workspace_path');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_is_starred');
    db.exec('DROP INDEX IF EXISTS idx_workspace_original_paths_workspace_id');

    if (tableExists(db, 'workspace_original_paths')) {
      console.log('Running migration: Dropping legacy workspace_original_paths table');
      db.exec('DROP TABLE workspace_original_paths');
    }

    db.exec(LAST_SCANNED_AT_SQL);

    // Migrate existing data to first admin user
    migrateExistingDataToFirstAdmin(db);

    console.log('Database migrations completed successfully');
  } catch (error: any) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};
