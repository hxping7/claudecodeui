import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import { getCurrentUserHomeDir } from '@/claude-sdk.js';
import { runInRequestContext } from '@/requestContext.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
  isPlainShell?: boolean;
};

type PtySessionEntry = {
  pty: IPty;
  ws: WebSocket | null;
  buffer: string[];
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
};

const ptySessionsMap = new Map<string, PtySessionEntry>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;

type ShellWebSocketDependencies = {
  getSessionById: (sessionId: string) => { cliSessionId?: string } | null | undefined;
  stripAnsiSequences: (content: string) => string;
  normalizeDetectedUrl: (url: string) => string | null;
  extractUrlsFromText: (content: string) => string[];
  shouldAutoOpenUrlFromOutput: (content: string) => boolean;
};

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
}

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 */
function buildShellCommand(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');
  const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
  const isPlainShell =
    readBoolean(message.isPlainShell) ||
    (!!initialCommand && !hasSession) ||
    provider === 'plain-shell';

  if (isPlainShell) {
    return initialCommand;
  }

  if (provider === 'cursor') {
    if (hasSession && sessionId) {
      return `cursor-agent --resume="${sessionId}"`;
    }
    return 'cursor-agent';
  }

  if (provider === 'codex') {
    if (hasSession && sessionId) {
      if (os.platform() === 'win32') {
        return `codex resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { codex }`;
      }
      return `codex resume "${sessionId}" || codex`;
    }
    return 'codex';
  }

  if (provider === 'gemini') {
    const command = initialCommand || 'gemini';
    let resumeId = sessionId;
    if (hasSession && sessionId) {
      try {
        const existingSession = dependencies.getSessionById(sessionId);
        if (existingSession && existingSession.cliSessionId) {
          resumeId = existingSession.cliSessionId;
          if (!safeSessionIdPattern.test(resumeId)) {
            resumeId = '';
          }
        }
      } catch (error) {
        console.error('Failed to get Gemini CLI session ID:', error);
      }
    }

    if (hasSession && resumeId) {
      return `${command} --resume "${resumeId}"`;
    }
    return command;
  }

  if (provider === 'tokenc') {
    if (hasSession && sessionId) {
      if (os.platform() === 'win32') {
        return `tokenc --resume="${sessionId}"; if ($LASTEXITCODE -ne 0) { tokenc }`;
      }
      return `tokenc --resume="${sessionId}" || tokenc`;
    }
    return 'tokenc';
  }

  const command = initialCommand || 'claude';
  if (hasSession && sessionId) {
    if (os.platform() === 'win32') {
      return `claude --resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { claude }`;
    }
    return `claude --resume "${sessionId}" || claude`;
  }
  return command;
}

/**
 * Handles websocket connections used by the standalone shell terminal UI.
 */
export function handleShellConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ShellWebSocketDependencies
): void {
  console.log('[INFO] Shell websocket connected');

  const shellUid = typeof request?.user?.uid === 'number' ? request.user.uid : undefined;
  const shellGid = typeof request?.user?.gid === 'number' ? request.user.gid : undefined;

  console.log(`[ShellWebSocket] User identity info:
    username: ${request?.user?.username || 'unknown'}
    uid: ${shellUid} (type: ${typeof request?.user?.uid}, raw value: ${request?.user?.uid})
    gid: ${shellGid} (type: ${typeof request?.user?.gid}, raw value: ${request?.user?.gid})
    home_dir: ${request?.user?.home_dir || 'not set'}
    full user object keys: ${request?.user ? Object.keys(request.user).join(', ') : 'no user'}`);

  if (shellUid !== undefined && shellGid !== undefined) {
    console.log(`[INFO] Shell PTY will run as uid=${shellUid}, gid=${shellGid}`);
  } else {
    console.warn(`[WARN] Shell PTY missing user identity! uid=${shellUid}, gid=${shellGid}. Files will be created with server process permissions.`);
  }

  (ws as any).uid = shellUid;
  (ws as any).gid = shellGid;
  (ws as any).home_dir = request?.user?.home_dir || null;
  (ws as any).username = request?.user?.username || null;

  let shellProcess: IPty | null = null;
  let ptySessionKey: string | null = null;
  let urlDetectionBuffer = '';
  const announcedAuthUrls = new Set<string>();

  ws.on('message', async (rawMessage) => {
    const store = {
      homeDir: (ws as any).home_dir || null,
      uid: (ws as any).uid,
      gid: (ws as any).gid,
    };
    runInRequestContext(store, async () => {
    try {
      const data = parseShellMessage(rawMessage);
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      if (data.type === 'init') {
        const projectPath = readString(data.projectPath, process.cwd());
        const sessionId = readString(data.sessionId) || null;
        const hasSession = readBoolean(data.hasSession);
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const isPlainShell =
          readBoolean(data.isPlainShell) ||
          (!!initialCommand && !hasSession) ||
          provider === 'plain-shell';

        urlDetectionBuffer = '';
        announcedAuthUrls.clear();

        const isLoginCommand =
          !!initialCommand &&
          (initialCommand.includes('setup-token') ||
            initialCommand.includes('cursor-agent login') ||
            initialCommand.includes('auth login'));

        const commandSuffix =
          isPlainShell && initialCommand
            ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
            : '';
        ptySessionKey = `${projectPath}_${sessionId ?? 'default'}${commandSuffix}`;

        if (isLoginCommand) {
          const oldSession = ptySessionsMap.get(ptySessionKey);
          if (oldSession) {
            if (oldSession.timeoutId) {
              clearTimeout(oldSession.timeoutId);
            }
            oldSession.pty.kill();
            ptySessionsMap.delete(ptySessionKey);
          }
        }

        const existingSession = isLoginCommand ? null : ptySessionsMap.get(ptySessionKey);
        if (existingSession) {
          shellProcess = existingSession.pty;
          if (existingSession.timeoutId) {
            clearTimeout(existingSession.timeoutId);
          }

          ws.send(
            JSON.stringify({
              type: 'output',
              data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
            })
          );

          if (existingSession.buffer.length > 0) {
            existingSession.buffer.forEach((bufferedData) => {
              ws.send(
                JSON.stringify({
                  type: 'output',
                  data: bufferedData,
                })
              );
            });
          }

          existingSession.ws = ws;
          return;
        }

        const resolvedProjectPath = path.resolve(projectPath);
        try {
          const stats = fs.statSync(resolvedProjectPath);
          if (!stats.isDirectory()) {
            throw new Error('Not a directory');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          return;
        }

        const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
        if (sessionId && !safeSessionIdPattern.test(sessionId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
          return;
        }

        const shellCommand = buildShellCommand(data, dependencies);
        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        const shellArgs =
          os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];
        const termCols = readNumber(data.cols, 80);
        const termRows = readNumber(data.rows, 24);

        const userHome = getCurrentUserHomeDir();

        const ptyOptions: Record<string, unknown> = {
          name: 'xterm-256color',
          cols: termCols,
          rows: termRows,
          cwd: resolvedProjectPath,
          env: {
            ...process.env,
            HOME: userHome || process.env.HOME,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FORCE_COLOR: '3',
          },
        };

        if (shellUid !== undefined) {
          ptyOptions.uid = shellUid;
        }
        if (shellGid !== undefined) {
          ptyOptions.gid = shellGid;
        }

        console.log(`[ShellWebSocket] Spawning PTY process:
          shell: ${shell}
          args: ${JSON.stringify(shellArgs)}
          cwd: ${resolvedProjectPath}
          uid: ${ptyOptions.uid} (will use ${typeof ptyOptions.uid !== 'undefined' ? 'user identity' : 'process default'})
          gid: ${ptyOptions.gid} (will use ${typeof ptyOptions.gid !== 'undefined' ? 'user identity' : 'process default'})
          env.HOME: ${(ptyOptions.env as Record<string, string>).HOME}`);

        shellProcess = pty.spawn(shell, shellArgs, ptyOptions as pty.IPtyForkOptions);

        console.log(`[ShellWebSocket] PTY spawned successfully. PID: ${shellProcess.pid}`);

        ptySessionsMap.set(ptySessionKey, {
          pty: shellProcess,
          ws,
          buffer: [],
          timeoutId: null,
          projectPath,
          sessionId,
        });

        shellProcess.onData((chunk) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (!session) {
            return;
          }

          if (session.buffer.length < 5000) {
            session.buffer.push(chunk);
          } else {
            session.buffer.shift();
            session.buffer.push(chunk);
          }

          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            let outputData = chunk;
            const cleanChunk = dependencies.stripAnsiSequences(chunk);
            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

            outputData = outputData.replace(
              /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
              '[INFO] Opening in browser: $1'
            );

            const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
              const normalizedUrl = dependencies.normalizeDetectedUrl(detectedUrl);
              if (!normalizedUrl) {
                return;
              }

              const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
              if (isNewUrl) {
                announcedAuthUrls.add(normalizedUrl);
                session.ws?.send(
                  JSON.stringify({
                    type: 'auth_url',
                    url: normalizedUrl,
                    autoOpen,
                  })
                );
              }
            };

            const normalizedDetectedUrls = dependencies.extractUrlsFromText(urlDetectionBuffer)
              .map((url) => dependencies.normalizeDetectedUrl(url))
              .filter((url): url is string => Boolean(url));

            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
              (url, _, urls) =>
                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
            );

            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

            if (
              dependencies.shouldAutoOpenUrlFromOutput(cleanChunk) &&
              dedupedDetectedUrls.length > 0
            ) {
              const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                current.length > longest.length ? current : longest
              );
              emitAuthUrl(bestUrl, true);
            }

            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: outputData,
              })
            );
          }
        });

        shellProcess.onExit((exitCode) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${
                  exitCode.signal != null ? ` (${exitCode.signal})` : ''
                }\x1b[0m\r\n`,
              })
            );
          }

          if (session?.timeoutId) {
            clearTimeout(session.timeoutId);
          }

          ptySessionsMap.delete(ptySessionKey);
          shellProcess = null;
        });

        let welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
        if (!isPlainShell) {
          const providerName =
            provider === 'cursor'
              ? 'Cursor'
              : provider === 'codex'
                ? 'Codex'
                : provider === 'gemini'
                  ? 'Gemini'
                  : 'Claude';
          welcomeMsg = hasSession
            ? `\x1b[36mResuming ${providerName} session ${sessionId} in: ${projectPath}\x1b[0m\r\n`
            : `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
        }

        ws.send(
          JSON.stringify({
            type: 'output',
            data: welcomeMsg,
          })
        );
        return;
      }

      if (data.type === 'input') {
        if (shellProcess) {
          shellProcess.write(readString(data.data));
        }
        return;
      }

      if (data.type === 'resize') {
        if (shellProcess) {
          shellProcess.resize(readNumber(data.cols, 80), readNumber(data.rows, 24));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Shell WebSocket error:', message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n`,
          })
        );
      }
    }
    });
  });

  ws.on('close', () => {
    if (!ptySessionKey) {
      return;
    }

    const session = ptySessionsMap.get(ptySessionKey);
    if (!session) {
      return;
    }

    session.ws = null;
    session.timeoutId = setTimeout(() => {
      session.pty.kill();
      ptySessionsMap.delete(ptySessionKey as string);
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}
