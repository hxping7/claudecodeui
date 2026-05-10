import { exec } from 'child_process';
import { promisify } from 'util';
import pam from 'authenticate-pam';

const execAsync = promisify(exec);

/**
 * Linux PAM Authentication Module
 *
 * Supports two authentication modes:
 * - 'database': Use internal database (default)
 * - 'linux': Use Linux system users with PAM password verification
 */

export type AuthMode = 'database' | 'linux';

/**
 * Check if a Linux user exists on the system
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
  } catch {
    return null;
  }
}

/**
 * Validate Linux user credentials using PAM
 * Uses the authenticate-pam npm package for proper PAM authentication
 * Does NOT require root - can run as any user with PAM access
 */
export async function authenticateWithLinux(username: string, password: string): Promise<{
  success: boolean;
  homeDir?: string;
  uid?: number;
  gid?: number;
  error?: string;
}> {
  // First check if user exists
  const userInfo = await getLinuxUserInfo(username);
  if (!userInfo) {
    return { success: false, error: 'User not found' };
  }

  try {
    // Use PAM for authentication - this performs real PAM verification
    // Does NOT require root privileges
    await new Promise<void>((resolve, reject) => {
      pam.authenticate(username, password, (err: Error | null) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Authentication successful
    return {
      success: true,
      homeDir: userInfo.homeDir,
      uid: userInfo.uid,
      gid: userInfo.gid,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Authentication failed';
    return { success: false, error: errorMessage };
  }
}

/**
 * Get user's workspace directory based on auth mode
 */
export async function getUserWorkspace(username: string, authMode: AuthMode): Promise<string> {
  if (authMode === 'linux') {
    const userInfo = await getLinuxUserInfo(username);
    if (userInfo) {
      return userInfo.homeDir;
    }
  }

  return process.env.WORKSPACES_ROOT || '/home';
}