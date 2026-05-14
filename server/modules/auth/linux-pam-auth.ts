import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { randomBytes } from 'crypto';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Linux PAM Authentication Module
 *
 * Supports two authentication modes:
 * - 'database': Use internal database (default)
 * - 'linux': Use Linux system users with PAM password verification
 */

export type AuthMode = 'database' | 'linux';

/**
 * Validate username conforms to Linux username rules to prevent command injection.
 * Valid usernames: start with letter/underscore, contain only [a-z0-9_-], optional trailing $.
 */
function validateUsername(username: string): boolean {
  if (!username || typeof username !== 'string') return false;
  return /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}\$?$/.test(username);
}

/**
 * Check if a Linux user exists on the system
 */
export async function getLinuxUserInfo(username: string): Promise<{
  exists: boolean;
  homeDir: string;
  uid: number;
  gid: number;
} | null> {
  if (!validateUsername(username)) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('getent', ['passwd', username], { encoding: 'utf8' });

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
 * Validate Linux user credentials using su command
 * This performs real PAM authentication via the su command
 * Does NOT require root - runs as the web server user with su access
 */
export async function authenticateWithLinux(username: string, password: string): Promise<{
  success: boolean;
  homeDir?: string;
  uid?: number;
  gid?: number;
  error?: string;
}> {
  if (!validateUsername(username)) {
    return { success: false, error: 'Invalid username' };
  }

  // First check if user exists
  const userInfo = await getLinuxUserInfo(username);
  if (!userInfo) {
    return { success: false, error: 'User not found' };
  }

  try {
    // Escape password for shell safety
    const safePassword = password.replace(/'/g, "'\\''");
    const verifyToken = randomBytes(8).toString('hex');

    // Use su to validate password - this performs real PAM authentication
    const cmd = `echo '${safePassword}' | su - ${username} -c "echo '${verifyToken}'" 2>/dev/null`;

    const { stdout } = await execAsync(cmd, {
      encoding: 'utf8',
      timeout: 10000,
    });

    if (stdout.trim() === verifyToken) {
      return {
        success: true,
        homeDir: userInfo.homeDir,
        uid: userInfo.uid,
        gid: userInfo.gid,
      };
    }

    return { success: false, error: 'Invalid password' };
  } catch {
    return { success: false, error: 'Authentication failed' };
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