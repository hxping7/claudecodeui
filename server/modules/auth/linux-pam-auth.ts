import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Linux PAM Authentication Module
 *
 * Supports two authentication modes:
 * - 'database': Use internal database (default)
 * - 'linux': Use Linux system users with getent
 */

export type AuthMode = 'database' | 'linux';

/**
 * Check if a Linux user exists on the system
 * @param username - The username to check
 * @returns Promise<{exists: boolean, homeDir: string, uid: number, gid: number}>
 */
export async function getLinuxUserInfo(username: string): Promise<{
  exists: boolean;
  homeDir: string;
  uid: number;
  gid: number;
} | null> {
  try {
    const { stdout } = await execAsync(`getent passwd ${username}`, { encoding: 'utf8' });

    if (!stdout || !stdout.trim()) {
      return null;
    }

    // Format: username:password:uid:gid:gecos:home:shell
    const parts = stdout.trim().split(':');
    if (parts.length < 7) {
      return null;
    }

    return {
      exists: true,
      homeDir: parts[5],
      uid: parseInt(parts[2], 10),
      gid: parseInt(parts[3], 10),
    };
  } catch (error) {
    // User not found
    return null;
  }
}

/**
 * Validate Linux user credentials using PAM
 * Note: This is a simplified version that checks if user exists
 * For full password verification, a proper PAM module would be needed
 *
 * @param username - The username
 * @param password - The password (optional, for future use)
 * @returns Promise<boolean>
 */
export async function authenticateWithLinux(username: string, _password?: string): Promise<boolean> {
  const userInfo = await getLinuxUserInfo(username);
  return userInfo !== null;
}

/**
 * Get the authentication mode from app config
 */
export function getAuthMode(): AuthMode {
  // This will be read from appConfigDb in the actual implementation
  return process.env.AUTH_MODE as AuthMode || 'database';
}

/**
 * Get user's workspace directory based on auth mode
 * - For Linux auth: use user's home directory
 * - For database auth: use shared workspaces root
 */
export async function getUserWorkspace(username: string, authMode: AuthMode): Promise<string> {
  if (authMode === 'linux') {
    const userInfo = await getLinuxUserInfo(username);
    if (userInfo) {
      return userInfo.homeDir;
    }
  }

  // Fall back to shared workspaces directory
  // This would be configured in app settings
  return process.env.WORKSPACES_ROOT || '/home';
}