import { spawn } from 'child_process';
import os from 'os';
import { getCurrentUserHomeDir } from '../claude-sdk.js';

function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { uid, gid, ...restOptions } = options;
    const spawnOptions = {
      ...restOptions,
      shell: false,
      env: {
        ...process.env,
        HOME: getCurrentUserHomeDir() || process.env.HOME,
        ...(options.env || {}),
      },
    };
    if (typeof uid === 'number' && typeof gid === 'number') {
      spawnOptions.uid = uid;
      spawnOptions.gid = gid;
    }
    const child = spawn(command, args, spawnOptions);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => { reject(error); });
    child.on('close', (code) => {
      if (code === 0) { resolve({ stdout, stderr }); return; }
      reject(new Error(`Command failed with code ${code}: ${stderr}`));
    });
  });
}

/**
 * Read git configuration from system's global git config
 * @returns {Promise<{git_name: string|null, git_email: string|null}>}
 */
export async function getSystemGitConfig(uid, gid) {
  try {
    const [nameResult, emailResult] = await Promise.all([
      spawnAsync('git', ['config', '--global', 'user.name'], { uid, gid }).catch(() => ({ stdout: '' })),
      spawnAsync('git', ['config', '--global', 'user.email'], { uid, gid }).catch(() => ({ stdout: '' }))
    ]);

    return {
      git_name: nameResult.stdout.trim() || null,
      git_email: emailResult.stdout.trim() || null
    };
  } catch (error) {
    return { git_name: null, git_email: null };
  }
}
