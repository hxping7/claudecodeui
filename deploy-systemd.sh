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
#
#   # Git pull 模式 (部署前先拉取最新代码)
#   sudo ./deploy-systemd.sh --git-pull
#
#   # 卸载
#   sudo ./deploy-systemd.sh --uninstall
# =============================================================================

# ---- 配置区域 ----
APP_DIR_DEFAULT="/home/hxp/code/tools/claudecodeui"
SERVICE_NAME_DEFAULT="cloudcli-debug"
DATA_DIR_DEFAULT="/var/lib/cloudcli-debug"
DEPLOY_MODE_DEFAULT="systemd"
WORKERS_DEFAULT=4
MAX_MEMORY_DEFAULT="2G"
REDIS_URL_DEFAULT="redis://127.0.0.1:6379"

# 部署配置文件 (持久化配置, 调试模式单独配置)
DEPLOY_CONF="/etc/cloudcli/deploy-debug.conf"

# 保存命令行传入的环境变量 (优先级最高)
CUSTOM_PORT="${PORT:-}"
CUSTOM_WORKERS="${WORKERS:-}"
CUSTOM_DEPLOY_MODE="${DEPLOY_MODE:-}"

# 从配置文件加载 (如果存在)
if [[ -f "$DEPLOY_CONF" ]]; then
  source "$DEPLOY_CONF"
fi

# 命令行环境变量覆盖配置文件
[[ -n "$CUSTOM_PORT" ]] && PORT="$CUSTOM_PORT"
[[ -n "$CUSTOM_WORKERS" ]] && WORKERS="$CUSTOM_WORKERS"
[[ -n "$CUSTOM_DEPLOY_MODE" ]] && DEPLOY_MODE="$CUSTOM_DEPLOY_MODE"

# 从环境变量或参数读取配置 (最终默认值)
APP_DIR="${APP_DIR:-$APP_DIR_DEFAULT}"
SERVICE_NAME="${SERVICE_NAME:-$SERVICE_NAME_DEFAULT}"
PORT_DEFAULT="8251"
PORT="${PORT:-$PORT_DEFAULT}"
PLATFORM_MODE="${PLATFORM_MODE:-false}"
DATA_DIR="${DATA_DIR:-$DATA_DIR_DEFAULT}"
DEPLOY_MODE="${DEPLOY_MODE:-$DEPLOY_MODE_DEFAULT}"
WORKERS="${WORKERS:-$WORKERS_DEFAULT}"
MAX_MEMORY="${MAX_MEMORY:-$MAX_MEMORY_DEFAULT}"
REDIS_URL="${REDIS_URL:-$REDIS_URL_DEFAULT}"

# ---- 解析命令行参数 ----
UNINSTALL_MODE=false
GIT_PULL_MODE=false
for arg in "$@"; do
  case "$arg" in
    --uninstall|-u)
      UNINSTALL_MODE=true
      ;;
    --git-pull|--pull)
      GIT_PULL_MODE=true
      ;;
    --help|-h)
      echo "用法:"
      echo "  $0                              # 安装部署"
      echo "  $0 --uninstall                  # 卸载删除"
      echo "  $0 --git-pull                  # 部署前先 git pull 拉取最新代码"
      echo ""
      echo "环境变量:"
      echo "  PORT=8251                       # 服务端口 (默认 8251)"
      echo "  WORKERS=4                       # PM2 worker 数量"
      echo "  DEPLOY_MODE=systemd|pm2        # 部署模式"
      echo "  DATA_DIR=/var/lib/cloudcli     # 数据目录"
      exit 0
      ;;
  esac
done

# ---- 自动计算资源分配 ----
CPU_CORES=$(nproc 2>/dev/null || echo 4)
TOTAL_MEM_GB=$(free -g 2>/dev/null | awk '/^Mem:/{print $2}' || echo 8)

# ---- 颜色输出 ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $(date '+%H:%M:%S') $*"; }
log_success() { echo -e "${GREEN}[✓]${NC} $(date '+%H:%M:%S') $*"; }
log_warn() { echo -e "${YELLOW}[!]${NC} $(date '+%H:%M:%S') $*"; }
log_error() { echo -e "${RED}[✗]${NC} $(date '+%H:%M:%S') $*"; }
log_step() { echo -e "\n${CYAN}[▶]${NC} ${CYAN}$*${NC}"; }

# =============================================================================
# 幂等性工具函数 (安全重复执行支持)
# =============================================================================

backup_config() {
  local FILE="$1"
  local MAX_BACKUPS=5

  if [[ -f "$FILE" ]]; then
    local TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    local BACKUP_FILE="${FILE}.bak.${TIMESTAMP}"
    cp -a "$FILE" "$BACKUP_FILE" 2>/dev/null || return 1
    log_info "已备份: $(basename $FILE) → $(basename $BACKUP_FILE)"
    ls -t "${FILE}".bak.* 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs rm -f 2>/dev/null || true
    return 0
  fi
  return 1
}

safe_write_config() {
  local FILE="$1"
  local CONTENT="$2"
  local DESCRIPTION="${3:-配置文件}"

  if [[ -f "$FILE" ]]; then
    local OLD_MD5=$(md5sum "$FILE" 2>/dev/null | cut -d' ' -f1)
    local NEW_MD5=$(echo "$CONTENT" | md5sum | cut -d' ' -f1)

    if [[ "$OLD_MD5" == "$NEW_MD5" ]]; then
      log_info "${DESCRIPTION} 无变化, 跳过"
      return 0
    fi

    log_warn "检测到现有 ${DESCRIPTION}: $FILE"
    backup_config "$FILE"
  else
    log_info "创建新 ${DESCRIPTION}: $FILE"
  fi

  echo "$CONTENT" > "$FILE"
}

check_service_status() {
  local SERVICE_NAME="$1"

  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "running"
    return 0
  elif systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "stopped"
    return 1
  else
    echo "not_installed"
    return 2
  fi
}

# =============================================================================
# 智能源码更新检测与构建
# =============================================================================
check_and_build() {
  local DIST_ENTRY="$APP_DIR/dist-server/server/index.js"
  local SRC_DIR="$APP_DIR/src"
  local BUILD_MARKER="$APP_DIR/.last_build_time"

  # ---- 可选: Git Pull ----
  if [[ "$GIT_PULL_MODE" == "true" ]] && [[ -d "$APP_DIR/.git" ]]; then
    log_step "Git Pull (拉取最新代码)"
    cd "$APP_DIR"
    log_info "正在从远程仓库拉取最新代码..."
    echo "   当前分支: $(git branch --show-current)"

    if git pull --ff-only; then
      log_success "Git pull 成功"
    else
      log_warn "Git pull 失败或存在冲突，将使用本地代码..."
    fi
    echo ""
  fi

  # ---- 场景 1: 首次部署 ----
  if [[ ! -f "$DIST_ENTRY" ]]; then
    log_step "构建项目 (首次部署)"
    log_info "检测到未构建的项目, 执行 npm run build..."

    (cd "$APP_DIR" && npm run build) || {
      log_error "构建失败!"
      log_error "请手动执行: cd $APP_DIR && npm run build"
      exit 1
    }

    date +%s > "$BUILD_MARKER"
    log_success "首次构建完成"
    return 0
  fi

  # ---- 场景 2: 重复部署 (检测源码是否更新) ----
  log_info "检测源码更新..."

  local NEED_REBUILD=false
  local UPDATE_REASON=""

  # Git 状态检测
  if [[ -d "$APP_DIR/.git" ]]; then
    if ! git diff --quiet HEAD -- "$SRC_DIR" 2>/dev/null; then
      NEED_REBUILD=true
      UPDATE_REASON="检测到源码文件已修改"
    fi

    if [[ -f "$BUILD_MARKER" ]]; then
      local LAST_BUILD=$(cat "$BUILD_MARKER")
      local LATEST_COMMIT=$(git log -1 --format=%ct 2>/dev/null || echo 0)
      if [[ "$LATEST_COMMIT" -gt "$LAST_BUILD" ]]; then
        NEED_REBUILD=true
        UPDATE_REASON="检测到新的 git commit"
      fi
    fi
  fi

  # 文件时间戳比较 (备用方案)
  if [[ "$NEED_REBUILD" == "false" ]] && [[ -d "$SRC_DIR" ]]; then
    local DIST_TIME=$(stat -c %Y "$DIST_ENTRY" 2>/dev/null || echo 0)
    local NEWEST_SRC=$(find "$SRC_DIR" -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.vue" \) 2>/dev/null | xargs stat -c %Y 2>/dev/null | sort -n | tail -1 || echo 0)
    if [[ "$NEWEST_SRC" -gt "$DIST_TIME" ]]; then
      NEED_REBUILD=true
      UPDATE_REASON="检测到源码文件比构建产物新"
    fi
  fi

  # ---- 执行构建决策 ----
  if [[ "$NEED_REBUILD" == "true" ]]; then
    echo ""
    log_warn "检测到源码更新，需要重新构建"
    echo "   原因: ${UPDATE_REASON}"
    echo ""
    log_info "数据安全保障: 用户数据库和会话数据不会被删除"
    echo ""

    log_info "正在执行 npm run build..."
    local START_TIME=$(date +%s)

    (cd "$APP_DIR" && npm run build) || {
      log_error "构建失败! 旧版本仍在运行"
      log_error "请检查源码错误后重试: cd $APP_DIR && npm run build"
      exit 1
    }

    local END_TIME=$(date +%s)
    local DURATION=$((END_TIME - START_TIME))
    date +%s > "$BUILD_MARKER"
    log_success "重新构建完成 (${DURATION}s)"
  else
    log_success "源码无变化, 跳过构建"
  fi

  return 0
}

# =============================================================================
# JWT Secret 管理
# =============================================================================
setup_jwt_secret() {
  local JWT_SECRET_FILE="${DATA_DIR}/.jwt_secret"
  JWT_SECRET=""

  if [[ -n "${JWT_SECRET_ENV:-}" ]]; then
    JWT_SECRET="$JWT_SECRET_ENV"
    log_info "使用环境变量指定的 JWT_SECRET"
  elif [[ -f "$JWT_SECRET_FILE" ]]; then
    JWT_SECRET=$(cat "$JWT_SECRET_FILE" | tr -d '[:space:]')
    if [[ -n "$JWT_SECRET" ]] && [[ ${#JWT_SECRET} -ge 16 ]]; then
      log_info "从配置文件加载 JWT_SECRET (已存在)"
    else
      log_warn "JWT_SECRET 文件无效, 将重新生成"
      JWT_SECRET=""
    fi
  fi

  if [[ -z "$JWT_SECRET" ]]; then
    JWT_SECRET=$(head -c 64 /dev/urandom | base64 | head -c 64 | tr -d '\n')
    echo -n "$JWT_SECRET" > "$JWT_SECRET_FILE"
    chmod 600 "$JWT_SECRET_FILE"
    log_info "已生成新的 JWT_SECRET 并保存"
  fi

  export JWT_SECRET="$JWT_SECRET"
  log_success "JWT Secret 已配置 (${#JWT_SECRET} 字符)"
}

# =============================================================================
# 系统内核参数优化
# =============================================================================
configure_system_tuning() {
  log_step "系统内核参数优化 (高并发调优)"

  local SYSCTL_CONF="/etc/sysctl.d/99-cloudcli-debug.conf"

  # 生成 sysctl 配置
  cat > "$SYSCTL_CONF" <<EOF
# CloudCLI Debug 高并发内核参数优化
fs.file-max = 1048576
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_max_tw_buckets = 262144
vm.swappiness = 10
EOF

  safe_write_config "$SYSCTL_CONF" "$(cat "$SYSCTL_CONF")" "系统内核参数配置"
  sysctl -p "$SYSCTL_CONF" 2>/dev/null || sysctl --system

  # 用户资源限制
  local LIMITS_CONF="/etc/security/limits.d/99-cloudcli-debug.conf"
  cat > "$LIMITS_CONF" <<EOF
# CloudCLI Debug 用户资源限制
*          soft    nofile      1048576
*          hard    nofile      1048576
*          soft    nproc       65535
*          hard    nproc       65535
root       soft    nofile      1048576
root       hard    nofile      1048576
EOF

  safe_write_config "$LIMITS_CONF" "$(cat "$LIMITS_CONF")" "文件描述符限制配置"

  log_success "内核参数优化完成"
}

check_prerequisites() {
  log_step "环境前置检查"

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
    log_error "未找到 Node.js"
    exit 1
  fi

  NODE_VERSION=$($NODE_BIN --version 2>/dev/null || echo "unknown")
  log_info "Node.js 版本: $NODE_VERSION"

  # 检查 PM2
  if [[ "$DEPLOY_MODE" == "pm2" ]]; then
    if ! command -v pm2 &> /dev/null; then
      log_warn "PM2 未安装，正在安装..."
      npm install -g pm2
    fi
    log_info "PM2 版本: $(pm2 --version 2>/dev/null || echo 'unknown')"
  fi

  # 智能源码更新检测与构建
  check_and_build

  # 创建必要目录
  mkdir -p "$APP_DIR/logs"
  mkdir -p "$DATA_DIR"
  mkdir -p "/var/log/$SERVICE_NAME" 2>/dev/null || true

  DEFAULT_SYSTEM_DB="${DATA_DIR}/auth.db"
  DATABASE_PATH="${DATABASE_PATH:-$DEFAULT_SYSTEM_DB}"
  export DATABASE_PATH

  # JWT Secret 管理
  setup_jwt_secret

  log_success "前置检查通过"
  show_system_info

  # 生成/更新部署配置文件
  generate_deploy_config
}

show_system_info() {
  log_info "=============================================="
  log_info "  系统资源检测报告"
  log_info "=============================================="
  log_info "操作系统: $(lsb_release -ds 2>/dev/null || cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2 || echo 'Linux')"
  log_info "CPU 核心: ${CPU_CORES} 核"
  log_info "总内存:   ${TOTAL_MEM_GB} GB"
  log_info "可用内存: $(free -g 2>/dev/null | awk '/^Mem:/{print $7}' || echo 'N/A') GB"
  log_info "磁盘空间: $(df -h "$APP_DIR" 2>/dev/null | awk 'NR==2{print $4}' || echo 'N/A') 可用"
  log_info ""
  log_info "资源分配方案:"
  log_info "  部署模式: ${DEPLOY_MODE}"
  log_info "  端口: ${PORT}"
  if [[ "$DEPLOY_MODE" == "pm2" ]]; then
    log_info "  PM2 Workers: ${WORKERS} 进程"
    log_info "  Worker 内存: ${MAX_MEMORY}/进程"
  fi
  log_info "=============================================="
}

generate_deploy_config() {
  if [[ ! -f "$DEPLOY_CONF" ]]; then
    mkdir -p "$(dirname "$DEPLOY_CONF")" 2>/dev/null || true
    cat > "$DEPLOY_CONF" <<EOF
# CloudCLI Debug 部署配置 (Systemd 单实例 / PM2 集群)
# 位置: /etc/cloudcli/deploy-debug.conf
# 修改后重新运行部署脚本即可生效: sudo bash deploy-systemd.sh

# =============================================================================
# 端口配置 (防火墙规则自动同步)
# =============================================================================
# PORT - 应用调试端口 (Systemd 单实例模式, 与生产环境端口不同!)
#   默认值: 8251 | 与生产环境 8250 端口隔离, 互不影响
PORT=${PORT}

# WORKERS - 进程数 (systemd 模式通常为 1, PM2 模式可多进程)
WORKERS=${WORKERS}

# DATA_DIR - 数据存储目录 (独立于生产环境, 避免冲突)
DATA_DIR=${DATA_DIR}

# DEPLOY_MODE - 部署模式 (systemd 单实例 / pm2 集群)
DEPLOY_MODE=${DEPLOY_MODE}

# REDIS_URL - Redis 连接地址
REDIS_URL=${REDIS_URL}
EOF
    chmod 644 "$DEPLOY_CONF"
    log_info "已生成部署配置文件: ${DEPLOY_CONF}"
  else
    log_info "部署配置文件已存在: ${DEPLOY_CONF}"
  fi
  log_info "服务端口: $PORT"
}

# =============================================================================
# 部署
# =============================================================================

# 注意: case 语句移到 main 函数中调用

# =============================================================================
# systemd 模式
# =============================================================================

deploy_systemd() {
  log_step "部署 systemd 服务..."

  # 应用系统调优
  configure_system_tuning

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
Environment=USE_REDIS=${USE_REDIS:-false}
Environment=REDIS_URL=${REDIS_URL}
Environment=AUTH_MODE=${AUTH_MODE:-linux}
Environment=JWT_SECRET=${JWT_SECRET}
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
  log_step "部署 PM2 集群模式 (${WORKERS} Workers)..."

  # 应用系统调优
  configure_system_tuning

  # 安装 PM2
  if ! command -v pm2 &> /dev/null; then
    log_info "安装 PM2..."
    npm install -g pm2
  fi

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
      DATABASE_PATH: '${DATABASE_PATH}',
      REDIS_URL: process.env.REDIS_URL || '${REDIS_URL}',
      USE_REDIS: '${USE_REDIS:-false}',
      AUTH_MODE: 'linux',
      JWT_SECRET: process.env.JWT_SECRET || '${JWT_SECRET}',
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
    listen_timeout: 10000,
    node_args: '--max-old-space-size=4096',
    increment_var: 'PORT'
  }]
};
EOF

  cd "$APP_DIR"
  pm2 delete "$SERVICE_NAME" 2>/dev/null || true
  pm2 start ecosystem.config.cjs
  pm2 save

  sleep 3

  # 检查启动状态
  local ONLINE_COUNT=$(pm2 list 2>/dev/null | grep "${SERVICE_NAME}" | grep -c "online" || echo 0)
  if [[ "$ONLINE_COUNT" -gt 0 ]]; then
    log_success "PM2 集群已启动 (workers: $WORKERS, online: $ONLINE_COUNT)"
  else
    log_error "PM2 集群启动失败"
    pm2 logs "${SERVICE_NAME}" --lines 20 --nostream 2>/dev/null || true
    exit 1
  fi
}

# =============================================================================
# 健康检查
# =============================================================================

health_check() {
  log_step "系统健康检查"

  local ALL_OK=true

  if [[ "$DEPLOY_MODE" == "pm2" ]]; then
    if pm2 list 2>/dev/null | grep -q "${SERVICE_NAME}.*online"; then
      log_success "PM2 进程状态: 正常运行"
    else
      log_error "PM2 进程状态: 异常"
      ALL_OK=false
    fi
  else
    if systemctl is-active --quiet "${SERVICE_NAME}"; then
      log_success "systemd 服务状态: 正常运行"
    else
      log_error "systemd 服务状态: 异常"
      ALL_OK=false
    fi
  fi

  # 测试端口
  if curl -sf -o /dev/null "http://localhost:${PORT}/health" 2>/dev/null; then
    log_success "HTTP 健康检查: 通过 (http://localhost:${PORT})"
  else
    log_warn "HTTP 健康检查: 无法连接 (可能还在启动中)"
  fi

  # 系统资源
  local MEM_USED_PERCENT=$(free 2>/dev/null | awk '/Mem/{printf "%.0f", $3/$2*100}' || echo 0)
  log_info "内存使用率: ${MEM_USED_PERCENT}%"

  if [[ "$MEM_USED_PERCENT" -gt 90 ]]; then
    log_warn "内存使用率过高 (>90%)"
  fi

  if $ALL_OK; then
    return 0
  else
    return 1
  fi
}

# =============================================================================
# 输出部署摘要
# =============================================================================

print_summary() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║                                                              ║"
  echo "║           部署完成                                           ║"
  echo "║                                                              ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  local LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo '')
  local LOCAL_IP="127.0.0.1"

  echo -e "  ${GREEN}访问地址:${NC}"
  echo -e "    本地:   http://${LOCAL_IP}:${PORT}"
  if [[ -n "$LAN_IP" ]]; then
    echo -e "    局域网: http://${LAN_IP}:${PORT}"
  fi
  echo ""

  echo "部署详情:"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  部署模式:   ${DEPLOY_MODE}"
  echo "  服务端口:   ${PORT}"
  if [[ "$DEPLOY_MODE" == "pm2" ]]; then
    echo "  Worker 数:  ${WORKERS} 进程"
    echo "  内存限制:   ${MAX_MEMORY}/进程"
  fi
  echo "  数据库:     ${DATABASE_PATH}"
  echo "  JWT Secret: 已配置 (${#JWT_SECRET} 字符)"
  echo ""

  echo "管理命令:"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if [[ "$DEPLOY_MODE" == "pm2" ]]; then
    echo "  pm2 status                    查看集群状态"
    echo "  pm2 logs ${SERVICE_NAME}       实时查看日志"
    echo "  pm2 restart ${SERVICE_NAME}    重启服务"
  else
    echo "  systemctl status ${SERVICE_NAME}   查看服务状态"
    echo "  systemctl restart ${SERVICE_NAME}  重启服务"
    echo "  journalctl -u ${SERVICE_NAME} -f   查看日志"
  fi
  echo ""

  echo "故障排查:"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  应用日志:  tail -f ${APP_DIR}/logs/error.log"
  echo "  系统资源:  htop / free -h"
  echo ""
}

# =============================================================================
# 卸载功能
# =============================================================================

uninstall_systemd() {
  echo ""
  echo -e "${RED}==============================================${NC}"
  echo -e "${RED}  CloudCLI Debug 卸载向导${NC}"
  echo -e "${RED}==============================================${NC}"
  echo ""

  local STEP=0
  local TOTAL_STEPS=4

  # =========================================================================
  # 第 1 步: 停止服务
  # =========================================================================
  STEP=$((STEP + 1))
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} 停止服务"

  local SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

  if [[ "$DEPLOY_MODE" == "pm2" ]]; then
    if command -v pm2 &> /dev/null && pm2 list 2>/dev/null | grep -q "${SERVICE_NAME}"; then
      echo "   当前状态:"
      pm2 list | grep "${SERVICE_NAME}" || true
      echo ""
      read -p "   停止并删除 PM2 进程? (yes/no): " CONFIRM_PM2
      if [[ "$CONFIRM_PM2" == "yes" ]]; then
        pm2 stop "${SERVICE_NAME}" 2>/dev/null || true
        pm2 delete "${SERVICE_NAME}" 2>/dev/null || true
        pm2 save 2>/dev/null || true
        log_success "PM2 进程已停止并删除"
      else
        log_warn "跳过 PM2 进程管理"
      fi
    else
      echo "   PM2 未运行或无 ${SERVICE_NAME} 进程, 跳过"
    fi
  else
    # 检查服务文件是否存在
    if [[ -f "$SERVICE_FILE" ]] || systemctl list-unit-files | grep -q "${SERVICE_NAME}.service"; then
      echo "   检测到 systemd 服务: ${SERVICE_NAME}.service"

      # 先停止服务 (防止它自动重启)
      systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true

      # 强制杀死可能残留的进程 (端口被占用)
      local PORT_PID=$(lsof -t -i:${PORT} 2>/dev/null || true)
      if [[ -n "$PORT_PID" ]]; then
        echo "   发现进程占用端口 ${PORT}: PID $PORT_PID"
        read -p "   强制终止进程? (yes/no): " CONFIRM_KILL
        if [[ "$CONFIRM_KILL" == "yes" ]]; then
          kill -9 $PORT_PID 2>/dev/null || true
          sleep 1
          log_success "进程已终止"
        fi
      fi

      echo ""
      read -p "   删除 systemd 服务? (yes/no): " CONFIRM_SYSTEMD
      if [[ "$CONFIRM_SYSTEMD" == "yes" ]]; then
        systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
        rm -f "$SERVICE_FILE"
        systemctl daemon-reload
        log_success "systemd 服务已删除"
      else
        log_warn "跳过 systemd 服务"
      fi
    else
      # 检查端口是否有进程占用
      local PORT_PID=$(lsof -t -i:${PORT} 2>/dev/null || true)
      if [[ -n "$PORT_PID" ]]; then
        echo "   发现进程占用端口 ${PORT}: PID $PORT_PID"
        read -p "   强制终止进程? (yes/no): " CONFIRM_KILL
        if [[ "$CONFIRM_KILL" == "yes" ]]; then
          kill -9 $PORT_PID 2>/dev/null || true
          sleep 1
          log_success "进程已终止"
        fi
      else
        echo "   无 systemd 服务或进程运行, 跳过"
      fi
    fi
  fi

  # =========================================================================
  # 第 2 步: 删除 PM2 开机自启配置 (仅特定服务)
  # =========================================================================
  STEP=$((STEP + 1))
  echo ""
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} PM2 开机自启配置"

  # 只删除特定的服务名，不删除通用的 pm2-root.service
  local PM2_SERVICE="/etc/systemd/system/pm2-${SERVICE_NAME}.service"

  if [[ -f "$PM2_SERVICE" ]]; then
    echo "   发现: $PM2_SERVICE"
    read -p "   删除 PM2 开机自启配置? (yes/no): " CONFIRM_PM2_AUTOSTART
    if [[ "$CONFIRM_PM2_AUTOSTART" == "yes" ]]; then
      systemctl disable "$(basename "$PM2_SERVICE")" 2>/dev/null || true
      rm -f "$PM2_SERVICE"
      systemctl daemon-reload 2>/dev/null || true
      log_success "PM2 开机自启已删除"
    else
      log_warn "跳过 PM2 开机自启配置"
    fi
  else
    echo "   无特定 PM2 开机自启配置 (pm2-${SERVICE_NAME}.service), 跳过"
    log_info "注意: pm2-root.service 为通用配置, 不删除以免影响其他服务"
  fi

  # =========================================================================
  # 第 3 步: 删除系统优化配置
  # =========================================================================
  STEP=$((STEP + 1))
  echo ""
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} 系统优化配置"

  local HAS_TUNING=false
  if [[ -f "/etc/sysctl.d/99-cloudcli-debug.conf" ]]; then
    echo "   - 内核参数: /etc/sysctl.d/99-cloudcli-debug.conf"
    HAS_TUNING=true
  fi
  if [[ -f "/etc/security/limits.d/99-cloudcli-debug.conf" ]]; then
    echo "   - 文件描述符: /etc/security/limits.d/99-cloudcli-debug.conf"
    HAS_TUNING=true
  fi

  if [[ "$HAS_TUNING" == "true" ]]; then
    echo ""
    read -p "   删除系统优化配置? (yes/no): " CONFIRM_TUNING
    if [[ "$CONFIRM_TUNING" == "yes" ]]; then
      rm -f /etc/sysctl.d/99-cloudcli-debug.conf
      rm -f /etc/security/limits.d/99-cloudcli-debug.conf
      sysctl --system 2>/dev/null || true
      log_success "系统优化配置已删除"
      log_warn "已生效的参数将在重启后失效"
    else
      log_warn "跳过删除系统配置"
    fi
  else
    echo "   无优化配置, 跳过"
  fi

  # =========================================================================
  # 第 4 步: 删除数据目录
  # =========================================================================
  STEP=$((STEP + 1))
  echo ""
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} 数据目录"

  if [[ -d "$DATA_DIR" ]]; then
    local DATA_SIZE=$(du -sh "$DATA_DIR" 2>/dev/null | cut -f1)
    echo "   目录: ${DATA_DIR}/"
    echo "   大小: ${DATA_SIZE:-未知}"
    echo "   内容:"
    ls -lh "$DATA_DIR/" 2>/dev/null | head -10 || echo "   (空目录)"
    echo ""
    read -p "   删除数据目录? (这将永久删除所有用户数据!) (yes/no): " CONFIRM_DATA
    if [[ "$CONFIRM_DATA" == "yes" ]]; then
      rm -rf "$DATA_DIR"
      log_success "数据目录已删除"
    else
      log_info "保留数据目录"
    fi
  else
    echo "   数据目录不存在, 跳过"
  fi

  # =========================================================================
  # 完成
  # =========================================================================
  echo ""
  echo -e "${GREEN}==============================================${NC}"
  echo -e "${GREEN}  卸载完成${NC}"
  echo -e "${GREEN}==============================================${NC}"
  echo ""
}

# =============================================================================
# 主流程
# =============================================================================

main() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║                                                              ║"
  echo "║     CloudCLI Debug 部署脚本                                  ║"
  echo "║                                                              ║"
  echo "║     模式: systemd 单实例 / PM2 集群                          ║"
  echo "║     端口: ${PORT} (与生产环境 8250 隔离)                     ║"
  echo "║                                                              ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  check_prerequisites

  # 执行部署
  case "$DEPLOY_MODE" in
    pm2)  deploy_pm2 ;;
    *)    deploy_systemd ;;
  esac

  # 健康检查
  if health_check; then
    print_summary
    echo "部署成功!"
    echo ""
    exit 0
  else
    log_error "健康检查未完全通过, 请查看上方错误信息"
    exit 1
  fi
}

# =============================================================================
# 入口
# =============================================================================

if [[ "$UNINSTALL_MODE" == "true" ]]; then
  uninstall_systemd
else
  main "$@"
fi