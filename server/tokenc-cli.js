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
    const { sessionId, projectPath, cwd, resume, toolsSettings, skipPermissions, model, sessionSummary } = options;
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
    }

    if (skipPermissions || settings.skipPermissions) {
      baseArgs.push('-f');
      console.log('Using -f flag (skip permissions)');
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

      const processTokencOutputLine = (line) => {
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

                  if (!sessionId && !sessionCreatedSent) {
                    sessionCreatedSent = true;
                    ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, model: response.model, cwd: response.cwd, sessionId: capturedSessionId, provider: 'tokenc' }));
                  }
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

            default:
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

        ws.send(createNormalizedMessage({ kind: 'error', content: stderrText, sessionId: capturedSessionId || sessionId || null, provider: 'tokenc' }));
      });

      tokencProcess.on('close', async (code) => {
        console.log(`Tokenc CLI process exited with code ${code}`);

        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeTokencProcesses.delete(finalSessionId);

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
    return true;
  }
  return false;
}

function isTokencSessionActive(sessionId) {
  return activeTokencProcesses.has(sessionId);
}

function getActiveTokencSessions() {
  return Array.from(activeTokencProcesses.keys());
}

export {
  spawnTokenc,
  abortTokencSession,
  isTokencSessionActive,
  getActiveTokencSessions
};
