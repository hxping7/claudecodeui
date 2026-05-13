/**
 * File operations executed as a specific user via child_process.spawn.
 *
 * When the server runs as root (e.g. systemd service), all direct fs operations
 * create files owned by root. This module wraps common file operations so they
 * execute with the authenticated user's uid/gid, ensuring correct ownership.
 */

import { spawn } from 'child_process';

/**
 * Run a Node.js script as a specific user.
 * @param {string} script - JavaScript code to execute
 * @param {number} uid
 * @param {number} gid
 * @returns {Promise<void>}
 */
function runScriptAsUser(script, uid, gid) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      uid,
      gid,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn process as uid=${uid}: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with code ${code} as uid=${uid}: ${stderr}`));
      }
    });
  });
}

/**
 * Create a directory as a specific user.
 * @param {string} dirPath - Absolute path to create
 * @param {number} uid
 * @param {number} gid
 * @param {object} [options] - { recursive?: boolean }
 * @returns {Promise<void>}
 */
export async function mkdirAsUser(dirPath, uid, gid, options = {}) {
  const recursive = options.recursive !== false;
  const script = `
    const fs = require('fs');
    const dir = ${JSON.stringify(dirPath)};
    const recursive = ${recursive};
    fs.mkdirSync(dir, { recursive });
  `;
  console.log(`[fileOpsAsUser] mkdir as uid=${uid}, gid=${gid}: ${dirPath} (recursive=${recursive})`);
  await runScriptAsUser(script, uid, gid);
}

/**
 * Write a file as a specific user.
 * @param {string} filePath - Absolute path
 * @param {string} content - File content
 * @param {number} uid
 * @param {number} gid
 * @returns {Promise<void>}
 */
export async function writeFileAsUser(filePath, content, uid, gid) {
  const script = `
    const fs = require('fs');
    const path = require('path');
    const filePath = ${JSON.stringify(filePath)};
    const content = ${JSON.stringify(content)};
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  `;
  console.log(`[fileOpsAsUser] writeFile as uid=${uid}, gid=${gid}: ${filePath}`);
  await runScriptAsUser(script, uid, gid);
}

/**
 * Copy a file as a specific user.
 * @param {string} src - Source path
 * @param {string} dest - Destination path
 * @param {number} uid
 * @param {number} gid
 * @returns {Promise<void>}
 */
export async function copyFileAsUser(src, dest, uid, gid) {
  const script = `
    const fs = require('fs');
    const path = require('path');
    const src = ${JSON.stringify(src)};
    const dest = ${JSON.stringify(dest)};
    const destDir = path.dirname(dest);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
  `;
  console.log(`[fileOpsAsUser] copyFile as uid=${uid}, gid=${gid}: ${src} -> ${dest}`);
  await runScriptAsUser(script, uid, gid);
}

/**
 * Check if a path exists as a specific user.
 * @param {string} checkPath - Absolute path
 * @param {number} uid
 * @param {number} gid
 * @returns {Promise<boolean>}
 */
export async function existsAsUser(checkPath, uid, gid) {
  const script = `
    const fs = require('fs');
    const p = ${JSON.stringify(checkPath)};
    try {
      fs.accessSync(p);
      process.stdout.write('EXISTS');
    } catch (e) {
      process.stdout.write('NOT_EXISTS');
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      uid,
      gid,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.includes('EXISTS'));
      } else {
        reject(new Error(`exists check failed: ${stderr}`));
      }
    });
  });
}

/**
 * Extract uid/gid from the request user object.
 * Returns null if not available.
 * @param {object} req - Express request
 * @returns {{ uid: number, gid: number } | null}
 */
export function getUserIdentity(req) {
  const uid = req.user?.uid;
  const gid = req.user?.gid;
  if (typeof uid === 'number' && typeof gid === 'number') {
    return { uid, gid };
  }
  return null;
}