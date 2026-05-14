import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { TokencProviderAuth } from '@/modules/providers/list/tokenc/tokenc-auth.provider.js';
import { TokencMcpProvider } from '@/modules/providers/list/tokenc/tokenc-mcp.provider.js';
import { TokencSessionSynchronizer } from '@/modules/providers/list/tokenc/tokenc-session-synchronizer.provider.js';
import { TokencSessionsProvider } from '@/modules/providers/list/tokenc/tokenc-sessions.provider.js';
import type { IProviderAuth, IProviderSessionSynchronizer, IProviderSessions } from '@/shared/interfaces.js';

export class TokencProvider extends AbstractProvider {
  readonly mcp = new TokencMcpProvider();
  readonly auth: IProviderAuth = new TokencProviderAuth();
  readonly sessions: IProviderSessions = new TokencSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new TokencSessionSynchronizer();

  constructor() {
    super('tokenc');
  }
}
