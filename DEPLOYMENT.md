# CloudCLI 双模式部署指南

> **生产环境 (PM2 Cluster) + 调试环境 (Systemd) 完全隔离部署方案**

---

## 📋 目录

- [1. 架构概览](#1-架构概览)
- [2. 环境对比](#2-环境对比)
- [3. 生产环境部署 (deploy-production.sh)](#3-生产环境部署)
- [4. 调试环境部署 (deploy-systemd.sh)](#4-调试环境部署)
- [5. 双环境共存管理](#5-双环境共存管理)
- [6. 使用场景](#6-使用场景)
- [7. 常见问题与故障排除](#7-常见问题与故障排除)
- [8. 性能调优](#8-性能调优)
- [9. 安全建议](#9-安全建议)

---

## 1. 架构概览

### 1.1 部署架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     Ubuntu 服务器 (40核/256GB)                │
│                                                             │
│  ┌──────────────────────┐    ┌──────────────────────────┐   │
│  │   生产环境 (端口 8250) │    │   调试环境 (端口 8251)     │   │
│  │                      │    │                          │   │
│  │  PM2 Cluster 模式     │    │  Systemd 单实例模式       │   │
│  │  ┌────────────────┐  │    │  ┌────────────────────┐  │   │
│  │  │ Worker #0      │  │    │  │                    │  │   │
│  │  │ Worker #1      │  │    │  │  Node.js 进程      │  │   │
│  │  │ Worker #2      │  │    │  │  (单实例)          │  │   │
│  │  │ ...            │  │    │  │                    │  │   │
│  │  │ Worker #37     │  │    │  └────────────────────┘  │   │
│  │  └────────────────┘  │    │                          │   │
│  │  共 38 个 Workers    │    │  内存: 2GB               │   │
│  │  内存: ~152GB        │    │  CPU: 200% (2核)         │   │
│  └──────────────────────┘    └──────────────────────────┘   │
│           │                            │                    │
│           ▼                            ▼                    │
│  ┌─────────────────────────────────────────┐                 │
│  │              Redis Server              │                 │
│  │            (端口 6379)                  │                 │
│  │         会话存储 / 缓存                  │                 │
│  └─────────────────────────────────────────┘                 │
│                                                             │
│  数据库:                                                     │
│  ├── /var/lib/cloudli/auth.db        (生产环境)             │
│  └── /var/lib/cloudli-debug/auth.db  (调试环境)             │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 设计原则

| 原则 | 说明 |
|------|------|
| ✅ **完全隔离** | 端口、数据库、日志、进程完全独立 |
| ✅ **零干扰** | 调试环境的重启/崩溃不影响生产环境 |
| ✅ **并行运行** | 两个环境可以同时运行，互不冲突 |
| ✅ **独立配置** | 各自的环境变量、资源限制、重启策略 |
| ✅ **便于调试** | 调试环境支持 Inspector、详细日志等 |

---

## 2. 环境对比

### 2.1 核心参数对比

| 配置项 | 生产环境 (`deploy-production.sh`) | 调试环境 (`deploy-systemd.sh`) |
|--------|----------------------------------|-------------------------------|
| **📌 默认端口** | `8250` | `8251` |
| **🏷️ 服务名称** | `cloudcli` | `cloudcli-debug` |
| **⚙️ 运行模式** | PM2 Cluster (38 Workers) | Systemd 单实例 |
| **🌍 NODE_ENV** | `production` | `development` |
| **🗄️ SQLite 数据库** | `/var/lib/cloudli/auth.db` | `/var/lib/cloudli-debug/auth.db` |
| **📂 数据目录** | `/var/lib/cloudli/` | `/var/lib/cloudli-debug/` |
| **📝 日志位置** | `~/.pm2/logs/` 或 `./logs/` | `journalctl -u cloudcli-debug` |
| **💾 内存限制** | 4GB/Worker × 38 = ~152GB | 2GB 总计 |
| **🔄 CPU 使用** | 无限制（利用所有核心） | 200%（2 核） |
| **⚡ 重启延迟** | 3 秒 | 1 秒（调试更快） |
| **🔁 最大重启次数** | 10 次 | 20 次（调试允许更多） |
| **🕐 定时重启** | 每天 04:00 AM | 无（调试时不自动重启） |

### 2.2 功能特性对比

| 特性 | 生产环境 | 调试环境 |
|------|---------|---------|
| **高并发支持** | ✅ 500+ 并发连接 | ⚠️ 有限（单实例） |
| **负载均衡** | ✅ PM2 自动分发 | ❌ 不需要 |
| **零停机重载** | ✅ `pm2 reload` | ❌ 需要重启 |
| **故障恢复** | ✅ 自动重启 Worker | ✅ 自动重启进程 |
| **实时监控** | ✅ `pm2 monit` | ✅ `journalctl -f` |
| **Chrome DevTools** | ❌ 不支持 | ✅ Inspector (9229) |
| **详细日志** | ⚠️ 标准 | ✅ Debug 级别 + 毫秒时间戳 |
| **快速迭代** | ❌ 较慢 | ✅ 秒级重启 |

---

## 3. 生产环境部署

### 3.1 快速开始

```bash
# 进入项目目录
cd /home/hxp/code/tools/claudecodeui

# 执行生产部署脚本（需要 root 权限）
sudo bash deploy-production.sh
```

**预期输出：**
```
==============================================
  🚀 CloudCLI Production Deployment
==============================================

第 1 步: 系统信息收集...
[INFO] CPU 核心: 40
[INFO] 总内存: 256 GB
[✓] 推荐使用 38 个 Workers

第 2 步: Redis 服务检查与启动...
[INFO] 启动 Redis 服务...
[✓] Redis 启动成功 (2s)
[✓] Redis 连接测试通过: PONG

第 3 步: Nginx 反向代理与负载均衡...
[INFO] 跳过 Nginx 配置 (ENABLE_NGINX=false)

第 4 步: PAM 认证环境配置...
[INFO] 检测系统中的 Linux 用户...
[✓] 检测到 X 个可登录的 Linux 用户
[✓] Sudoers 终端权限已配置

第 5 步: PM2 集群模式部署...
[INFO] 生成 PM2 配置文件...
[✓] PM2 配置文件已生成
[INFO] 清理旧的 Redis 进程...
[INFO] 等待 Redis 启动... (1s/10s)
[✓] Redis 启动成功 (1s)
[✓] PM2 集群已启动 (38 workers)
   内存限制: 4G/worker
   总并发支持: ~500 连接 (50 用户 × 10 会话)

==============================================
  🎉 部署完成
==============================================
模式: pm2
端口: 8250

地址: http://localhost:8250

==============================================
  容量规划
==============================================
目标并发: 500 WebSocket 连接
用户规模: 50 并发用户 × 10 会话/用户
Worker 数: 38 进程
内存配置: 4G × 38 = 152GB 总计
会话存储: Redis (共享状态)
负载均衡: Nginx ip_hash (粘性会话)
==============================================
```

### 3.2 自定义配置选项

#### 方式一：通过环境变量

```bash
# 自定义端口号
sudo PORT=8080 bash deploy-production.sh

# 自定义 Worker 数量（默认自动计算：CPU核心数 - 2）
sudo WORKERS=20 bash deploy-production.sh

# 自定义内存限制
sudo MAX_MEMORY=2G bash deploy-production.sh

# 启用 Nginx 反向代理
sudo ENABLE_NGINX=true NGINX_DOMAIN=your-domain.com bash deploy-production.sh

# 设置 Redis 密码
sudo REDIS_PASSWORD=your-secret-password bash deploy-production.sh

# 完整示例：
sudo \
  PORT=3000 \
  WORKERS=30 \
  MAX_MEMORY=3G \
  REDIS_URL=redis://127.0.0.1:6379 \
  ENABLE_NGINX=true \
  NGINX_DOMAIN=cloud.example.com \
  bash deploy-production.sh
```

#### 方式二：修改脚本默认值

编辑 `deploy-production.sh` 文件头部：

```bash
# 第 11-19 行
APP_DIR="${APP_DIR:-/home/hxp/code/tools/claudecodeui}"
SERVICE_NAME="${SERVICE_NAME:-cloudcli}"
PORT="${PORT:-8250}"                              # ← 修改默认端口
DATA_DIR="${DATA_DIR:-/var/lib/cloudli}"
DEPLOY_MODE="${DEPLOY_MODE:-pm2}"                  # pm2 或 systemd
WORKERS="${WORKERS:-}"                             # 空表示自动计算
MAX_MEMORY="${MAX_MEMORY:-4G}"                     # ← 修改内存限制
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
ENABLE_NGINX="${ENABLE_NGINX:-false}"
NGINX_DOMAIN="${NGINX_DOMAIN:-your-domain.com}"
```

### 3.3 PM2 配置详解

脚本会生成 `ecosystem.config.cjs` 文件：

```javascript
module.exports = {
  apps: [{
    name: 'cloudcli',
    script: './dist-server/server/index.js',

    // ---- 集群模式配置 ----
    instances: 38,              // Worker 数量（自动计算）
    exec_mode: 'cluster',       // 集群模式（利用多核）

    // ---- 环境变量 ----
    env: {
      NODE_ENV: 'production',
      SERVER_PORT: 8250,
      DATABASE_PATH: '/var/lib/cloudli/auth.db',
      REDIS_URL: 'redis://127.0.0.1:6379',
      USE_REDIS: 'true',
      AUTH_MODE: 'linux',      // PAM 认证模式
    },

    // ---- 内存管理 ----
    max_memory_restart: '4G',  // 超过 4GB 自动重启（防泄漏）

    // ---- 日志配置 ----
    log_file: './logs/combined.log',      // 合并日志
    out_file: './logs/out.log',           // 标准输出
    error_file: './logs/error.log',       // 错误输出
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,                      // 合并所有 Worker 日志
    log_rotate: true,                      // 自动轮转
    log_max_size: '100M',                 // 单个日志最大 100MB
    log_retain: 14,                       // 保留 14 天

    // ---- 重启策略 ----
    restart_delay: 3000,      // 重启延迟 3 秒
    max_restarts: 10,         // 最大重启次数
    min_uptime: '15s',        // 最短运行 15 秒才算稳定
    autorestart: true,        // 异常退出自动重启
    watch: false,             // 不监听文件变化

    // ---- 优雅关闭 ----
    kill_timeout: 15000,      // 15 秒后强制杀死
    listen_timeout: 10000,    // 监听超时 10 秒

    // ---- Node.js 参数 ----
    node_args: '--max-old-space-size=4096',  // V8 堆内存 4GB

    // ---- 定时维护 ----
    cron_restart: '0 4 * * *',  // 每天 04:00 重启（防泄漏）
  }]
};
```

### 3.4 生产环境管理命令

#### 基本操作

```bash
# 查看服务状态
pm2 list

# 查看详细信息
pm2 show cloudcli
pm2 prettylist

# 实时监控面板（推荐）
pm2 monit
```

#### 日志查看

```bash
# 实时日志流（最常用）
pm2 logs cloudcli

# 只看错误日志
pm2 logs cloudcli --err

# 最近 100 行
pm2 logs cloudcli --lines 100 --nostream

# 按 Worker 查看
pm2 logs cloudcli --lines 50 id 0    # Worker #0 的日志
pm2 logs cloudcli --lines 50 id 1    # Worker #1 的日志
```

#### 重启与更新

```bash
# 重启所有 Worker
pm2 restart all

# 优雅重载（零停机，推荐用于生产）
pm2 reload cloudcli

# 重启特定 Worker
pm2 restart cloudli-id 0

# 先停止再启动（完全重启）
pm2 stop all
pm2 start ecosystem.config.cjs
```

#### 停止与删除

```bash
# 停止服务（不删除）
pm2 stop all

# 删除服务（从 PM2 进程列表移除）
pm2 delete all

# 完全停止并清理
pm2 kill
```

#### 开机自启动

```bash
# 设置 PM2 开机自启（只需执行一次）
pm2 startup systemd -u hxp --hp /home/hxp

# 保存当前进程列表
pm2 save

# 验证开机自启是否生效
systemctl status pm2-hxp
```

### 3.5 生产环境验证清单

部署完成后，请逐项验证：

```bash
# ✅ 1. 检查 PM2 进程状态
pm2 list
# 预期：看到 38 个 worker，状态都是 online

# ✅ 2. 检查端口监听
sudo ss -tlnp | grep 8250
# 预期：LISTEN 0.0.0.0:8250

# ✅ 3. 测试 HTTP 连接
curl -I http://localhost:8250
# 预期：HTTP/1.1 200 OK

# ✅ 4. 检查 Redis 连接
redis-cli ping
# 预期：PONG

# ✅ 5. 查看资源占用
pm2 prettylist | grep -A2 "monit'
# 预期：每个 Worker 占用约 150-200MB 内存

# ✅ 6. 检查日志是否有错误
pm2 logs cloudcli --err --lines 20 --nostream
# 预期：没有 ERROR 级别的日志

# ✅ 7. 测试并发连接（可选）
ab -n 1000 -c 100 http://localhost:8250/
# 预期：成功率 > 99%，响应时间 < 100ms
```

---

## 4. 调试环境部署

### 4.1 快速开始

```bash
# 进入项目目录
cd /home/hxp/code/tools/claudecodeui

# 执行调试部署脚本（需要 root 权限）
sudo bash deploy-systemd.sh
```

**预期输出：**
```
==============================================
  🐛 CloudCLI Debug 部署模式
==============================================

部署模式: systemd
工作目录: /home/hxp/code/tools/claudecodeui
服务端口: 8251 (Debug)
运行用户: hxp
Worker 数量: 1 (Debug 单实例)
Redis: redis://127.0.0.1:6379
数据库: /var/lib/cloudli-debug/auth.db
==============================================

━━━ 第 1 步: Redis 服务检查与启动 ━━━
[INFO] Redis 已运行

━━━ 第 2 步: 系统参数优化（调试模式 - 较宽松）━━━
[✓] 系统参数优化完成（Debug 模式）

━━━ 第 4 步: 部署 Systemd Debug 服务 (端口 8251) ━━━
[INFO] Systemd 服务文件已生成: /etc/systemd/system/cloudcli-debug.service
[✓] Systemd Debug 服务已启动 (2s)
   服务名称: cloudcli-debug
   监听端口: 8251
   运行用户: hxp
   内存限制: 2G
   CPU 配额: 200% (2核)

管理命令:
  sudo systemctl status cloudcli-debug
  sudo journalctl -u cloudcli-debug -f          # 实时日志
  sudo systemctl restart cloudcli-debug          # 重启
  sudo systemctl stop cloudcli-debug              # 停止

==============================================
  🎉 Debug 部署完成
==============================================

📋 部署信息:
   模式: systemd
   端口: 8251 (Debug)
   用户: hxp
   数据库: /var/lib/cloudli-debug/auth.db

🔧 Systemd Debug 管理:
   状态:  sudo systemctl status cloudcli-debug
   日志:  sudo journalctl -u cloudcli-debug -f
   重启:  sudo systemctl restart cloudcli-debug
   停止:  sudo systemctl stop cloudcli-debug

🌐 访问地址:
   http://localhost:8251
   http://<服务器IP>:8251

==============================================
  💡 Debug 提示
==============================================
✓ 与生产环境 (端口 8250) 完全隔离
✓ 使用独立的数据库: /var/lib/cloudli-debug/auth.db
✓ 详细日志输出 (level: debug)
✓ 更快的重启策略 (便于快速迭代)
✓ 较小的资源占用 (2G)
==============================================
```

### 4.2 高级调试功能

#### 4.2.1 启用 Node.js Inspector（Chrome DevTools）

```bash
# 启用 Inspector 调试（会在 9229 端口开启 WebSocket）
sudo ENABLE_INSPECTOR=true bash deploy-systemd.sh
```

**使用方法：**

1. 打开 Chrome 浏览器
2. 在地址栏输入：
   ```
   chrome-devtools://devtools/bundled/inspector.html?ws=localhost:9229
   ```
3. 或者访问：
   ```
   http://localhost:9229/json
   ```

**Inspector 功能：**
- ✅ 断点调试
- ✅ CPU Profiling（性能分析）
- ✅ Memory Heap Snapshots（内存快照）
- ✅ 实时查看变量和调用栈

#### 4.2.2 调整日志级别

```bash
# 最详细日志（包含所有 debug 信息）
sudo DEBUG_LOG_LEVEL=debug bash deploy-systemd.sh

# 标准详细日志（推荐）
sudo DEBUG_LOG_LEVEL=verbose bash deploy-systemd.sh

# 仅重要信息
sudo DEBUG_LOG_LEVEL=info bash deploy-systemd.sh
```

**日志级别说明：**

| 级别 | 用途 | 输出内容 |
|------|------|---------|
| `debug` | 深度调试 | 所有请求、SQL查询、内部状态变化 |
| `verbose` | 问题诊断 | 重要事件、警告、错误堆栈 |
| `info` | 正常运行 | 启动/停止、错误、关键事件 |

#### 4.2.3 使用 PM2 调试模式（替代 Systemd）

如果你更熟悉 PM2，也可以用 PM2 运行调试版本：

```bash
# 使用 PM2 模式启动调试环境
sudo DEPLOY_MODE=pm2 bash deploy-systemd.sh

# 这会生成 ecosystem.config.cjs 但使用调试配置
# 端口仍为 8251，但可以使用 PM2 命令管理
```

**适用场景：**
- 需要同时运行多个调试实例
- 想使用 `pm2 monit` 监控面板
- 需要 PM2 的集群功能进行压力测试

### 4.3 Systemd 服务配置详解

生成的服务文件位于 `/etc/systemd/system/cloudcli-debug.service`：

```ini
[Unit]
Description=CloudCLI Debug Server (Port 8251)
Documentation=https://github.com/your-repo/cloudcli
After=network-online.target redis-server.service
Wants=network-online.target
Requires=redis-server.service

[Service]
Type=simple
User=hxp
Group=hxp
WorkingDirectory=/home/hxp/code/tools/claudecodeui

# Debug 模式环境变量
Environment=NODE_ENV=development
Environment=SERVER_PORT=8251
Environment=DATABASE_PATH=/var/lib/cloudli-debug/auth.db
Environment=REDIS_URL=redis://127.0.0.1:6379
Environment=USE_REDIS=true
Environment=AUTH_MODE=linux
Environment=LOG_LEVEL=debug

# Node.js 参数
Environment="NODE_OPTIONS=--max-old-space-size=2048"

# 启动命令
ExecStart=/usr/bin/node /home/hxp/code/tools/claudecodeui/dist-server/server/index.js

# 重启策略（调试时更频繁的重启）
Restart=on-failure
RestartSec=3
StartLimitIntervalSec=60
StartLimitBurst=5

# 日志输出到 journalctl（便于调试）
StandardOutput=journal
StandardError=journal
SyslogIdentifier=cloudcli-debug

# 停止信号
KillSignal=SIGINT
TimeoutStopSec=30

# 资源限制（Debug 模式较小）
LimitNOFILE=65536
LimitNPROC=4096
MemoryMax=2G
CPUQuota=200%

# 安全设置
NoNewPrivileges=false

[Install]
WantedBy=multi-user.target
```

### 4.4 调试环境管理命令

#### 基本操作

```bash
# 查看服务状态
sudo systemctl status cloudcli-debug

# 是否正在运行
sudo systemctl is-active cloudcli-debug

# 查看详细配置
sudo systemctl cat cloudcli-debug
```

#### 日志查看（重点！）

```bash
# 实时日志流（最常用，推荐！）
sudo journalctl -u cloudcli-debug -f

# 最近 10 分钟的日志
sudo journalctl -u cloudcli-debug --since "10 min ago"

# 今天所有的日志
sudo journalctl -u cloudcli-debug --since today

# 最后 50 行
sudo journalctl -u cloudcli-debug -n 50

# 导出日志到文件（用于分析）
sudo journalctl -u cloudcli-debug --since today > debug-log.txt

# 只看错误日志
sudo journalctl -u cloudcli-debug -p err -f

# 包含特定关键词的日志
sudo journalctl -u cloudcli-debug -g "Error" -f
sudo journalctl -u cloudcli-debug -g "database" -f
```

**Journalctl 高级用法：**

```bash
# 按时间范围查看
sudo journalctl -u cloudcli-debug --since "2026-05-16 14:00" --until "2026-05-16 15:00"

# 按优先级别过滤
sudo journalctl -u cloudcli-debug -p warning..error  # 警告及以上
sudo journalctl -u cloudcli-debug -p err             # 仅错误

# 格式化输出（JSON 格式，方便程序处理）
sudo journalctl -u cloudcli-debug -o json

# 显示完整信息（不截断长行）
sudo journalctl -u cloudcli-debug --no-pager -o cat
```

#### 重启与停止

```bash
# 重启调试服务（修改代码后常用）
sudo systemctl restart cloudcli-debug

# 停止调试服务
sudo systemctl stop cloudcli-debug

# 启动调试服务
sudo systemctl start cloudcli-debug

# 强制重新加载配置（修改了 .service 文件后）
sudo systemctl daemon-reload
sudo systemctl restart cloudcli-debug
```

#### 动态修改配置（无需重启）

```bash
# 临时添加环境变量
sudo systemctl set-environment DEBUG=*
sudo systemctl set-environment LOG_LEVEL=trace
sudo systemctl restart cloudcli-debug

# 恢复默认环境变量
sudo systemctl unset-environment DEBUG
sudo systemctl unset-environment LOG_LEVEL
sudo systemctl restart cloudcli-debug
```

#### 创建 Service Override（持久化自定义）

```bash
# 创建 override 目录
sudo mkdir -p /etc/systemd/system/cloudcli-debug.service.d/

# 创建自定义配置文件
sudo tee /etc/systemd/system/cloudcli-debug.service.d/custom.conf <<EOF
[Service]
# 使用不同的 Redis 数据库编号（避免与生产冲突）
Environment="REDIS_URL=redis://127.0.0.1:6379/1"

# 启用 Node.js Inspector
Environment="NODE_OPTIONS=--inspect-brk=0.0.0.0:9229"

# 更详细的日志
Environment="LOG_LEVEL=trace"
EOF

# 重新加载配置
sudo systemctl daemon-reload
sudo systemctl restart cloudcli-debug

# 查看合并后的最终配置
sudo systemctl cat cloudcli-debug
```

### 4.5 调试工作流示例

#### 场景 A：修复 Bug

```bash
# 1. 复现 Bug
# 打开浏览器访问 http://服务器IP:8251
# 触发 Bug 操作

# 2. 实时观察日志
sudo journalctl -u cloudcli-debug -f

# 3. 定位问题代码
# 从日志中找到错误信息和堆栈跟踪

# 4. 修复代码
vim /home/hxp/code/tools/claudecodeui/server/index.js

# 5. 重新编译
cd /home/hxp/code/tools/claudecodeui
npm run build:server

# 6. 重启调试环境（秒级生效）
sudo systemctl restart cloudcli-debug

# 7. 验证修复
# 再次访问 http://服务器IP:8251 测试

# 8. 确认无误后，应用到生产环境
sudo bash deploy-production.sh
```

#### 场景 B：性能优化

```bash
# 1. 启用 Inspector
sudo ENABLE_INSPECTOR=true bash deploy-systemd.sh

# 2. 打开 Chrome DevTools
# 地址栏输入: chrome-devtools://devtools/bundled/inspector.html?ws=你的IP:9229

# 3. 录制性能 Profile
# - 切换到 "Performance" 标签页
# - 点击 "Record" 按钮
# - 在浏览器中执行操作
# - 点击 "Stop" 查看

# 4. 分析瓶颈
# - 查看火焰图（Flame Chart）
# - 找出耗时最长的函数
# - 识别内存泄漏点

# 5. 优化代码...

# 6. 关闭 Inspector（生产环境不需要）
sudo systemctl edit cloudcli-debug
# 删除或注释掉 Environment="NODE_OPTIONS=--inspect-brk..."
sudo systemctl restart cloudcli-debug
```

#### 场景 C：数据库迁移测试

```bash
# 1. 调试环境使用独立的数据库（安全！）
ls -lh /var/lib/cloudli-debug/auth.db
# 可以随意修改这个数据库，不影响生产数据

# 2. 测试新的数据库 Schema
# 修改代码中的数据库操作逻辑...

# 3. 编译并重启
npm run build:server
sudo systemctl restart cloudcli-debug

# 4. 验证迁移结果
sqlite3 /var/lib/cloudli-debug/auth.db ".schema"
sqlite3 /var/lib/cloudli-debug/auth.db "SELECT * FROM users;"

# 5. 如果出错，可以随时重置
sudo rm /var/lib/cloudli-debug/auth.db
sudo systemctl restart cloudcli-debug
# 应用会自动重建数据库结构

# 6. 确认无误后，在生产环境执行正式迁移
```

---

## 5. 双环境共存管理

### 5.1 同时启动两个环境

```bash
# 一键启动双环境
cd /home/hxp/code/tools/claudecodeui
sudo bash deploy-production.sh && sudo bash deploy-systemd.sh
```

### 5.2 状态总览

```bash
# 创建便捷别名（添加到 ~/.bashrc）

alias prod-status='echo "=== PRODUCTION (8250) ===" && pm2 list'
alias debug-status='echo "=== DEBUG (8251) ===" && sudo systemctl status cloudcli-debug --no-pager | head -15'
alias both-status='prod-status && echo "" && debug-status'

# 使用
both-status
```

**预期输出：**
```
=== PRODUCTION (8250) ===
┌────┬─────────────┬──────┬──────┬────────┬──────────┬──────────┐
│ id │ name        │ mode │ ↺    │ status │ cpu      │ memory   │
├────┼─────────────┼──────┼──────┼────────┼──────────┼──────────┤
│ 0  │ cloudcli    │ cluster│ 0  │ online │ 3.5%     │ 155MB    │
│ 1  │ cloudcli    │ cluster│ 0  │ online │ 3.2%     │ 153MB    │
│ ... (共 38 个 online worker)
└────┴─────────────┴──────┴──────┴────────┴──────────┴──────────┘

=== DEBUG (8251) ===
● cloudcli-debug.service - CloudCLI Debug Server (Port 8251)
   Loaded: loaded (/etc/systemd/system/cloudcli-debug.service; enabled; vendor preset: enabled)
   Active: active (running) since Sat 2026-05-16 18:00:00 CST; 2h ago
 Main PID: 12345 (node)
    Tasks: 11 (limit: 11770)
   Memory: 180.5M
   CGroup: /system.slice/cloudcli-debug.service
           └─12345 /usr/bin/node dist-server/server/index.js
```

### 5.3 端口验证

```bash
# 检查两个端口都在监听
sudo ss -tlnp | grep -E "(8250|8251)"

# 预期输出：
# LISTEN  0  128  0.0.0.0:8250  0.0.0.0:*  users:(("node",pid=5678,...))
# LISTEN  0  128  0.0.0.0:8251  0.0.0.0:*  users:(("node",pid=12345,...))
```

### 5.4 一键管理脚本

将以下内容保存为 `~/.cloudli-manager.sh`：

```bash
#!/bin/bash
# CloudLI 双环境管理工具

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROD_PORT=8250
DEBUG_PORT=8251

show_help() {
    echo "CloudLI 双环境管理工具"
    echo ""
    echo "用法: $0 <命令>"
    echo ""
    echo "命令:"
    echo "  status      查看双环境状态"
    echo "  start       启动双环境"
    echo "  stop        停止双环境"
    echo "  restart     重启双环境"
    echo "  logs-prod   查看生产环境日志"
    echo "  logs-debug  查看调试环境日志"
    echo "  ports       检查端口占用"
    echo "  test        测试连接"
    echo "  help        显示帮助信息"
}

show_status() {
    echo -e "${BLUE}=== 生产环境 (端口 ${PROD_PORT}) ===${NC}"
    if command -v pm2 &>/dev/null; then
        pm2 list 2>/dev/null || echo -e "${YELLOW}PM2 未运行${NC}"
    else
        echo -e "${RED}PM2 未安装${NC}"
    fi
    
    echo ""
    echo -e "${BLUE}=== 调试环境 (端口 ${DEBUG_PORT}) ===${NC}"
    if systemctl is-active --quiet cloudcli-debug 2>/dev/null; then
        sudo systemctl status cloudcli-debug --no-pager | head -12
    else
        echo -e "${YELLOW}Debug 服务未运行${NC}"
    fi
}

start_services() {
    echo -e "${GREEN}启动生产环境...${NC}"
    cd /home/hxp/code/tools/claudecodeui 2>/dev/null
    sudo bash deploy-production.sh
    
    echo ""
    echo -e "${GREEN}启动调试环境...${NC}"
    sudo bash deploy-systemd.sh
    
    echo ""
    show_status
}

stop_services() {
    echo -e "${YELLOW}停止生产环境...${NC}"
    pm2 stop all 2>/dev/null || true
    
    echo -e "${YELLOW}停止调试环境...${NC}"
    sudo systemctl stop cloudcli-debug 2>/dev/null || true
    
    echo -e "${GREEN}双环境已停止${NC}"
}

restart_services() {
    stop_services
    sleep 2
    start_services
}

show_logs_prod() {
    echo -e "${BLUE}生产环境日志 (最近 50 行):${NC}"
    pm2 logs cloudcli --lines 50 --nostream 2>/dev/null
}

show_logs_debug() {
    echo -e "${BLUE}调试环境日志 (最近 50 行):${NC}"
    sudo journalctl -u cloudcli-debug -n 50 --no-pager 2>/dev/null
}

check_ports() {
    echo -e "${BLUE}端口占用情况:${NC}"
    sudo ss -tlnp | grep -E "(${PROD_PORT}|${DEBUG_PORT})" || echo -e "${YELLOW}未检测到端口监听${NC}"
}

test_connection() {
    echo -e "${BLUE}测试连接:${NC}"
    
    echo -n "生产环境 (${PROD_PORT}): "
    if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 http://localhost:${PROD_PORT}/ | grep -q "200"; then
        echo -e "${GREEN}✓ 正常 (HTTP 200)${NC}"
    else
        echo -e "${-red}✗ 无法连接${NC}"
    fi
    
    echo -n "调试环境 (${DEBUG_PORT}): "
    if curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 http://localhost:${DEBUG_PORT}/ | grep -q "200"; then
        echo -e "${GREEN}✓ 正常 (HTTP 200)${NC}"
    else
        echo -e "${RED}✗ 无法连接${NC}"
    fi
}

case "${1:-status}" in
    status)     show_status ;;
    start)      start_services ;;
    stop)       stop_services ;;
    restart)    restart_services ;;
    logs-prod)  show_logs_prod ;;
    logs-debug) show_logs_debug ;;
    ports)      check_ports ;;
    test)       test_connection ;;
    help|--help|-h) show_help ;;
    *)
        echo -e "${RED}未知命令: $1${NC}"
        show_help
        exit 1
        ;;
esac
```

**使用方法：**
```bash
chmod +x ~/.cloudli-manager.sh
alias cloudli='~/.cloudli-manager.sh'

# 常用命令
cloudli status       # 查看状态
cloudli start        # 启动双环境
cloudli restart      # 重启
cloudli logs-debug   # 查看调试日志
cloudli test         # 测试连接
```

---

## 6. 使用场景

### 6.1 日常开发流程

```
┌─────────────────────────────────────────────────────────────┐
│                     推荐工作流                               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 保持生产环境运行                                         │
│     └─ 用户正常使用 http://服务器:8250                       │
│                                                             │
│  2. 在调试环境开发新功能                                      │
│     ├─ 修改代码                                             │
│     ├─ npm run build:server                                 │
│     ├─ sudo systemctl restart cloudli-debug                 │
│     └─ 访问 http://服务器:8251 测试                          │
│                                                             │
│  3. 反复迭代直到满意                                          │
│     └─ 调试环境可以随意崩溃/重启，不影响生产                   │
│                                                             │
│  4. 发布到生产环境                                           │
│     └─ sudo bash deploy-production.sh                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 典型场景对照表

| 场景 | 推荐环境 | 原因 |
|------|---------|------|
| **日常开发新功能** | 调试环境 (8251) | 快速重启、详细日志、不影响用户 |
| **性能压测** | 生产环境 (8250) | 真实的 38 Worker 集群负载 |
| **Bug 复现与修复** | 调试环境 (8251) | Inspector 调试、完整堆栈跟踪 |
| **数据库迁移** | 调试环境 (8251) | 独立数据库，可随意修改/重置 |
| **安全审计** | 调试环境 (8251) | 可模拟攻击而不影响真实数据 |
| **演示给客户** | 生产环境 (8250) | 真实的高并发性能表现 |
| **培训新员工** | 调试环境 (8251) | 可以犯错、学习调试技巧 |
| **灰度发布** | 先调试后生产 | 在调试环境充分测试后再上线 |

---

## 7. 常见问题与故障排除

### 7.1 Redis 相关问题

#### Q1: Redis 启动超时

**症状：**
```
Job for redis-server.service failed because a timeout was exceeded.
```

**解决方案：**
```bash
# 1. 手动诊断
sudo journalctl -u redis-server --no-pager -n 50

# 2. 添加关键配置（如果缺少）
sudo bash -c 'cat >> /etc/redis/redis.conf <<EOF
supervised systemd
pidfile /run/redis/redis-server.pid
EOF'

# 3. 修复权限
sudo mkdir -p /var/lib/redis /var/log/redis /run/redis
sudo chown -R redis:redis /var/lib/redis /var/log/redis /run/redis

# 4. 清理旧进程并重启
sudo pkill -9 redis-server 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl start redis-server.service

# 5. 验证
redis-cli ping
# 预期输出: PONG
```

#### Q2: Redis 密码认证失败

**症状：**
```
NOAUTH Authentication required.
```

**解决方案：**
```bash
# 检查当前密码设置
sudo grep "^requirepass" /etc/redis/redis.conf

# 使用密码连接
redis-cli -a your-password ping

# 如果不需要密码（开发环境），可以注释掉
sudo sed -i 's/^requirepass/#requirepass/' /etc/redis/redis.conf
sudo systemctl restart redis-server
```

### 7.2 PM2 相关问题

#### Q3: PM2 启动后立即崩溃循环

**症状：**
```
pm2 list 显示 status 为 errored，↺ 重启次数很高
```

**常见原因及解决：**

**原因 A：端口被占用**
```bash
# 检查端口
sudo ss -tlnp | grep 8250

# 杀死占用进程
sudo fuser -k 8250/tcp

# 重启 PM2
pm2 restart all
```

**原因 B：数据库只读错误**
```
Error running migrations: attempt to write a readonly database
```

**解决方案：**
```bash
# 修复数据库目录权限
sudo chown -R $(whoami):$(whoami) /var/lib/cloudli
sudo chmod 755 /var/lib/cloudli
sudo chmod 644 /var/lib/cloudli/auth.db 2>/dev/null || true

# 重启
pm2 restart all
```

**原因 C：Node.js 内存不足**
```
FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory
```

**解决方案：**
```bash
# 增加 V8 堆内存限制
# 编辑 ecosystem.config.cjs
node_args: '--max-old-space-size=8192'  # 改为 8GB

# 重启
pm2 reload ecosystem.config.cjs
```

#### Q4: PM2 wait_ready 卡住

**症状：**
```
[PM2][WARN] App cloudcli has option 'wait_ready' set, waiting for app to be ready...
```

**原因：** 应用代码没有调用 `process.send('ready')`

**解决方案：**
```bash
# 方案 1（推荐）：移除 wait_ready 选项
# 编辑 ecosystem.config.cjs，删除或注释这行：
// wait_ready: true,

# 重启
pm2 reload ecosystem.config.cjs

# 方案 2：在应用代码中添加 ready 信号
# 在 server/index.js 的 server.listen 回调中添加：
process.send('ready');
```

### 7.3 Systemd 相关问题

#### Q5: 调试服务无法启动

**症状：**
```
● cloudcli-debug.service - Failed
```

**诊断步骤：**
```bash
# 1. 查看详细错误
sudo journalctl -u cloudcli-debug --no-pager -n 50

# 2. 检查服务配置语法
sudo systemd-analyze verify cloudcli-debug

# 3. 手动运行以获取错误信息
sudo -u hxp /usr/bin/node /home/hxp/code/tools/claudecodeui/dist-server/server/index.js

# 4. 检查端口是否被占用
sudo ss -tlnp | grep 8251
```

**常见问题：**

**问题 A：端口冲突**
```bash
# 解决：释放端口
sudo fuser -k 8251/tcp
sudo systemctl restart cloudcli-debug
```

**问题 B：用户权限不足**
```bash
# 检查当前用户
whoami

# 确保 service 文件中 User= 字段正确
sudo systemctl cat cloudcli-debug | grep User

# 修复文件权限
sudo chown -R hxp:hxp /home/hxp/code/tools/claudecodeui
sudo chown -R hxp:hxp /var/lib/cloudli-debug
```

#### Q6: Journalctl 日志不显示

**可能原因：**

1. **StandardOutput 不是 journal**
   ```bash
   # 检查配置
   sudo systemctl cat cloudcli-debug | grep StandardOutput
   
   # 应该是：
   # StandardOutput=journal
   ```

2. **日志被轮转清理**
   ```bash
   # 查看保留策略
   sudo journalctl --disk-usage
   
   # 增加保留大小
   sudo journalctl --vacation-size=500M
   ```

3. **过滤条件不对**
   ```bash
   # 确保服务名正确
   sudo journalctl -u cloudcli-debug --no-pager
   
   # 查看所有相关日志（包括内核消息）
   sudo journalctl _SYSTEMD_UNIT=cloudcli-debug.service --no-pager
   ```

### 7.4 数据库相关问题

#### Q7: SQLite 数据库锁定

**症状：**
```
database is locked
Error: SQLITE_BUSY: database is locked
```

**原因：** 多个进程同时写入同一数据库

**解决方案：**
```bash
# 1. 确保生产环境和调试环境使用不同数据库
# 生产: /var/lib/cloudli/auth.db
# 调试: /var/lib/cloudli-debug/auth.db

# 2. 检查是否有残留进程
ps aux | grep node | grep auth.db

# 3. 等待锁释放（通常几秒钟）
sleep 5

# 4. 如果仍然锁定，重启服务
sudo systemctl restart cloudcli-debug
# 或
pm2 restart all
```

#### Q8: 数据库损坏

**症状：**
```
malformed database schema
Error: file is not a database
```

**解决方案：**
```bash
# 1. 备份（如果能打开的话）
cp /var/lib/cloudli-debug/auth.db /var/lib/cloudli-debug/auth.db.backup.$(date +%Y%m%d)

# 2. 删除损坏的数据库
rm /var/lib/cloudli-debug/auth.db

# 3. 重启服务（会自动重建）
sudo systemctl restart cloudli-debug

# 4. 验证新建的数据库
sqlite3 /var/lib/cloudli-debug/auth.db ".schema"
```

### 7.5 性能问题

#### Q9: 响应很慢

**诊断步骤：**
```bash
# 1. 检查系统资源
top -bn1 | head -20
free -h

# 2. 检查 PM2 Worker 状态
pm2 monit
# 观察 CPU 和 Memory 是否接近上限

# 3. 检查 Redis 性能
redis-cli info stats
# 关注: instantaneous_ops_per_sec, used_memory_human

# 4. 检查网络连接数
sudo ss -s

# 5. 检查磁盘 I/O
iostat -x 1 5
```

**优化建议：**
```bash
# 1. 增加 Worker 数量（如果 CPU 利用率低）
sudo WORKERS=40 bash deploy-production.sh

# 2. 减少单个 Worker 内存（如果有 OOM）
sudo MAX_MEMORY=2G bash deploy-production.sh

# 3. 启用 Gzip 压缩（在 Nginx 层）
# 详见第 8 章

# 4. 优化 Redis 配置
# 编辑 /etc/redis/redis.conf
maxmemory 2gb
maxmemory-policy allkeys-lru
```

---

## 8. 性能调优

### 8.1 系统内核参数优化

生产环境部署脚本会自动配置 `/etc/sysctl.d/99-cloudcli.conf`：

```bash
# TCP 连接队列
net.core.somaxconn=65535
net.ipv4.tcp_max_syn_backlog=65535

# 端口范围
net.ipv4.ip_local_port_range=1024 65535

# TCP 快速回收
net.ipv4.tcp_tw_reuse=1
net.ipv4.tcp_fin_timeout=15
net.ipv4.tcp_keepalive_time=300
net.ipv4.tcp_keepalive_intvl=30
net.ipv4.tcp_keepalive_probes=3

# 文件描述符限制
fs.file-max=1048576

# 内存分配策略
vm.overcommit_memory=1
vm.swappiness=10
```

**手动应用：**
```bash
sudo sysctl -p /etc/sysctl.d/99-cloudcli.conf

# 验证
sysctl net.core.somaxconn
# 预期: net.core.somaxconn = 65535
```

### 8.2 文件描述符限制

生产环境会配置 `/etc/security/limits.d/99-cloudcli.conf`：

```
* soft nofile 1048576
* hard nofile 1048576
* soft nproc 8192
* hard nproc 8192
```

**验证当前限制：**
```bash
ulimit -n
ulimit -u

# 对于正在运行的进程
cat /proc/$(pgrep -f "node.*index.js")/limits | grep "open files"
```

### 8.3 Redis 性能优化

**Redis 配置文件 `/etc/redis/redis.conf` 关键参数：**

```conf
# 内存限制（根据服务器内存调整）
maxmemory 4gb
maxmemory-policy allkeys-lru  # LRU 淘汰策略

# 持久化优化（调试环境可关闭以提升性能）
save ""                         # 禁用 RDB 快照
appendonly no                   # 禁用 AOF 日志

# 网络优化
tcp-backlog 65535
timeout 0                       # 不关闭空闲连接
tcp-keepalive 300

# 客户端连接数
maxclients 10000

# 线程模型（Redis 6.0+）
io-threads 4                    # I/O 线程数（不超过 CPU 核心数的 3/4）
```

**重启 Redis 生效：**
```bash
sudo systemctl restart redis-server
redis-cli info memory | grep used_memory_human
```

### 8.4 Node.js 应用层优化

#### V8 引擎参数

```javascript
// ecosystem.config.cjs
node_args: [
  '--max-old-space-size=4096',     // 堆内存上限 4GB
  '--optimize-for-size',           // 优化内存占用
  '--always-compact',             // 积极垃圾回收
  '--gc-interval=100',            // GC 间隔（毫秒）
].join(' ')
```

#### Cluster 模式调优

```javascript
// Worker 数量计算公式
const os = require('os');
const cpus = os.cpus().length;
const workers = Math.max(cpus - 2, 1);  // 保留 2 核给系统/Redis

console.log(`推荐 Worker 数量: ${workers}`);
// 40 核 CPU → 38 Workers
```

#### 连接池配置

在应用代码中调整：

```javascript
// Redis 连接池
const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  keepAlive: 10000,
  connectionName: 'cloudcli-worker-' + process.pid,
});
```

### 8.5 Nginx 反向代理优化（可选）

如果启用 Nginx，配置 `/etc/nginx/sites-available/cloudcli`：

```nginx
upstream cloudcli_backend {
    least_conn;                    # 最少连接调度
    server 127.0.0.1:8250;
    keepalive 64;                  # Keep-Alive 连接池
}

server {
    listen 80;
    server_name your-domain.com;

    # Gzip 压缩
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain application/json application/javascript text/css;

    # 缓存静态资源
    location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # 反向代理到 Node.js
    location / {
        proxy_pass http://cloudcli_backend;
        proxy_http_version 1.1;
        
        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;
        
        # 头部转发
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 限制请求体大小（文件上传）
    client_max_body_size 100m;
}
```

**启用 Nginx 部署：**
```bash
sudo ENABLE_NGINX=true NGINX_DOMAIN=your-domain.com bash deploy-production.sh
```

---

## 9. 安全建议

### 9.1 网络安全

#### 防火墙配置

```bash
# 使用 ufw
sudo ufw allow 8250/tcp    # 生产环境
sudo ufw allow 8251/tcp    # 调试环境（仅内网）
sudo ufw allow 22/tcp      # SSH
sudo ufw enable

# 或使用 iptables
sudo iptables -A INPUT -p tcp --dport 8250 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 8251 -s 192.168.1.0/24 -j ACCEPT  # 仅内网可访问调试端口
```

#### 调试环境限制访问

```bash
# 方法 1：绑定到 localhost（仅本机访问）
sudo systemctl edit cloudcli-debug
# 添加:
# [Service]
# Environment="SERVER_HOST=127.0.0.1"

# 方法 2：通过防火墙限制 IP
sudo iptables -A INPUT -p tcp --dport 8251 ! -s 你的IP地址 -j DROP

# 方法 3：使用 SSH 隧道（推荐远程调试）
ssh -L 8251:localhost:8251 user@server
# 然后在本地浏览器访问 http://localhost:8251
```

### 9.2 Redis 安全

```bash
# 1. 设置强密码
sudo sed -i 's/^requirepass.*/requirepass YourStrongPasswordHere/' /etc/redis/redis.conf

# 2. 绑定到 localhost（禁止外部访问）
sudo sed -i 's/^bind.*/bind 127.0.0.1/' /etc/redis/redis.conf

# 3. 禁用危险命令
sudo sed -i 's/^rename-command CONFIG/rename-config CONFIG ""/' /etc/redis/redis.conf
sudo sed -i 's/^rename-command FLUSHALL/rename-flushall FLUSHALL ""/' /etc/redis/redis.conf

# 4. 重启 Redis
sudo systemctl restart redis-server

# 5. 验证
redis-cli -a YourStrongPasswordHere ping
```

### 9.3 文件权限

```bash
# 项目目录权限
sudo chmod 755 /home/hxp/code/tools/claudecodeui
sudo chown -R hxp:hxp /home/hxp/code/tools/claudecodeui

# 数据库目录权限（仅应用用户可读写）
sudo chmod 750 /var/lib/cloudli
sudo chmod 750 /var/lib/cloudli-debug
sudo chown -R hxp:hxp /var/lib/cloudli /var/lib/cloudli-debug

# 日志文件权限
sudo chmod 644 /home/hxp/code/tools/claudecodeui/logs/*.log

# 配置文件权限（仅 root 可写）
sudo chmod 644 /etc/systemd/system/cloudcli*.service
sudo chmod 600 /etc/redis/redis.conf
```

### 9.4 日志安全

```bash
# 1. 防止日志泄露敏感信息
# 在应用代码中过滤：
# - 密码
# - Token
# - 用户个人信息

# 2. 日志轮转（防止磁盘占满）
# PM2 已配置 log_rotate 和 log_retain
# Systemd 使用 journald 自动管理

# 3. 敏感日志脱敏示例（伪代码）
function sanitizeLog(log) {
  return log
    .replace(/password=\S+/g, 'password=***')
    .replace(/token=\S+/g, 'token=***');
}
```

### 9.5 定期维护任务

```bash
# 创建 cron 任务进行定期维护
sudo crontab -e

# 添加以下内容：

# 每天凌晨 3 点清理旧日志（保留 30 天）
0 3 * * * find /home/hxp/code/tools/claudecodeui/logs -name "*.log" -mtime +30 -delete

# 每周日凌晨 4 点备份数据库
0 4 * * 0 cp /var/lib/cloudli/auth.db /backups/cloudli/auth.db.$(date +\%Y\%m\%d)

# 每月 1 号检查磁盘空间
0 5 1 * * df -h | mail -s "Disk Usage Report" admin@example.com

# 每小时检查服务状态
0 * * * * pm2 list >> /var/log/pm2-status.log 2>&1 || echo "PM2 issue at $(date)" | mail -s "PM2 Alert" admin@example.com
```

---

## 附录 A：快速参考卡

### 生产环境 (8250) 常用命令

```bash
# 部署
sudo bash deploy-production.sh

# 管理
pm2 list                           # 状态
pm2 monit                          # 监控
pm2 logs cloudcli -f               # 日志
pm2 restart all                    # 重启
pm2 reload cloudcli                # 零停机重载
pm2 stop all                       # 停止
pm2 delete all                     # 删除

# 故障排查
pm2 prettylist                     # 详细信息
pm2 show cloudcli                  # 进程详情
pm2 logs cloudcli --err            # 错误日志
```

### 调试环境 (8251) 常用命令

```bash
# 部署
sudo bash deploy-systemd.sh
sudo ENABLE_INSPECTOR=true bash deploy-systemd.sh  # 启用 DevTools

# 管理
sudo systemctl status cloudcli-debug               # 状态
sudo journalctl -u cloudcli-debug -f               # 实时日志
sudo systemctl restart cloudli-debug               # 重启
sudo systemctl stop cloudli-debug                  # 停止

# 高级调试
sudo DEBUG_LOG_LEVEL=debug bash deploy-systemd.sh  # 详细日志
sudo systemctl set-environment DEBUG=*             # 临时环境变量
sudo journalctl -u cloudli-debug -g "Error" -f     # 过滤关键词
```

### 双环境管理

```bash
# 一键命令（需先定义别名）
both-start        # 启动双环境
both-stop         # 停止双环境
both-status       # 查看状态
cloudli status    # 使用管理脚本
cloudli test      # 测试连接
```

---

## 附录 B：环境变量速查表

### deploy-production.sh

| 变量名 | 默认值 | 说明 |
|--------|-------|------|
| `PORT` | `8250` | 服务端口 |
| `WORKERS` | 自动计算 | PM2 Worker 数量 |
| `MAX_MEMORY` | `4G` | 每个 Worker 内存限制 |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis 连接地址 |
| `REDIS_PASSWORD` | 空 | Redis 密码 |
| `ENABLE_NGINX` | `false` | 是否启用 Nginx |
| `NGINX_DOMAIN` | `your-domain.com` | 域名 |
| `DEPLOY_MODE` | `pm2` | 部署模式 (pm2/systemd) |

### deploy-systemd.sh

| 变量名 | 默认值 | 说明 |
|--------|-------|------|
| `PORT` | `8251` | 调试端口 |
| `SERVICE_NAME` | `cloudli-debug` | Systemd 服务名 |
| `DATA_DIR` | `/var/lib/cloudli-debug` | 数据目录 |
| `DEBUG_LOG_LEVEL` | `debug` | 日志级别 |
| `ENABLE_INSPECTOR` | `false` | 是否启用 Inspector |
| `DEPLOY_MODE` | `systemd` | 部署模式 |
| `WORKERS` | `1` | PM2 模式时的 Worker 数 |

---

## 附录 C：文件位置速查

| 文件/目录 | 用途 |
|----------|------|
| `/home/hxp/code/tools/claudecodeui/deploy-production.sh` | 生产部署脚本 |
| `/home/hxp/code/tools/claudecodeui/deploy-systemd.sh` | 调试部署脚本 |
| `/home/hxp/code/tools/claudecodeui/ecosystem.config.cjs` | PM2 配置文件 |
| `/etc/systemd/system/cloudcli-debug.service` | 调试环境 Systemd 服务 |
| `/var/lib/cloudli/auth.db` | 生产环境 SQLite 数据库 |
| `/var/lib/cloudli-debug/auth.db` | 调试环境 SQLite 数据库 |
| `/var/lib/cloudli/` | 生产环境数据目录 |
| `/var/lib/cloudli-debug/` | 调试环境数据目录 |
| `/etc/redis/redis.conf` | Redis 配置文件 |
| `/etc/sysctl.d/99-cloudcli.conf` | 内核参数优化 |
| `/etc/security/limits.d/99-cloudli.conf` | 文件描述符限制 |
| `~/.pm2/logs/` | PM2 日志目录 |
| `./logs/` | 应用日志目录 |
| journald | Systemd 日志（调试环境） |

---

## 附录 D：版本历史

| 版本 | 日期 | 变更说明 |
|------|------|---------|
| v1.0 | 2026-05-16 | 初始版本，支持双环境部署 |
| v1.1 | 2026-05-16 | 修复 Redis 超时问题、移除 wait_ready、优化调试功能 |
| v1.2 | 2026-05-16 | 添加 Inspector 支持、详细日志、完善文档 |

---

## 附录 E：贡献与反馈

如发现问题或有改进建议，欢迎反馈！

**常见反馈渠道：**
- GitHub Issues（如有仓库）
- 邮件联系
- 文档评论区

---

**文档最后更新：** 2026-05-16  
**适用版本：** deploy-production.sh v1.2+, deploy-systemd.sh v1.2+  
**作者：** AI Assistant  
**许可证：** MIT