import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const REDIS_DB = parseInt(process.env.REDIS_DB || '0', 10);

let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!client) {
    const options: Redis.RedisOptions = {
      url: REDIS_URL,
      db: REDIS_DB,
      retryStrategy: (times: number) => {
        if (times > 10) {
          console.error('[Redis] 重连次数超过 10 次，停止重连');
          return null;
        }
        return Math.min(times * 100, 3000);
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      keepAlive: 10000,
      connectTimeout: 10000,
      lazyConnect: false,
    };

    if (REDIS_PASSWORD) {
      options.password = REDIS_PASSWORD;
    }

    client = new Redis(options);

    client.on('connect', () => {
      console.log('[Redis] ✅ 连接成功');
    });

    client.on('error', (err: Error) => {
      console.error('[Redis] ❌ 连接错误:', err.message);
    });

    client.on('reconnecting', () => {
      console.log('[Redis] 🔄 正在重连...');
    });
  }

  return client;
}

export async function closeRedisConnection(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
    console.log('[Redis] 连接已关闭');
  }
}

export async function checkRedisHealth(): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const result = await redis.ping();
    return result === 'PONG';
  } catch (error) {
    console.error('[Redis] 健康检查失败:', error);
    return false;
  }
}
