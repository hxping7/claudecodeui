import os from 'node:os';
import path from 'node:path';

/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = process.env.VITE_IS_PLATFORM === 'true';

/**
 * Superadmin home directory in Platform mode.
 * Configurable via SUPERADMIN_HOME_DIR env var; defaults to ~/.cloudcli/superadmin-workspace.
 */
export const SUPERADMIN_HOME_DIR =
  process.env.SUPERADMIN_HOME_DIR ||
  path.join(os.homedir(), '.cloudcli', 'superadmin-workspace');