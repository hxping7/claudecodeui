#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# CloudCLI 部署脚本 - 支持 systemd 和 PM2 集群模式
# =============================================================================
# 使用方法:
#   # systemd 模式 (单进程，适合小规模)
#   sudo ./deploy-systemd.sh
#
#   # PM2 集群模式 (多进程，适合 50+ 用户)
#   sudo DEPLOY_MODE=pm2 ./deploy-systemd.sh
#
#   # 自定义配置
#   sudo ./deploy-systemd.sh APP_DIR=/path/to/app PORT=8250 WORKERS=8
# =============================================================================

# 默认配置
APP_DIR_DEFAULT="/home/hxp/code/tools/claudecodeui"
SERVICE_NAME_DEFAULT="cloudcli"
PORT_DEFAULT="8250"
DATA_DIR_DEFAULT="/var/lib/cloudcli"
DEPLOY_MODE_DEFAULT="systemd"
WORKERS_DEFAULT=4
MAX_MEMORY_DEFAULT="2G"

# 从环境变量或参数读取配置
APP_DIR="${APP_DIR:-$APP_DIR_DEFAULT}"
SERVICE_NAME="${SERVICE_NAME:-$SERVICE_NAME_DEFAULT}"
PORT="${PORT:-$PORT_DEFAULT}"
PLATFORM_MODE="${PLATFORM_MODE:-false}"
DATA_DIR="${DATA_DIR:-$DATA_DIR_DEFAULT}"
DEPLOY_MODE="${DEPLOY_MODE:-$DEPLOY_MODE_DEFAULT}"
WORKERS="${WORKERS:-$WORKERS_DEFAULT}"
MAX_MEMORY="${MAX_MEMORY:-$MAX_MEMORY_DEFAULT}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# =============================================================================
# 前提条件检查
# =============================================================================

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  log_error "请使用 root 权限运行: sudo $0"
  exit 1
fi

if [[ ! -d "$APP_DIR" ]]; then
  log_error "APP_DIR 不存在: $APP_DIR"
  exit 1
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  log_error "系统中未找到 node 命令"
  exit 1
fi

# 检查 PM2
if [[ "$DEPLOY_MODE" == "pm2" ]]; then
  if ! command -v pm2 &> /dev/null; then
    log_warn "PM2 未安装，正在安装..."
    npm install -g pm2
  fi
  log_info "PM2 版本: $(pm2 --version 2>/dev/null || echo 'unknown')"
fi

# 检查构建产物
if [[ ! -f "$APP_DIR/dist-server/server/index.js" ]]; then
  log_warn "项目未构建，请先运行: cd $APP_DIR && npm run build"
  exit 1
fi

# =============================================================================
# 配置
# =============================================================================

mkdir -p "$APP_DIR/logs"
mkdir -p "$DATA_DIR"

DEFAULT_SYSTEM_DB="${DATA_DIR}/auth.db"
DATABASE_PATH="${DATABASE_PATH:-$DEFAULT_SYSTEM_DB}"
export DATABASE_PATH

log_info "部署模式: $DEPLOY_MODE"
log_info "工作目录: $APP_DIR"
log_info "服务端口: $PORT"

# =============================================================================
# 部署
# =============================================================================

case "$DEPLOY_MODE" in
  pm2)  deploy_pm2 ;;
  *)    deploy_systemd ;;
esac

# =============================================================================
# systemd 模式
# =============================================================================

deploy_systemd() {
  log_info "部署 systemd 服务..."

  UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

  cat > "$UNIT_PATH" <<EOF
[Unit]
Description=CloudCLI Web UI (${SERVICE_NAME})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=SERVER_PORT=${PORT}
Environment=VITE_IS_PLATFORM=${PLATFORM_MODE}
Environment=DATABASE_PATH=${DATABASE_PATH}
Environment=NODE_OPTIONS="--max-old-space-size=4096"
ExecStart=${NODE_BIN} ${APP_DIR}/dist-server/server/index.js
Restart=on-failure
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30
LimitNOFILE=1048576
LimitNPROC=8192
MemoryMax=8G

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}.service"
  systemctl restart "${SERVICE_NAME}.service"

  sleep 2

  if systemctl is-active --quiet "${SERVICE_NAME}"; then
    log_success "服务已启动: ${SERVICE_NAME}"
  else
    log_error "服务启动失败"
    journalctl -u "${SERVICE_NAME}" --no-pager -n 20
    exit 1
  fi
}

# =============================================================================
# PM2 模式
# =============================================================================

deploy_pm2() {
  log_info "部署 PM2 集群模式..."

  cat > "$APP_DIR/ecosystem.config.cjs" <<EOF
module.exports = {
  apps: [{
    name: '${SERVICE_NAME}',
    script: './dist-server/server/index.js',
    instances: ${WORKERS},
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      SERVER_PORT: ${PORT},
      DATABASE_PATH: '${DATABASE_PATH}'
    },
    max_memory_restart: '${MAX_MEMORY}',
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    log_rotate: true,
    log_max_size: '50M',
    log_retain: 7,
    restart_delay: 3000,
    max_restarts: 10,
    min_uptime: '10s',
    autorestart: true,
    watch: false,
    kill_timeout: 10000,
    wait_ready: true,
    listen_timeout: 10000
  }]
};
EOF

  cd "$APP_DIR"
  pm2 delete "$SERVICE_NAME" 2>/dev/null || true
  pm2 start ecosystem.config.cjs
  pm2 save

  sleep 2
  log_success "PM2 集群已��动 (workers: $WORKERS)"
}

# =============================================================================
# 完成
# =============================================================================

echo ""
echo "=============================================="
echo -e "  ${GREEN}部署完成${NC}"
echo "=============================================="
echo "模式: $DEPLOY_MODE"
echo "端口: $PORT"
echo ""

if [[ "$DEPLOY_MODE" == "pm2" ]]; then
  echo "命令: pm2 status | logs ${SERVICE_NAME} | restart ${SERVICE_NAME}"
else
  echo "命令: systemctl status ${SERVICE_NAME} | restart ${SERVICE_NAME}"
fi

echo "地址: http://localhost:${PORT}"