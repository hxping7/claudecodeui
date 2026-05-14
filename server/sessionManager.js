import { promises as fs } from 'fs';
import path from 'path';
import { getCurrentUserHomeDir } from './claude-sdk.js';

class SessionManager {
  constructor() {
    this.userSessions = new Map();
    this.maxSessionsPerUser = 100;
  }

  _getSessionsDir() {
    const homeDir = getCurrentUserHomeDir();
    if (!homeDir) {
      throw new Error('No user home directory available in request context');
    }
    return path.join(homeDir, '.gemini', 'sessions');
  }

  _getUserSessions() {
    const homeDir = getCurrentUserHomeDir();
    if (!homeDir) {
      throw new Error('No user home directory available in request context');
    }
    
    if (!this.userSessions.has(homeDir)) {
      this.userSessions.set(homeDir, new Map());
    }
    return this.userSessions.get(homeDir);
  }

  async _ensureSessionsDir() {
    const sessionsDir = this._getSessionsDir();
    try {
      await fs.mkdir(sessionsDir, { recursive: true });
    } catch (error) {
      // Ignore if already exists
    }
    return sessionsDir;
  }

  async createSession(sessionId, projectPath) {
    const sessions = this._getUserSessions();
    
    const session = {
      id: sessionId,
      projectPath: projectPath,
      messages: [],
      createdAt: new Date(),
      lastActivity: new Date()
    };

    if (sessions.size >= this.maxSessionsPerUser) {
      const oldestKey = sessions.keys().next().value;
      if (oldestKey) sessions.delete(oldestKey);
    }

    sessions.set(sessionId, session);
    await this.saveSession(sessionId);

    return session;
  }

  addMessage(sessionId, role, content) {
    const sessions = this._getUserSessions();
    let session = sessions.get(sessionId);

    if (!session) {
      session = {
        id: sessionId,
        projectPath: '',
        messages: [],
        createdAt: new Date(),
        lastActivity: new Date()
      };
      sessions.set(sessionId, session);
    }

    const message = {
      role: role,
      content: content,
      timestamp: new Date()
    };

    session.messages.push(message);
    session.lastActivity = new Date();

    this.saveSession(sessionId);

    return session;
  }

  getSession(sessionId) {
    const sessions = this._getUserSessions();
    return sessions.get(sessionId);
  }

  getProjectSessions(projectPath) {
    const sessions = this._getUserSessions();
    const result = [];

    for (const [id, session] of sessions) {
      if (session.projectPath === projectPath) {
        result.push({
          id: session.id,
          summary: this.getSessionSummary(session),
          messageCount: session.messages.length,
          lastActivity: session.lastActivity
        });
      }
    }

    return result.sort((a, b) =>
      new Date(b.lastActivity) - new Date(a.lastActivity)
    );
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
    const sessions = this._getUserSessions();
    const session = sessions.get(sessionId);

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

  async saveSession(sessionId) {
    const sessions = this._getUserSessions();
    const session = sessions.get(sessionId);
    if (!session) return;

    try {
      await this._ensureSessionsDir();
      const filePath = this._safeFilePath(sessionId);
      await fs.writeFile(filePath, JSON.stringify(session, null, 2));
    } catch (error) {
      // console.error('Error saving session:', error);
    }
  }

  async loadSession(sessionId) {
    const sessions = this._getUserSessions();
    if (sessions.has(sessionId)) {
      return sessions.get(sessionId);
    }

    try {
      const filePath = this._safeFilePath(sessionId);
      const data = await fs.readFile(filePath, 'utf8');
      const session = JSON.parse(data);

      session.createdAt = new Date(session.createdAt);
      session.lastActivity = new Date(session.lastActivity);
      session.messages.forEach(msg => {
        msg.timestamp = new Date(msg.timestamp);
      });

      sessions.set(session.id, session);
      return session;
    } catch (error) {
      return null;
    }
  }

  async deleteSession(sessionId) {
    const sessions = this._getUserSessions();
    sessions.delete(sessionId);

    try {
      const filePath = this._safeFilePath(sessionId);
      await fs.unlink(filePath);
    } catch (error) {
      // console.error('Error deleting session file:', error);
    }
  }

  getSessionMessages(sessionId) {
    const sessions = this._getUserSessions();
    const session = sessions.get(sessionId);
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
}

const sessionManager = new SessionManager();

export default sessionManager;
