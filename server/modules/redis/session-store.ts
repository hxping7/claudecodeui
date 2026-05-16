import { getRedisClient } from './connection.js';

const SESSION_PREFIX = 'cloudcli:session:';
const USER_SESSIONS_PREFIX = 'cloudcli:user:sessions:';
const SESSION_TTL = 86400 * 7;

export interface SessionData {
  id: string;
  userId: string;
  projectPath: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
  }>;
  createdAt: string;
  lastActivity: string;
}

export async function saveSessionToRedis(session: SessionData): Promise<void> {
  const redis = getRedisClient();
  const key = `${SESSION_PREFIX}${session.id}`;

  await redis.setex(
    key,
    SESSION_TTL,
    JSON.stringify(session)
  );

  const userKey = `${USER_SESSIONS_PREFIX}${session.userId}`;
  await redis.sadd(userKey, session.id);
  await redis.expire(userKey, SESSION_TTL);
}

export async function getSessionFromRedis(sessionId: string): Promise<SessionData | null> {
  const redis = getRedisClient();
  const key = `${SESSION_PREFIX}${sessionId}`;
  const data = await redis.get(key);

  if (!data) return null;

  try {
    return JSON.parse(data) as SessionData;
  } catch (error) {
    console.error('[Redis Session] 解析会话数据失败:', error);
    return null;
  }
}

export async function deleteSessionFromRedis(sessionId: string, userId: string): Promise<void> {
  const redis = getRedisClient();

  await redis.del(`${SESSION_PREFIX}${sessionId}`);

  const userKey = `${USER_SESSIONS_PREFIX}${userId}`;
  await redis.srem(userKey, sessionId);
}

export async function getUserSessionIds(userId: string): Promise<string[]> {
  const redis = getRedisClient();
  const userKey = `${USER_SESSIONS_PREFIX}${userId}`;
  return await redis.smembers(userKey);
}

export async function getUserSessionsFromRedis(userId: string): Promise<SessionData[]> {
  const sessionIds = await getUserSessionIds(userId);
  const sessions: SessionData[] = [];

  for (const sessionId of sessionIds) {
    const session = await getSessionFromRedis(sessionId);
    if (session) {
      sessions.push(session);
    }
  }

  return sessions.sort((a, b) =>
    new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
  );
}

export async function addMessageToSession(
  sessionId: string,
  role: string,
  content: string
): Promise<SessionData | null> {
  const session = await getSessionFromRedis(sessionId);
  if (!session) return null;

  const message = {
    role,
    content,
    timestamp: new Date().toISOString(),
  };

  session.messages.push(message);
  session.lastActivity = new Date().toISOString();

  await saveSessionToRedis(session);

  return session;
}

export async function updateSessionActivity(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  const key = `${SESSION_PREFIX}${sessionId}`;

  const data = await redis.get(key);
  if (!data) return;

  try {
    const session = JSON.parse(data) as SessionData;
    session.lastActivity = new Date().toISOString();

    await redis.setex(key, SESSION_TTL, JSON.stringify(session));
  } catch (error) {
    console.error('[Redis Session] 更新活动时间失败:', error);
  }
}
