import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { getConnection } from '@/modules/database/connection.js';
import type { CreateProjectPathResult, ProjectRepositoryRow } from '@/shared/types.js';
import { normalizeProjectPath } from '@/shared/utils.js';

function normalizeProjectDisplayName(projectPath: string, customProjectName: string | null): string {
    const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
    if (trimmedCustomName.length > 0) {
        return trimmedCustomName;
    }

    const directoryName = path.basename(projectPath);
    return directoryName || projectPath;
}

export const projectsDb = {
    /**
     * Create a new project. Multiple projects can share the same directory path.
     * Each project has a unique project_id and can have a different custom_project_name.
     */
    createProjectPath(projectPath: string, customProjectName: string | null = null, userId?: number): CreateProjectPathResult {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const normalizedProjectName = normalizeProjectDisplayName(normalizedProjectPath, customProjectName);
        const projectId = randomUUID();

        const row = db.prepare(`
            INSERT INTO projects (project_id, project_path, custom_project_name, user_id, isArchived)
            VALUES (?, ?, ?, ?, 0)
            RETURNING project_id, project_path, custom_project_name, isStarred, isArchived, user_id
        `).get(projectId, normalizedProjectPath, normalizedProjectName, userId ?? null) as ProjectRepositoryRow | undefined;

        if (row) {
            return {
                outcome: 'created',
                project: row,
            };
        }

        return {
            outcome: 'active_conflict',
            project: null,
        };
    },

    getProjectPath(projectPath: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
            FROM projects
            WHERE project_path = ? AND isArchived = 0
            LIMIT 1
        `).get(normalizedProjectPath) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    getProjectById(projectId: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /**
     * Resolve the absolute project directory from a database project_id.
     */
    getProjectPathById(projectId: string): string | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_path
            FROM projects
            WHERE project_id = ?
        `).get(projectId) as Pick<ProjectRepositoryRow, 'project_path'> | undefined;

        return row?.project_path ?? null;
    },

    getProjectPaths(): ProjectRepositoryRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
            FROM projects
            WHERE isArchived = 0
        `).all() as ProjectRepositoryRow[];
    },

    /**
     * Get all projects for a given directory path.
     * Returns multiple projects if they share the same path.
     */
    getProjectsByPath(projectPath: string): ProjectRepositoryRow[] {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
            FROM projects
            WHERE project_path = ? AND isArchived = 0
        `).all(normalizedProjectPath) as ProjectRepositoryRow[];
    },

    getCustomProjectName(projectPath: string): string | null {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        const row = db.prepare(`
            SELECT custom_project_name
            FROM projects
            WHERE project_path = ?
            LIMIT 1
        `).get(normalizedProjectPath) as Pick<ProjectRepositoryRow, 'custom_project_name'> | undefined;

        return row?.custom_project_name ?? null;
    },

    updateCustomProjectName(projectPath: string, customProjectName: string | null): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET custom_project_name = ?
            WHERE project_path = ?
        `).run(customProjectName, normalizedProjectPath);
    },

    updateCustomProjectNameById(projectId: string, customProjectName: string | null): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET custom_project_name = ?
            WHERE project_id = ?
        `).run(customProjectName, projectId);
    },

    updateProjectIsStarred(projectPath: string, isStarred: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_path = ?
        `).run(isStarred ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsStarredById(projectId: string, isStarred: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isStarred = ?
            WHERE project_id = ?
        `).run(isStarred ? 1 : 0, projectId);
    },

    updateProjectIsArchived(projectPath: string, isArchived: boolean): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_path = ?
        `).run(isArchived ? 1 : 0, normalizedProjectPath);
    },

    updateProjectIsArchivedById(projectId: string, isArchived: boolean): void {
        const db = getConnection();
        db.prepare(`
            UPDATE projects
            SET isArchived = ?
            WHERE project_id = ?
        `).run(isArchived ? 1 : 0, projectId);
    },

    deleteProjectPath(projectPath: string): void {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);
        db.prepare(`
            DELETE FROM projects
            WHERE project_path = ?
        `).run(normalizedProjectPath);
    },

    deleteProjectById(projectId: string): void {
        const db = getConnection();
        db.prepare(`
            DELETE FROM projects
            WHERE project_id = ?
        `).run(projectId);
    },

    // ===============================
    // Multi-tenant methods (user isolation)
    // ===============================

    /** Get all project paths for a specific user */
    getProjectPathsByUserId(userId: number): ProjectRepositoryRow[] {
        const db = getConnection();
        return db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
            FROM projects
            WHERE user_id = ? AND isArchived = 0
        `).all(userId) as ProjectRepositoryRow[];
    },

    /** Get project by ID only if it belongs to the user */
    getProjectByIdAndUserId(userId: number, projectId: string): ProjectRepositoryRow | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_id, project_path, custom_project_name, isStarred, isArchived, user_id
            FROM projects
            WHERE project_id = ? AND user_id = ?
        `).get(projectId, userId) as ProjectRepositoryRow | undefined;

        return row ?? null;
    },

    /** Delete project only if it belongs to the user */
    deleteProjectByIdAndUserId(userId: number, projectId: string): boolean {
        const db = getConnection();
        return db.prepare('DELETE FROM projects WHERE project_id = ? AND user_id = ?').run(projectId, userId).changes > 0;
    },

    /** Get project path by ID only if it belongs to the user (returns null if not found or not owned) */
    getProjectPathByIdAndUserId(userId: number, projectId: string): string | null {
        const db = getConnection();
        const row = db.prepare(`
            SELECT project_path
            FROM projects
            WHERE project_id = ? AND user_id = ?
        `).get(projectId, userId) as Pick<ProjectRepositoryRow, 'project_path'> | undefined;

        return row?.project_path ?? null;
    },

    /**
     * Check if a directory path is already used by any project for this user.
     * Returns true if the path is already in use.
     */
    isProjectPathInUse(projectPath: string, userId?: number): boolean {
        const db = getConnection();
        const normalizedProjectPath = normalizeProjectPath(projectPath);

        if (userId) {
            const row = db.prepare(`
                SELECT COUNT(*) as count
                FROM projects
                WHERE project_path = ? AND user_id = ? AND isArchived = 0
            `).get(normalizedProjectPath, userId) as { count: number } | undefined;
            return (row?.count ?? 0) > 0;
        }

        const row = db.prepare(`
            SELECT COUNT(*) as count
            FROM projects
            WHERE project_path = ? AND isArchived = 0
        `).get(normalizedProjectPath) as { count: number } | undefined;
        return (row?.count ?? 0) > 0;
    },
};
