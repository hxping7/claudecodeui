module.exports = {
  apps: [{
    name: 'cloudcli',
    script: './dist-server/server/index.js',

    // 集群模式: 利用所有 CPU 核心
    instances: '2',
    exec_mode: 'cluster',

    env: {
      NODE_ENV: 'production',
      SERVER_PORT: 8250,
      DATABASE_PATH: '/var/lib/cloudcli/auth.db',
      REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
      USE_REDIS: 'true',
      AUTH_MODE: 'linux',  // PAM 认证模式
      JWT_SECRET: process.env.JWT_SECRET || 'QCyZVgHStq8ZbnqpN0tQc8VKBpf4oID4+Nc7bzw0Ct53aPEoAmoeM+QcyTXo50Ho',  // 持久化的 JWT Secret
    },

    // 内存限制: 4GB/worker (自动重启防泄漏)
    max_memory_restart: '4G',

    // 日志配置
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    log_rotate: true,
    log_max_size: '100M',
    log_retain: 14,

    // 重启策略
    restart_delay: 3000,
    max_restarts: 10,
    min_uptime: '15s',
    autorestart: true,
    watch: false,

    // 优雅关闭
    kill_timeout: 15000,
    listen_timeout: 10000,

    // Node.js 参数
    node_args: '--max-old-space-size=4096',

    // 端口递增 (集群模式避免冲突)
    increment_var: 'PORT',

    // 定时重启 (每天凌晨 4 点, 防止内存泄漏)
    cron_restart: '0 4 * * *'
  }]
};
