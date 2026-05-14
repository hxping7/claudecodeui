import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type VerifyClientCallbackSync } from 'ws';

import { runInRequestContext } from '@/requestContext.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { verifyWebSocketClient } from '@/modules/websocket/services/websocket-auth.service.js';
import { handlePluginWsProxy } from '@/modules/websocket/services/plugin-websocket-proxy.service.js';
import { handleShellConnection } from '@/modules/websocket/services/shell-websocket.service.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketServerDependencies = {
  verifyClient: Parameters<typeof verifyWebSocketClient>[1];
  chat: Parameters<typeof handleChatConnection>[2];
  shell: Parameters<typeof handleShellConnection>[2];
  getPluginPort: Parameters<typeof handlePluginWsProxy>[2];
};

/**
 * Creates and wires the server-wide websocket gateway used for chat, shell, and
 * plugin proxy routes.
 */
export function createWebSocketServer(
  server: HttpServer,
  dependencies: WebSocketServerDependencies
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    verifyClient: ((
      info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0]
    ) => verifyWebSocketClient(info, dependencies.verifyClient)),
  });

  wss.on('connection', (ws, request) => {
    const incomingRequest = request as AuthenticatedWebSocketRequest;
    const user = incomingRequest.user as { home_dir?: string; uid?: number; gid?: number } | undefined;
    const store = {
      homeDir: user?.home_dir || null,
      uid: typeof user?.uid === 'number' ? user.uid : undefined,
      gid: typeof user?.gid === 'number' ? user.gid : undefined,
    };

    const url = incomingRequest.url ?? '/';
    const pathname = new URL(url, 'http://localhost').pathname;

    runInRequestContext(store, () => {
      if (pathname === '/shell') {
        handleShellConnection(ws, incomingRequest, dependencies.shell);
        return;
      }

      if (pathname === '/ws') {
        handleChatConnection(ws, incomingRequest, dependencies.chat);
        return;
      }

      if (pathname.startsWith('/plugin-ws/')) {
        handlePluginWsProxy(ws, pathname, dependencies.getPluginPort);
        return;
      }

      console.log('[WARN] Unknown WebSocket path:', pathname);
      ws.close();
    });
  });

  return wss;
}
