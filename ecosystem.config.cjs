module.exports = {
  apps: [
    {
      name: 'claudecodeui',
      script: './dist-server/server/index.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        SERVER_PORT: 8250
      },
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      max_memory_restart: '1G',
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '10s',
      watch: false,
      autorestart: true,
      kill_timeout: 5000,
      listen_timeout: 10000,
      // 优雅关闭
      shutdown_with_message: true,
      // 日志轮转
      log_rotate: true,
      log_max_size: '10M',
      log_retain: 10
    }
  ]
};
