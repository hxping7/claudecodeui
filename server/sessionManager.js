import { promises as fs } from 'fs';
import path from 'path';

import { getCurrentUserHomeDir } from './claude-sdk.js';
import {
  saveSessionToRedis,
  getSessionFromRedis,
  deleteSessionFromRedis,
  getUserSessionsFromRedis,
  addMessageToSession,
  updateSessionActivity,
} from './modules/redis/index.js';

const USE_REDIS = process.env.REDIS_URL || process.env.USE_REDIS === 'true';

class SessionManager {
  constructor() {
    this.localCache = new Map();
    this.maxSessionsPerUser = 100;
    this.redisAvailable = false;
    
    if (USE_REDIS) {
      this.checkRedisAvailability();
    }
  }

  async checkRedisAvailability() {
    try {
      const { checkRedisHealth } = await import('./modules/redis/index.js');
      this.redisAvailable = await checkRedisHealth();
      console.log(`[SessionManager] Redis 可用: ${this.redisAvailable}`);
    } catch (error) {
      console.warn('[SessionManager] Redis 不可用，使用本地存储');
      this.redisAvailable = false;
    }
  }

  _getSessionsDir() {
    const homeDir = getCurrentUserHomeDir();
    if (!homeDir) {
      throw new Error('No user home directory available in request context');
    }
    return path.join(homeDir, '.gemini', 'sessions');
  }

  _getUserCacheKey() {
    const homeDir = getCurrentUserHomeDir();
    return `sessions:${homeDir}`;
  }

  _getUserLocalSessions() {
    const cacheKey = this._getUserCacheKey();
    
    if (!this.localCache.has(cacheKey)) {
      this.localCache.set(cacheKey, new Map());
    }
    return this.localCache.get(cacheKey);
  }

  async _ensureSessionsDir() {
    const sessionsDir = this._getSessionsDir();
    try {
      await fs.mkdir(sessionsDir, { recursive: true });
    } catch (error) {
    }
    return sessionsDir;
  }

  async createSession(sessionId, projectPath) {
    const userId = getCurrentUserHomeDir() || 'unknown';
    const now = new Date().toISOString();
    
    const session = {
      id: sessionId,
      projectPath: projectPath,
      messages: [],
      createdAt: now,
      lastActivity: now
    };

    if (this.redisAvailable) {
      await saveSessionToRedis({
        ...session,
        userId,
      });
    }

    const localSessions = this._getUserLocalSessions();
    if (localSessions.size >= this.maxSessionsPerUser) {
      const oldestKey = localSessions.keys().next().value;
      if (oldestKey) localSessions.delete(oldestKey);
    }

    localSessions.set(sessionId, session);
    await this.saveSessionToLocal(sessionId);

    return session;
  }

  async addMessage(sessionId, role, content) {
    let session;

    if (this.redisAvailable) {
      session = await addMessageToSession(sessionId, role, content);
    }

    const localSessions = this._getUserLocalSessions();
    session = localSessions.get(sessionId);

    if (!session) {
      session = {
        id: sessionId,
        projectPath: '',
        messages: [],
        createdAt: new Date(),
        lastActivity: new Date()
      };
      localSessions.set(sessionId, session);
    }

    const message = {
      role: role,
      content: content,
      timestamp: new Date()
    };

    session.messages.push(message);
    session.lastActivity = new Date();

    this.saveSessionToLocal(sessionId);

    return session;
  }

  async getSession(sessionId) {
    if (this.redisAvailable) {
      const redisSession = await getSessionFromRedis(sessionId);
      if (redisSession) {
        const localSessions = this._getUserLocalSessions();
        localSessions.set(sessionId, {
          ...redisSession,
          createdAt: new Date(redisSession.createdAt),
          lastActivity: new Date(redisSession.lastActivity),
          messages: redisSession.messages.map(msg => ({
            ...msg,
            timestamp: new Date(msg.timestamp),
          })),
        });
        return localSessions.get(sessionId);
      }
    }

    const localSessions = this._getUserLocalSessions();
    let session = localSessions.get(sessionId);

    if (!session) {
      session = await this.loadSessionFromLocal(sessionId);
    }

    return session;
  }

  async getProjectSessions(projectPath) {
    let sessions = [];

    if (this.redisAvailable) {
      const userId = getCurrentUserHomeDir() || 'unknown';
      sessions = await getUserSessionsFromRedis(userId);
    } else {
      const localSessions = this._getUserLocalSessions();
      sessions = Array.from(localSessions.values());
    }

    return sessions
      .filter(s => s.projectPath === projectPath)
      .map(session => ({
        id: session.id,
        summary: this.getSessionSummary(session),
        messageCount: session.messages.length,
        lastActivity: session.lastActivity
      }))
      .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  }

  getSessionSummary(session) {
    if (session.messages.length === 0) {
      return 'New Session';
    }

    const firstUserMessage = session.messages.find(m => m.role === 'user');
    if (firstUserMessage) {
      const content = firstUserMessage.content;
      return content.length > 50 ? content.substring(0, 50) + '...' : content;
    }

    return 'New Session';
  }

  buildConversationContext(sessionId, maxMessages = 10) {
    const localSessions = this._getUserLocalSessions();
    const session = localSessions.get(sessionId);

    if (!session || session.messages.length === 0) {
      return '';
    }

    const recentMessages = session.messages.slice(-maxMessages);

    let context = 'Here is the conversation history:\n\n';

    for (const msg of recentMessages) {
      if (msg.role === 'user') {
        context += `User: ${msg.content}\n`;
      } else {
        context += `Assistant: ${msg.content}\n`;
      }
    }

    context += '\nBased on the conversation history above, please answer the following:\n';

    return context;
  }

  _safeFilePath(sessionId) {
    const safeId = String(sessionId).replace(/[/\\]|\.\./g, '');
    return path.join(this._getSessionsDir(), `${safeId}.json`);
  }

  async saveSessionToLocal(sessionId) {
    const localSessions = this._getUserLocalSessions();
    const session = localSessions.get(sessionId);
    if (!session) return;

    try {
      await this._ensureSessionsDir();
      const filePath = this._safeFilePath(sessionId);
      await fs.writeFile(filePath, JSON.stringify(session, null, 2));
    } catch (error) {
    }
  }

  async loadSessionFromLocal(sessionId) {
    const localSessions = this._getUserLocalSessions();
    
    try {
      const filePath = this._safeFilePath(sessionId);
      const data = await fs.readFile(filePath, 'utf8');
      const session = JSON.parse(data);

      session.createdAt = new Date(session.createdAt);
      session.lastActivity = new Date(session.lastActivity);
      session.messages.forEach(msg => {
        msg.timestamp = new Date(msg.timestamp);
      });

      localSessions.set(session.id, session);
      return session;
    } catch (error) {
      return null;
    }
  }

  async deleteSession(sessionId) {
    const userId = getCurrentUserHomeDir() || 'unknown';

    if (this.redisAvailable) {
      await deleteSessionFromRedis(sessionId, userId);
    }

    const localSessions = this._getUserLocalSessions();
    localSessions.delete(sessionId);

    try {
      const filePath = this._safeFilePath(sessionId);
      await fs.unlink(filePath);
    } catch (error) {
    }
  }

  getSessionMessages(sessionId) {
    const localSessions = this._getUserLocalSessions();
    const session = localSessions.get(sessionId);
    if (!session) return [];

    return session.messages.map(msg => ({
      type: 'message',
      message: {
        role: msg.role,
        content: msg.content
      },
      timestamp: msg.timestamp.toISOString()
    }));
  }

  async touchSession(sessionId) {
    if (this.redisAvailable) {
      await updateSessionActivity(sessionId);
    }

    const localSessions = this._getUserLocalSessions();
    const session = localSessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
    }
  }
}

const sessionManager = new SessionManager();

export default sessionManager;
