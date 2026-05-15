import { spawn } from 'child_process';
import crossSpawn from 'cross-spawn';
import os from 'os';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { createNormalizedMessage } from './shared/utils.js';
import { getCurrentUserHomeDir } from './claude-sdk.js';

const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

let activeTokencProcesses = new Map();
let activeTokencWriters = new Map();
let pendingPermissionRequests = new Map();

const WORKSPACE_TRUST_PATTERNS = [
  /workspace trust required/i,
  /do you trust the contents of this directory/i,
  /working with untrusted contents/i,
  /pass --trust,\s*--yolo,\s*or -f/i
];

function isWorkspaceTrustPrompt(text = '') {
  if (!text || typeof text !== 'string') {
    return false;
  }

  return WORKSPACE_TRUST_PATTERNS.some((pattern) => pattern.test(text));
}

async function spawnTokenc(command, options = {}, ws) {
  return new Promise(async (resolve, reject) => {
    const { sessionId, projectPath, cwd, resume, toolsSettings, skipPermissions, permissionMode, model, sessionSummary } = options;
    let capturedSessionId = sessionId;
    let sessionCreatedSent = false;
    let hasRetriedWithTrust = false;
    let settled = false;

    const settings = toolsSettings || {
      allowedShellCommands: [],
      skipPermissions: false
    };

    const baseArgs = [];

    if (sessionId) {
      baseArgs.push('--resume=' + sessionId);
    }

    if (command && command.trim()) {
      baseArgs.push('-p', command);

      if (!sessionId && model) {
        baseArgs.push('--model', model);
      }

      baseArgs.push('--output-format', 'stream-json');
      baseArgs.push('--verbose');
    }

    if (permissionMode === 'bypassPermissions') {
      baseArgs.push('--allow-dangerously-skip-permissions');
      baseArgs.push('--dangerously-skip-permissions');
      console.log('Using --dangerously-skip-permissions (bypassPermissions)');
    } else if (permissionMode) {
      const tokencModeMap = {
        'default': 'default',
        'auto': 'bypassCwd',
        'plan': 'plan',
        'acceptEdits': 'acceptEdits',
      };
      const mappedMode = tokencModeMap[permissionMode] || permissionMode;
      baseArgs.push('--permission-mode', mappedMode);
      console.log('Using permission mode:', mappedMode);
    } else if (skipPermissions || settings.skipPermissions) {
      baseArgs.push('--allow-dangerously-skip-permissions');
      baseArgs.push('--dangerously-skip-permissions');
      console.log('Using --dangerously-skip-permissions');
    }

    const workingDir = cwd || projectPath || process.cwd();

    const processKey = capturedSessionId || Date.now().toString();

    const settleOnce = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    const runTokencProcess = (args, runReason = 'initial') => {
      const isTrustRetry = runReason === 'trust-retry';
      let runSawWorkspaceTrustPrompt = false;
      let stdoutLineBuffer = '';
      let terminalNotificationSent = false;

      const notifyTerminalState = ({ code = null, error = null } = {}) => {
        if (terminalNotificationSent) {
          return;
        }

        terminalNotificationSent = true;

        const finalSessionId = capturedSessionId || sessionId || processKey;
        if (code === 0 && !error) {
          notifyRunStopped({
            userId: ws?.userId || null,
            provider: 'tokenc',
            sessionId: finalSessionId,
            sessionName: sessionSummary,
            stopReason: 'completed'
          });
          return;
        }

        notifyRunFailed({
          userId: ws?.userId || null,
          provider: 'tokenc',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          error: error || `Tokenc CLI exited with code ${code}`
        });
      };

      if (isTrustRetry) {
        console.log('Retrying Tokenc CLI with --trust after workspace trust prompt');
      }

      console.log('Spawning Tokenc CLI:', 'tokenc', args.join(' '));
      console.log('Working directory:', workingDir);
      console.log('Session info - Input sessionId:', sessionId, 'Resume:', resume);

      const tokencProcess = spawnFunction('tokenc', args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: options.homeDir || getCurrentUserHomeDir() || process.env.HOME },
        uid: options.userUid,
        gid: options.userGid,
      });

      activeTokencProcesses.set(processKey, tokencProcess);

      const shouldSuppressForTrustRetry = (text) => {
        if (hasRetriedWithTrust || args.includes('--trust')) {
          return false;
        }
        if (!isWorkspaceTrustPrompt(text)) {
          return false;
        }

        runSawWorkspaceTrustPrompt = true;
        return true;
      };

      const processTokencOutputLine = async (line) => {
        if (!line || !line.trim()) {
          return;
        }

        try {
          const response = JSON.parse(line);
          console.log('Parsed JSON response:', response);

          switch (response.type) {
            case 'system':
              if (response.subtype === 'init') {
                if (response.session_id && !capturedSessionId) {
                  capturedSessionId = response.session_id;
                  console.log('Captured session ID:', capturedSessionId);

                  if (processKey !== capturedSessionId) {
                    activeTokencProcesses.delete(processKey);
                    activeTokencProcesses.set(capturedSessionId, tokencProcess);
                  }

                  if (ws.setSessionId && typeof ws.setSessionId === 'function') {
                    ws.setSessionId(capturedSessionId);
                  }

                  if (!activeTokencWriters.has(capturedSessionId)) {
                    activeTokencWriters.set(capturedSessionId, ws);
                  }

                  if (!sessionId && !sessionCreatedSent) {
                    sessionCreatedSent = true;
                    ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, model: response.model, cwd: response.cwd, sessionId: capturedSessionId, provider: 'tokenc' }));
                  }
                }
              } else if (response.subtype === 'status' || response.subtype === 'hook_started' || response.subtype === 'hook_progress' || response.subtype === 'hook_response') {
                const statusText = response.text || response.subtype || '';
                if (statusText) {
                  ws.send(createNormalizedMessage({ kind: 'status', text: statusText, sessionId: capturedSessionId || sessionId || null, provider: 'tokenc' }));
                }
              }
              break;

            case 'user':
              break;

            case 'assistant':
              if (response.message && response.message.content && response.message.content.length > 0) {
                const normalized = sessionsService.normalizeMessage('tokenc', response, capturedSessionId || sessionId || null);
                for (const msg of normalized) ws.send(msg);
              }
              break;

            case 'pending': {
              const toolName = response.tool_name || response.toolUse?.name || '';
              const toolInput = response.tool_use?.input || response.input || {};
              const desc = toolName ? `${toolName}${toolInput.command ? ': ' + String(toolInput.command).slice(0, 80) : ''}` : '';
              ws.send(createNormalizedMessage({
                kind: 'status',
                text: desc || 'processing',
                sessionId: capturedSessionId || sessionId || null,
                provider: 'tokenc',
              }));
              break;
            }

            case 'control_request': {
              const requestId = response.request_id || response.request?.request_id || String(Date.now());
              const req = response.request || {};
              const toolName = req.tool_name || '';
              const toolInput = req.input || {};

              console.log('[Tokenc] control_request:', { requestId, toolName });

              if (skipPermissions || settings.skipPermissions) {
                tokencProcess.stdin.write(JSON.stringify({
                  type: 'control_response',
                  request_id: requestId,
                  response: { subtype: 'success' },
                }) + '\n');
              } else {
                ws.send(createNormalizedMessage({
                  kind: 'permission_request',
                  requestId,
                  toolName,
                  input: toolInput,
                  sessionId: capturedSessionId || sessionId || null,
                  provider: 'tokenc',
                }));

                const pendingRequests = pendingPermissionRequests.get(capturedSessionId || sessionId || processKey) || [];
                const approvalPromise = new Promise((resolve) => {
                  pendingRequests.push({ requestId, resolve, toolName });
                });
                pendingPermissionRequests.set(capturedSessionId || sessionId || processKey, pendingRequests);

                try {
                  const decision = await Promise.race([
                    approvalPromise,
                    new Promise((resolve) => setTimeout(() => resolve(null), 300000)),
                  ]);

                  if (decision && decision.allow) {
                    tokencProcess.stdin.write(JSON.stringify({
                      type: 'control_response',
                      request_id: requestId,
                      response: {
                        subtype: 'success',
                        allow: true,
                        updatedInput: decision.updatedInput,
                        message: decision.message,
                        rememberEntry: decision.rememberEntry,
                      },
                    }) + '\n');
                  } else {
                    tokencProcess.stdin.write(JSON.stringify({
                      type: 'control_response',
                      request_id: requestId,
                      response: { subtype: 'error', error: decision?.message || 'User denied' },
                    }) + '\n');
                  }
                } catch (err) {
                  console.error('[Tokenc] Permission response error:', err);
                  tokencProcess.stdin.write(JSON.stringify({
                    type: 'control_response',
                    request_id: requestId,
                    response: { subtype: 'error', error: 'Permission handling failed' },
                  }) + '\n');
                }
              }
              break;
            }

            case 'result': {
              console.log('Tokenc session result:', response);
              const resultText = typeof response.result === 'string' ? response.result : '';
              ws.send(createNormalizedMessage({
                kind: 'complete',
                exitCode: response.subtype === 'success' ? 0 : 1,
                resultText,
                isError: response.subtype !== 'success',
                sessionId: capturedSessionId || sessionId, provider: 'tokenc',
              }));
              break;
            }

            case 'error': {
              const errorMsg = response.error || response.message || JSON.stringify(response);
              console.error('Tokenc error:', errorMsg);
              ws.send(createNormalizedMessage({ kind: 'error', content: errorMsg, sessionId: capturedSessionId || sessionId || null, provider: 'tokenc' }));
              break;
            }

            default:
              console.log('[Tokenc] Unhandled type:', response.type, response);
          }
        } catch (parseError) {
          console.log('Non-JSON response:', line);

          if (shouldSuppressForTrustRetry(line)) {
            return;
          }

          const normalized = sessionsService.normalizeMessage('tokenc', line, capturedSessionId || sessionId || null);
          for (const msg of normalized) ws.send(msg);
        }
      };

      tokencProcess.stdout.on('data', (data) => {
        const rawOutput = data.toString();
        console.log('Tokenc CLI stdout:', rawOutput);

        stdoutLineBuffer += rawOutput;
        const completeLines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = completeLines.pop() || '';

        completeLines.forEach((line) => {
          processTokencOutputLine(line.trim());
        });
      });

      tokencProcess.stderr.on('data', (data) => {
        const stderrText = data.toString();
        console.error('Tokenc CLI stderr:', stderrText);

        if (shouldSuppressForTrustRetry(stderrText)) {
          return;
        }

        const lines = stderrText.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith('[stdout-guard]')) {
            const actualContent = trimmed.replace(/^\[stdout-guard\]\s*/, '');
            console.log('[Tokenc] stdout-guard diverted:', actualContent.slice(0, 120));
            continue;
          }

          ws.send(createNormalizedMessage({ kind: 'error', content: trimmed, sessionId: capturedSessionId || sessionId || null, provider: 'tokenc' }));
        }
      });

      tokencProcess.on('close', async (code) => {
        console.log(`Tokenc CLI process exited with code ${code}`);

        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeTokencProcesses.delete(finalSessionId);
        activeTokencWriters.delete(finalSessionId);

        if (stdoutLineBuffer.trim()) {
          processTokencOutputLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }

        if (
          runSawWorkspaceTrustPrompt &&
          code !== 0 &&
          !hasRetriedWithTrust &&
          !args.includes('--trust')
        ) {
          hasRetriedWithTrust = true;
          runTokencProcess([...args, '--trust'], 'trust-retry');
          return;
        }

        ws.send(createNormalizedMessage({ kind: 'complete', exitCode: code, isNewSession: !sessionId && !!command, sessionId: finalSessionId, provider: 'tokenc' }));

        if (code === 0) {
          notifyTerminalState({ code });
          settleOnce(() => resolve());
        } else {
          notifyTerminalState({ code });
          settleOnce(() => reject(new Error(`Tokenc CLI exited with code ${code}`)));
        }
      });

      tokencProcess.on('error', async (error) => {
        console.error('Tokenc CLI process error:', error);

        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeTokencProcesses.delete(finalSessionId);
        activeTokencWriters.delete(finalSessionId);

        const installed = await providerAuthService.isProviderInstalled('tokenc');
        const errorContent = !installed
          ? 'Tokenc CLI is not installed. Please install tokenc first'
          : error.message;

        ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'tokenc' }));
        notifyTerminalState({ error });

        settleOnce(() => reject(error));
      });

      tokencProcess.stdin.end();
    };

    runTokencProcess(baseArgs, 'initial');
  });
}

function abortTokencSession(sessionId) {
  const process = activeTokencProcesses.get(sessionId);
  if (process) {
    console.log(`Aborting Tokenc session: ${sessionId}`);
    process.kill('SIGTERM');
    activeTokencProcesses.delete(sessionId);
    activeTokencWriters.delete(sessionId);
    return true;
  }
  return false;
}

function reconnectTokencSessionWriter(sessionId, newRawWs) {
  const writer = activeTokencWriters.get(sessionId);
  if (!writer?.updateWebSocket) return false;
  writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Tokenc Writer swapped for session ${sessionId}`);
  return true;
}

function isTokencSessionActive(sessionId) {
  return activeTokencProcesses.has(sessionId);
}

function getActiveTokencSessions() {
  return Array.from(activeTokencProcesses.keys());
}

function resolveTokencPermission(sessionId, requestId, decision) {
  const pendingList = pendingPermissionRequests.get(sessionId);
  if (!pendingList) return false;

  const idx = pendingList.findIndex(p => p.requestId === requestId);
  if (idx === -1) return false;

  const [item] = pendingList.splice(idx, 1);
  item.resolve(decision);
  console.log(`[Tokenc] Permission resolved: ${requestId} -> ${decision.allow ? 'allowed' : 'denied'}`);
  return true;
}

export {
  spawnTokenc,
  abortTokencSession,
  isTokencSessionActive,
  getActiveTokencSessions,
  reconnectTokencSessionWriter,
  resolveTokencPermission
};
