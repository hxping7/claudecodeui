#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# CloudCLI 一键部署脚本 - 40核 256GB / 50用户 × 10会话 / PAM认证
#
# 适用场景:
#   - Ubuntu Server (20.04+)
#   - 高性能服务器 (40核 CPU / 256GB RAM)
#   - 多用户并发环境 (50 用户 × 10 会话 = 500 WebSocket 并发)
#
# 前置条件:
#   ✅ Linux 用户已由系统管理员创建 (adduser/useradd)
#   ✅ 用户可通过 SSH 登录系统
#   ✅ root 权限运行此脚本
#
# 功能说明:
#   ✓ 系统内核参数优化 (高并发调优)
#   ✓ Redis 会话存储安装与配置
#   ✓ PM2 集群模式部署 (自动利用所有 CPU 核心)
#   ✓ Nginx 反向代理与负载均衡
#   ✓ PAM 认证环境配置 (验证现有用户, 不创建新用户)
#   ✓ 防火墙安全配置
#   ✓ 健康检查与监控
#   ✓ 完整的安装/卸载支持 (--uninstall)
#
# 用户管理:
#   - 创建用户: sudo adduser username (系统命令)
#   - 管理界面: 登录 CloudCLI 后访问管理后台
#   - 权限设置: sudo usermod -aG sudo username (提升为管理员)
#
# 用法:
#   sudo bash deploy-production.sh                    # 安装部署
#   sudo bash deploy-production.sh --uninstall         # 卸载删除
# =============================================================================

# ---- 配置区域 (可根据实际修改) ----
APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")" && pwd)}"
SERVICE_NAME="${SERVICE_NAME:-cloudcli}"
DATA_DIR="${DATA_DIR:-/var/lib/cloudcli}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
ENABLE_NGINX="${ENABLE_NGINX:-true}"
NGINX_DOMAIN="${NGINX_DOMAIN:-$(hostname -f | awk '{print $1}')}"

# ---- 部署配置文件 (持久化配置, 方便后续修改) ----
DEPLOY_CONF="/etc/cloudcli/deploy.conf"

# 保存命令行传入的环境变量 (优先级最高)
CUSTOM_PORT="${PORT:-}"
CUSTOM_WORKERS="${WORKERS:-}"

# 从配置文件加载 (如果存在)
if [[ -f "$DEPLOY_CONF" ]]; then
  source "$DEPLOY_CONF"
fi

# 命令行环境变量覆盖配置文件
[[ -n "$CUSTOM_PORT" ]] && PORT="$CUSTOM_PORT"
[[ -n "$CUSTOM_WORKERS" ]] && WORKERS="$CUSTOM_WORKERS"

# 最终默认值
PORT="${PORT:-8250}"

# ---- 自动计算资源分配 (40核 256GB) ----
CPU_CORES=$(nproc)
TOTAL_MEM_GB=$(free -g | awk '/^Mem:/{print $2}')

# 智能分配：保留 2 核给系统/Redis/Nginx
RECOMMENDED_WORKERS=$((CPU_CORES - 2))
if [[ $RECOMMENDED_WORKERS -lt 1 ]]; then
  RECOMMENDED_WORKERS=1
fi
WORKERS="${WORKERS:-$RECOMMENDED_WORKERS}"

# 每个 Worker 分配 4GB 内存 (Node.js 高并发推荐值)
MAX_MEMORY="${MAX_MEMORY:-4G}"

# Redis 内存配置 (总内存的 12-15%)
REDIS_MAX_MEMORY="${REDIS_MAX_MEMORY:-$((TOTAL_MEM_GB * 128))mb}"

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
      echo "  PORT=8250                       # 服务端口"
      echo "  WORKERS=38                      # PM2 worker 数量"
      exit 0
      ;;
  esac
done

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

# ---- 配置文件备份函数 ----
backup_config() {
  local FILE="$1"
  local MAX_BACKUPS=5

  if [[ -f "$FILE" ]]; then
    local TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    local BACKUP_FILE="${FILE}.bak.${TIMESTAMP}"

    # 创建备份
    cp -a "$FILE" "$BACKUP_FILE" 2>/dev/null || return 1

    log_info "已备份: $(basename $FILE) → $(basename $BACKUP_FILE)"

    # 清理旧备份 (保留最近 5 个)
    ls -t "${FILE}".bak.* 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs rm -f 2>/dev/null || true

    return 0
  fi
  return 1
}

# ---- 安全写入配置文件 (自动备份 + 差异提示) ----
safe_write_config() {
  local FILE="$1"
  local CONTENT="$2"
  local DESCRIPTION="${3:-配置文件}"

  if [[ -f "$FILE" ]]; then
    # 计算 MD5 比对内容是否变化
    local OLD_MD5=$(md5sum "$FILE" 2>/dev/null | cut -d' ' -f1)
    local NEW_MD5=$(echo "$CONTENT" | md5sum | cut -d' ' -f1)

    if [[ "$OLD_MD5" == "$NEW_MD5" ]]; then
      log_info "${DESCRIPTION} 无变化, 跳过"
      return 0
    fi

    log_warn "检测到现有 ${DESCRIPTION}: $FILE"

    # 显示文件信息
    local SIZE=$(ls -lh "$FILE" | awk '{print $5}')
    local MTIME=$(stat -c %y "$FILE" | cut -d'.' -f1)
    echo "   大小: ${SIZE} | 修改时间: ${MTIME}"

    # 备份现有配置
    backup_config "$FILE"

    echo "   将使用新配置覆盖 (原配置已备份)"
  else
    log_info "创建新 ${DESCRIPTION}: $FILE"
  fi

  # 写入新配置
  echo "$CONTENT" > "$FILE"
}

# ---- 检测服务状态 ----
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
# 智能源码更新检测与构建 (确保源码更新能自动生效)
# 安全保障: 绝不会删除用户数据目录
# =============================================================================
check_and_build() {
  local DIST_ENTRY="$APP_DIR/dist-server/server/index.js"
  local SRC_DIR="$APP_DIR/src"
  local BUILD_MARKER="$APP_DIR/.last_build_time"

  # ---- 可选: Git Pull (从远程仓库拉取最新代码) ----
  if [[ "$GIT_PULL_MODE" == "true" ]] && [[ -d "$APP_DIR/.git" ]]; then
    log_step "Git Pull (拉取最新代码)"
    cd "$APP_DIR"

    log_info "正在从远程仓库拉取最新代码..."
    echo "   当前分支: $(git branch --show-current)"

    if git pull --ff-only; then
      log_success "✅ Git pull 成功"
    else
      log_warn "⚠️ Git pull 失败或存在冲突"
      log_warn "将使用本地代码继续部署..."
    fi

    echo ""
  fi

  # ---- 场景 1: 首次部署 (dist-server 不存在) ----
  if [[ ! -f "$DIST_ENTRY" ]]; then
    log_step "构建项目 (首次部署)"
    log_info "检测到未构建的项目, 执行 npm run build..."

    (cd "$APP_DIR" && npm run build) || {
      log_error "❌ 构建失败!"
      log_error "请手动执行:"
      log_error "  cd $APP_DIR && npm run build"
      exit 1
    }

    # 记录构建时间
    date +%s > "$BUILD_MARKER"
    log_success "✅ 首次构建完成"
    return 0
  fi

  # ---- 场景 2: 重复部署 (检测源码是否更新) ----
  log_info "检测源码更新..."

  local NEED_REBUILD=false
  local UPDATE_REASON=""

  # 方法 A: Git 状态检测 (最准确)
  if [[ -d "$APP_DIR/.git" ]]; then
    cd "$APP_DIR"

    # 检测是否有未提交的更改
    if ! git diff --quiet HEAD -- "$SRC_DIR" 2>/dev/null; then
      NEED_REBUILD=true
      UPDATE_REASON="检测到源码文件已修改 (git diff)"
    fi

    # 检测是否有新的 commit (相对于上次构建)
    if [[ -f "$BUILD_MARKER" ]]; then
      local LAST_BUILD=$(cat "$BUILD_MARKER")
      local LATEST_COMMIT=$(git log -1 --format=%ct 2>/dev/null || echo 0)

      if [[ "$LATEST_COMMIT" -gt "$LAST_BUILD" ]]; then
        NEED_REBUILD=true
        UPDATE_REASON="检测到新的 git commit ($(git log -1 --oneline --no-decorate 2>/dev/null))"
      fi
    fi
  fi

  # 方法 B: 文件时间戳比较 (备用方案)
  if [[ "$NEED_REBUILD" == "false" ]] && [[ -d "$SRC_DIR" ]]; then
    local DIST_TIME=$(stat -c %Y "$DIST_ENTRY" 2>/dev/null || echo 0)
    local NEWEST_SRC=$(find "$SRC_DIR" -type f -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.vue" 2>/dev/null | xargs stat -c %Y 2>/dev/null | sort -n | tail -1 || echo 0)

    if [[ "$NEWEST_SRC" -gt "$DIST_TIME" ]]; then
      NEED_REBUILD=true
      UPDATE_REASON="检测到源码文件比构建产物新 (时间戳比较)"
    fi
  fi

  # ---- 执行构建决策 ----
  if [[ "$NEED_REBUILD" == "true" ]]; then
    echo ""
    log_warn "🔄 检测到源码更新，需要重新构建"
    echo "   原因: ${UPDATE_REASON}"
    echo ""

    # ⚠️ 重要提示：数据安全
    log_info "数据安全保障:"
    echo "   ✅ 用户数据库: ${DATA_DIR}/auth.db (不会被删除)"
    echo "   ✅ 用户会话数据: ${DATA_DIR}/sessions/ (保留)"
    echo "   ✅ 用户配置文件: ${DATA_DIR}/config/ (保留)"
    echo "   ℹ️  仅重新编译源码到 dist-server/"
    echo ""

    log_info "正在执行 npm run build (可能需要 30-120 秒)..."
    local START_TIME=$(date +%s)

    (cd "$APP_DIR" && npm run build) || {
      log_error "❌ 构建失败!"
      log_warn "旧版本仍在运行, 不受影响"
      log_error "请检查源码错误后重试:"
      log_error "  cd $APP_DIR && npm run build"
      exit 1
    }

    local END_TIME=$(date +%s)
    local DURATION=$((END_TIME - START_TIME))

    # 更新构建时间标记
    date +%s > "$BUILD_MARKER"

    log_success "✅ 重新构建完成 (${DURATION}s)"
    log_info "新版本将在服务重启后生效"
  else
    log_success "✅ 源码无变化, 跳过构建 (使用现有版本)"
  fi

  return 0
}

# =============================================================================
# JWT Secret 管理 (确保重启后 Token 仍然有效)
# 策略: 持久化到文件, 避免每次部署生成新 Secret
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
    log_info "已生成新的 JWT_SECRET 并保存到 ${JWT_SECRET_FILE}"
  fi

  export JWT_SECRET="$JWT_SECRET"
  log_success "✅ JWT Secret 已配置 (${#JWT_SECRET} 字符)"
}

# =============================================================================
# PM2 开机自启 (备用方案: 手动创建 systemd 服务)
# 当 pm2 startup 命令失败使用此方案
# =============================================================================
setup_pm2_systemd_service() {
  local PM2_SYSTEMD_SERVICE="/etc/systemd/system/pm2-${SERVICE_NAME}.service"

  log_info "使用备用方案配置 PM2 开机自启..."

  local PM2_SERVICE_CONTENT="[Unit]
Description=PM2 process manager for ${SERVICE_NAME}
Documentation=https://pm2.keymetrics.io/
After=network.target redis-server.service

[Service]
Type=simple
User=root
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=PM2_HOME=${PM2_HOME:-/root/.pm2}
ExecStartPre=-/usr/bin/pm2 kill
ExecStart=/usr/bin/pm2 resurrect
ExecReload=/usr/bin/pm2 reload all
ExecStop=/usr/bin/pm2 stop all
PIDFile=${PM2_HOME:-/root/.pm2}/pm2.pid
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target"

  # 写入 systemd 服务文件
  echo "$PM2_SERVICE_CONTENT" > "$PM2_SYSTEMD_SERVICE"
  systemctl daemon-reload
  systemctl enable "pm2-${SERVICE_NAME}.service"

  # 保存 PM2 进程列表
  pm2 save &>/dev/null || true

  log_success "✅ PM2 开机自启已配置 (备用方案)"
}

# =============================================================================
# 验证开机自启状态 (所有服务)
# =============================================================================
verify_autostart() {
  log_step "验证开机自启配置"

  local ALL_OK=true
  local SERVICES_TO_CHECK=()

  # ---- 检查 Redis ----
  if command -v redis-server &>/dev/null; then
    if systemctl is-enabled --quiet redis-server 2>/dev/null; then
      log_success "✅ Redis 开机自启: 已启用"
    else
      log_warn "⚠️ Redis 开机自启: 未启用"
      ALL_OK=false
      SERVICES_TO_CHECK+=("redis-server")
    fi
  fi

  # ---- 检查 Nginx ----
  if command -v nginx &>/dev/null && [[ "$ENABLE_NGINX" == "true" ]]; then
    if systemctl is-enabled --quiet nginx 2>/dev/null; then
      log_success "✅ Nginx 开机自启: 已启用"
    else
      log_warn "⚠️ Nginx 开机自启: 未启用"
      ALL_OK=false
      SERVICES_TO_CHECK+=("nginx")
    fi
  fi

  # ---- 检查应用服务 (PM2 集群模式) ----
  # PM2 模式: 检查 pm2 systemd service 或 startup 脚本
  if [[ -f "/etc/systemd/system/pm2-${SERVICE_NAME}.service" ]] && \
     systemctl is-enabled --quiet "pm2-${SERVICE_NAME}" 2>/dev/null; then
    log_success "✅ PM2 (${SERVICE_NAME}) 开机自启: 已启用"
  elif [[ -f "/etc/systemd/system/pm2-root.service" ]] || \
       [[ -f "/etc/init.d/pm2-root.sh" ]] || \
       [[ -f "/etc/systemd/system/pm2-${USER:-root}.service" ]]; then
    log_success "✅ PM2 开机自启: 已启用 (通用)"
  else
    log_warn "⚠️ PM2 开机自启: 可能未正确配置"
    ALL_OK=false
    log_info "   提示: 可手动执行 'sudo pm2 startup && sudo pm2 save'"
  fi

  # ---- 尝试自动修复未启用的服务 ----
  if [[ ${#SERVICES_TO_CHECK[@]} -gt 0 ]]; then
    echo ""
    log_info "尝试自动修复未启用的服务..."

    for svc in "${SERVICES_TO_CHECK[@]}"; do
      if systemctl enable "$svc" 2>/dev/null; then
        log_success "✅ 已自动启用: $svc"
        ALL_OK=true
      else
        log_warn "⚠️ 无法自动启用: $svc"
      fi
    done
  fi

  # ---- 最终状态报告 ----
  echo ""
  if [[ "$ALL_OK" == "true" ]]; then
    log_success "🎉 所有服务均已配置开机自启!"
    log_info "服务器重启后, 所有服务将自动启动"
  else
    log_warn "⚠️ 部分服务可能需要手动配置开机自启"
    log_info "请参考上方提示进行配置"
  fi

  return 0
}

# =============================================================================
# 前置检查
# =============================================================================
check_prerequisites() {
    log_step "第 1 步: 环境前置检查"

    if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
        log_error "请使用 root 权限运行: sudo $0"
        exit 1
    fi

    if [[ ! -d "$APP_DIR" ]]; then
        log_error "应用目录不存在: $APP_DIR"
        exit 1
    fi

    NODE_BIN="$(command -v node || true)"
    if [[ -z "$NODE_BIN" ]]; then
        log_error "未找到 Node.js，正在安装..."
        install_nodejs
    fi

    NODE_VERSION=$($NODE_BIN --version 2>/dev/null || echo "unknown")
    log_info "Node.js 版本: $NODE_VERSION"

    # ---- 智能源码更新检测与构建 ----
    check_and_build

    # 创建必要目录
    mkdir -p "$APP_DIR/logs"
    mkdir -p "$DATA_DIR"
    mkdir -p "/var/log/$SERVICE_NAME"

    DEFAULT_SYSTEM_DB="${DATA_DIR}/auth.db"
    DATABASE_PATH="${DATABASE_PATH:-$DEFAULT_SYSTEM_DB}"
    export DATABASE_PATH

    # ---- JWT Secret 管理 (确保重启后 Token 仍然有效) ----
    setup_jwt_secret

    log_success "前置检查通过"
    show_system_info

    # 生成/更新部署配置文件
    generate_deploy_config
}

generate_deploy_config() {
    # 如果配置文件不存在, 生成默认配置
    if [[ ! -f "$DEPLOY_CONF" ]]; then
        mkdir -p "$(dirname "$DEPLOY_CONF")" 2>/dev/null || true
        cat > "$DEPLOY_CONF" <<EOF
# CloudCLI 生产环境部署配置
# 位置: /etc/cloudcli/deploy.conf
# 修改后重新运行部署脚本即可生效: sudo bash deploy-production.sh

# =============================================================================
# 端口配置 (防火墙规则自动同步)
# =============================================================================
# PORT - 应用主端口 (生产环境, PM2 集群模式)
#   必须开放此端口, 否则用户无法访问 Web UI
#   默认值: 8250 | 示例: PORT=8250 或 PORT=8080
PORT=${PORT}

# WORKERS - PM2 Worker 进程数 (建议 CPU核心数-2)
WORKERS=${WORKERS}

# DATA_DIR - 数据存储目录 (数据库、会话、配置)
DATA_DIR=${DATA_DIR}

# REDIS_URL - Redis 连接地址 (会话缓存)
REDIS_URL=${REDIS_URL}

# ENABLE_NGINX - 是否启用 Nginx 反向代理 (true/false)
ENABLE_NGINX=${ENABLE_NGINX}

# NGINX_DOMAIN - 域名或主机名 (Nginx 配置使用)
NGINX_DOMAIN=${NGINX_DOMAIN}
EOF
        chmod 644 "$DEPLOY_CONF"
        log_info "已生成部署配置文件: ${DEPLOY_CONF}"
    else
        log_info "部署配置文件已存在: ${DEPLOY_CONF}"
    fi
}

show_system_info() {
    log_info "=============================================="
    log_info "  系统资源检测报告"
    log_info "=============================================="
    log_info "操作系统: $(lsb_release -ds 2>/dev/null || cat /etc/os-release | grep PRETTY_NAME | cut -d\" -f2)"
    log_info "CPU 核心: ${CPU_CORES} 核"
    log_info "总内存:   ${TOTAL_MEM_GB} GB"
    log_info "可用内存: $(free -g | awk '/^Mem:/{print $7}') GB"
    log_info "磁盘空间: $(df -h "$APP_DIR" | awk 'NR==2{print $4}') 可用"
    log_info ""
    log_info "资源分配方案:"
    log_info "  ├─ PM2 Workers: ${WORKERS} 进程 (预留 2 核给系统)"
    log_info "  ├─ Worker 内存: ${MAX_MEMORY}/进程"
    log_info "  ├─ 总计内存: ~$(( WORKERS * 4 )) GB (Workers)"
    log_info "  ├─ Redis 内存: ${REDIS_MAX_MEMORY}"
    log_info "  └─ 目标并发: 50 用户 × 10 会话 = 500 WebSocket"
    log_info "=============================================="
}

# =============================================================================
# Node.js 安装
# =============================================================================
install_nodejs() {
    log_step "安装 Node.js 20.x LTS..."

    if command -v apt-get > /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        apt-get install -y nodejs
    elif command -v yum > /dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
        yum install -y nodejs
    fi

    log_success "Node.js $(node --version) 安装完成"
}

# =============================================================================
# 系统内核参数优化 (针对高并发)
# =============================================================================
configure_system_tuning() {
    log_step "第 2 步: 系统内核参数优化 (高并发调优)"

    local SYSCTL_CONF="/etc/sysctl.d/99-cloudcli.conf"

    # 生成完整的 sysctl 配置
    local NEW_SYSCTL_CONF='# =============================================================================
# CloudCLI 高并发内核参数优化
# 目标: 500+ 并发连接, 50 用户, 低延迟
# =============================================================================

# ---- 网络核心参数 ----
# 增加系统范围文件描述符限制
fs.file-max = 1048576

# 增加 TCP 连接队列
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 65535

# TCP 快速回收和重用 (减少 TIME_WAIT)
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15

# TCP 缓冲区大小 (高带宽延迟产品网络)
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# TCP 连接跟踪表大小
net.netfilter.nf_conntrack_max = 1048576

# ---- 虚拟内存参数 ----
# 减少交换倾向 (保留更多物理内存给应用)
vm.swappiness = 10

# 脏页回写策略 (提升 I/O 性能)
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5

# ---- 用户资源限制 ----
# 允许每个进程打开更多文件'

    # 动态写入基于硬件的配置
    NEW_SYSCTL_CONF="${NEW_SYSCTL_CONF}
# 基于 ${CPU_CORES}核 ${TOTAL_MEM_GB}GB 的自动优化
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_max_tw_buckets = 262144
net.core.optmem_max = 25165824"

    # 使用安全写入 (自动备份现有配置)
    safe_write_config "$SYSCTL_CONF" "$NEW_SYSCTL_CONF" "系统内核参数配置"

    sysctl -p "$SYSCTL_CONF" 2>/dev/null || sysctl --system

    # ---- 配置用户级文件描述符限制 ----
    local LIMITS_CONF="/etc/security/limits.d/99-cloudcli.conf"
    local NEW_LIMITS='# CloudCLI 用户资源限制
*          soft    nofile      1048576
*          hard    nofile      1048576
*          soft    nproc       65535
*          hard    nproc       65535
root       soft    nofile      1048576
root       hard    nofile      1048576'

    # 使用安全写入 (自动备份现有配置)
    safe_write_config "$LIMITS_CONF" "$NEW_LIMITS" "文件描述符限制配置"

    log_success "内核参数优化完成"
    log_info "已生效配置:"
    log_info "  - 文件描述符上限: 1,048,576"
    log_info "  - TCP 连接队列: 65,535"
    log_info "  - TCP 端口范围: 1024-65535"
    log_info "  - 交换分区使用倾向: 10 (低)"
}

# =============================================================================
# Redis 安装与配置 (一次性正确配置, 无需后续修复)
# =============================================================================
deploy_redis() {
    log_step "第 3 步: Redis 安装与高性能配置"

    # 快速检查: Redis 是否已在运行
    if command -v redis-server &> /dev/null; then
        if pgrep -x redis-server > /dev/null 2>&1 && redis-cli ping 2>/dev/null | grep -q "PONG"; then
            log_success "Redis 已运行 (PID: $(pgrep -x redis-server))"
            return 0
        fi
    fi

    # 安装 Redis
    if ! command -v redis-server &> /dev/null; then
        log_info "安装 Redis Server..."
        apt-get update && apt-get install -y redis-server
    fi

    # ---- 第 1 步: 直接配置正确的 systemd 服务文件 (Type=forking) ----
    log_info "配置 Redis systemd 服务..."

    local REDIS_SERVICE="/etc/systemd/system/redis-server.service"

    # 检测当前状态
    local REDIS_STATUS=$(check_service_status "redis-server.service")
    case "$REDIS_STATUS" in
      running)
        if redis-cli ping 2>/dev/null | grep -q "PONG"; then
          log_success "Redis 已运行 (PID: $(pgrep -x redis-server))"
          log_info "跳过 Redis 配置 (服务正常)"
          return 0
        fi
        log_warn "Redis 运行但无法连接，将重新配置..."
        ;;
      stopped)
        log_info "Redis 服务已安装但未运行"
        ;;
      not_installed)
        log_info "首次安装 Redis 服务"
        ;;
    esac

    # 停止可能存在的旧服务
    systemctl stop redis-server.service 2>/dev/null || true
    pkill -9 redis-server 2>/dev/null || true
    rm -f /run/redis/redis-server.pid 2>/dev/null || true
    sleep 1

    # 使用安全写入函数 (自动备份现有配置)
    local NEW_REDIS_SERVICE='[Unit]
Description=Advanced key-value store
Documentation=https://redis.io/documentation
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
PIDFile=/run/redis/redis-server.pid
TimeoutStartSec=15
TimeoutStopSec=30

ExecStartPre=-/bin/mkdir -p /var/lib/redis /var/log/redis /run/redis
ExecStartPre=-/bin/chown -R redis:redis /var/lib/redis /var/log/redis /run/redis
ExecStart=/usr/bin/redis-server /etc/redis/redis.conf --daemonize yes --pidfile /run/redis/redis-server.pid --logfile /var/log/redis/redis-server.log
ExecStop=/usr/bin/redis-cli shutdown

Restart=on-success
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target'

    safe_write_config "$REDIS_SERVICE" "$NEW_REDIS_SERVICE" "Redis systemd 服务"

    log_success "✅ systemd 服务已配置 (Type=forking + 15s超时)"

    # ---- 第 2 步: 生成高性能 redis.conf (与 forking 模式匹配) ----
    log_info "生成 Redis 高性能配置..."

    local REDIS_CONF="/etc/redis/redis.conf"

    # 使用标准备份函数 (保留最近5个备份)
    if [[ -f "$REDIS_CONF" ]]; then
      log_info "检测到现有 redis.conf"
      backup_config "$REDIS_CONF"
    fi

    cat > "$REDIS_CONF" <<EOF
# =============================================================================
# CloudCLI Redis 配置 - ${REDIS_MAX_MEMORY} 内存优化
# 目标: 500 会话共享存储, 低延迟读写
# 模式: daemonize yes (配合 Type=forking)
# =============================================================================

# ---- 守护进程模式 (必须开启, 配合 Type=forking) ----
daemonize yes
pidfile /run/redis/redis-server.pid

# ---- 网络配置 ----
bind 127.0.0.1 ::1
port 6379
tcp-backlog 65535
timeout 0
tcp-keepalive 300

# ---- 内存管理 ----
maxmemory ${REDIS_MAX_MEMORY}
maxmemory-policy allkeys-lru

# ---- 持久化配置 (平衡性能与安全) ----
save 900 1
save 300 10
save 60 10000

dbfilename dump.rdb
dir /var/lib/redis

appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec
no-appendfsync-on-rewrite no
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb

# ---- 性能优化 ----
hz 10
dynamic-hz yes

# ---- 日志配置 ----
loglevel notice
logfile /var/log/redis/redis-server.log

# ---- 安全配置 ----
protected-mode yes
maxclients 10000
EOF

    # 处理密码配置
    if [[ -n "${REDIS_PASSWORD:-}" ]]; then
        echo "requirepass ${REDIS_PASSWORD}" >> "$REDIS_CONF"
    fi

    log_success "✅ redis.conf 已生成 (${REDIS_MAX_MEMORY}内存限制)"

    # ---- 第 3 步: 确保目录权限正确 ----
    mkdir -p /var/lib/redis /var/log/redis /run/redis
    chown -R redis:redis /var/lib/redis /var/log/redis /run/redis 2>/dev/null || true

    # ---- 第 4 步: 启动 Redis (快速可靠) ----
    log_info "启动 Redis 服务..."

    systemctl daemon-reload
    systemctl enable redis-server

    # 使用 timeout 作为安全网 (正常情况下 2-3 秒就完成)
    if timeout 15 systemctl start redis-server.service 2>/dev/null; then
        sleep 1
    else
        log_warn "systemctl 超时，检查状态..."
        systemctl status redis-server --no-pager -l | head -10
    fi

    # 验证连接 (最多等待 10 秒)
    local MAX_WAIT=10
    local WAITED=0
    while ! redis-cli ping 2>/dev/null | grep -q PONG && [[ $WAITED -lt $MAX_WAIT ]]; do
        sleep 1
        WAITED=$((WAITED + 1))
    done

    if redis-cli ping 2>/dev/null | grep -q PONG; then
        log_success "✅ Redis 启动成功并可连接 (${WAITED}s)"
        
        # 安装 PM2 日志轮转模块
        if command -v pm2 &> /dev/null; then
            log_info "安装 PM2 日志轮转模块..."
            PM2_HOME="${PM2_HOME:-$HOME/.pm2}" npm install -g pm2-logrotate 2>/dev/null || \
            pm2 install pm2-logrotate 2>/dev/null || true
            pm2 set pm2-logrotate:max_size '100M'
            pm2 set pm2-logrotate:retain 14
            log_success "PM2 日志模块已配置 (100MB, 保留14天)"
        fi
        
        return 0
    else
        log_error "❌ Redis 无法连接 (已等待 ${MAX_WAIT}s)"
        log_error "生产环境需要 Redis，请检查:"
        log_error "  1. sudo journalctl -u redis-server -n 50"
        log_error "  2. sudo tail -50 /var/log/redis/redis-server.log"
        exit 1
    fi
}

# =============================================================================
# Nginx 安装与配置
# =============================================================================
deploy_nginx() {
    if [[ "$ENABLE_NGINX" != "true" ]]; then
        log_info "跳过 Nginx 部署 (ENABLE_NGINX=false)"
        return 0
    fi

    log_step "第 4 步: Nginx 反向代理与负载均衡"

    # 安装 Nginx
    if ! command -v nginx &> /dev/null; then
        log_info "安装 Nginx..."
        apt-get update && apt-get install -y nginx
    fi

    # 生成 Nginx 配置
    local NGINX_CONF="/etc/nginx/sites-available/${SERVICE_NAME}"
    local NGINX_ENABLED="/etc/nginx/sites-enabled/${SERVICE_NAME}"

    # 检测现有配置
    if [[ -f "$NGINX_CONF" ]]; then
      log_warn "检测到现有 Nginx 配置: $NGINX_CONF"
      backup_config "$NGINX_CONF"
      echo "   将使用新配置覆盖 (原配置已备份)"
    else
      log_info "创建新 Nginx 配置: $NGINX_CONF"
    fi

    # 生成新的 Nginx 配置文件
    cat > "$NGINX_CONF" <<EOF
# =============================================================================
# CloudCLI Nginx 配置 - 高并发反向代理
# 目标: 50 用户, 500 WebSocket 连接, 长连接支持
# =============================================================================

upstream ${SERVICE_NAME}_backend {
    # 使用 ip_hash 保证 WebSocket 会话亲和性
    ip_hash;

    # 后端服务器 (PM2 Cluster 或单实例)
    server 127.0.0.1:${PORT};

    # 长连接池复用 (减少握手开销)
    keepalive 64;
}

server {
    listen 80;
    server_name ${NGINX_DOMAIN} _;

    # 客户端请求体大小限制 (文件上传)
    client_max_body_size 50m;

    # 代理超时设置
    proxy_connect_timeout 60s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;

    # ---- 主路由 ----
    location / {
        proxy_pass http://${SERVICE_NAME}_backend;
        proxy_http_version 1.1;

        # 头部转发
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # WebSocket 支持
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        # 禁用缓冲 (实时通信必需)
        proxy_buffering off;
        proxy_cache off;

        # 故障转移
        proxy_next_upstream error timeout http_502 http_503 http_504;
    }

    # ---- WebSocket 专用路径 (24小时超时) ----
    location /ws {
        proxy_pass http://${SERVICE_NAME}_backend;
        proxy_http_version 1.1;

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        # WebSocket 长连接超时 (24小时)
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        proxy_buffering off;
    }

    # ---- Shell/WebSocket 终端 ----
    location /shell {
        proxy_pass http://${SERVICE_NAME}_backend;
        proxy_http_version 1.1;

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        proxy_buffering off;
    }

    # ---- 插件 WebSocket ----
    location /plugin-ws/ {
        proxy_pass http://${SERVICE_NAME}_backend;
        proxy_http_version 1.1;

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        proxy_buffering off;
    }

    # ---- 静态资源缓存 ----
    location ~* \.(jpg|jpeg|png|gif|ico|css|js|woff|woff2|ttf|svg)$ {
        proxy_pass http://${SERVICE_NAME}_backend;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # ---- 健康检查端点 ----
    location /health {
        proxy_pass http://${SERVICE_NAME}_backend;
        access_log off;
    }

    # ---- 错误页面 ----
    error_page 502 503 504 /50x.html;
    location = /50x.html {
        root /usr/share/nginx/html;
        internal;
    }
}
EOF

    # 启用站点
    ln -sf "$NGINX_CONF" "$NGINX_ENABLED"

    # 移除默认站点 (避免冲突)
    rm -f /etc/nginx/sites-enabled/default

    # 测试配置
    nginx -t && {
        systemctl enable nginx
        systemctl reload nginx || systemctl restart nginx
        log_success "Nginx 配置完成并启动"
    } || {
        log_error "Nginx 配置错误"
        nginx -t
        exit 1
    }
}

# =============================================================================
# PAM 认证环境配置 (仅配置权限, 不创建用户)
# 注意: Linux 用户由系统管理员通过 adduser/useradd 创建
#       用户管理请通过 Web UI 管理后台操作
# =============================================================================
configure_pam_environment() {
    log_step "第 5 步: PAM 认证环境配置"

    # 确保 PAM 认证所需的包已安装
    if ! dpkg -l | grep -q libpam-runtime; then
        apt-get install -y libpam-runtime
    fi

    # 检测系统中的活跃 Linux 用户 (仅统计, 不创建)
    log_info "检测系统中的 Linux 用户..."
    local USER_COUNT=0

    while IFS=: read -r username _ uid gid _ home shell; do
        # 跳过系统用户 (UID < 1000) 和nologin用户
        if [[ $uid -lt 1000 ]] || [[ "$shell" == *nologin ]] || [[ "$shell" == *false ]]; then
            continue
        fi

        # 跳过无 home 目录的用户
        if [[ -z "$home" ]] || [[ ! -d "$home" ]]; then
            continue
        fi

        USER_COUNT=$((USER_COUNT + 1))
    done < /etc/passwd

    log_success "检测到 ${USER_COUNT} 个可登录的 Linux 用户"
    log_info "这些用户可通过 SSH 密码登录 CloudCLI"
    log_info "用户管理请通过 Web UI 后台进行"
    echo ""

    # 配置 sudoers (允许 Node.js 进程切换用户执行命令)
    # 用于终端功能: 让 Web 终端能以登录用户身份执行命令
    local SUDOERS_FILE="/etc/sudoers.d/${SERVICE_NAME}"

    # 检测现有配置
    if [[ -f "$SUDOERS_FILE" ]]; then
      log_info "检测到现有 sudoers 配置"
      backup_config "$SUDOERS_FILE"
      echo "   将更新 sudoers 配置 (原配置已备份)"
    else
      log_info "创建 sudoers 配置"
    fi

    cat > "$SUDOERS_FILE" <<EOF
# CloudCLI PAM 终端执行权限
# 允许 www-data 用户以其他 Linux 用户身份执行命令 (Web 终端功能)
www-data ALL=(ALL) NOPASSWD: \
    /bin/bash, \
    /bin/sh, \
    /usr/bin/env, \
    /usr/bin/which, \
    /usr/bin/whoami, \
    /usr/bin/id, \
    /bin/ls, \
    /bin/cat, \
    /usr/bin/head, \
    /usr/bin/tail, \
    /usr/bin/wc, \
    /usr/bin/grep, \
    /usr/bin/find, \
    /usr/bin/git, \
    /usr/bin/npm, \
    /usr/local/bin/node, \
    /usr/bin/python3
EOF

    chmod 440 "$SUDOERS_FILE"
    log_success "Sudoers 终端权限已配置"
}

# =============================================================================
# PM2 集群模式部署
# =============================================================================
deploy_pm2_cluster() {
    log_step "第 6 步: PM2 集群模式部署 (${WORKERS} Workers)"

    # 安装 PM2
    if ! command -v pm2 &> /dev/null; then
        log_info "安装 PM2..."
        npm install -g pm2
    fi

    # 先确保 Redis 运行
    deploy_redis

    # 应用系统调优
    configure_system_tuning

    # 生成 ecosystem.config.cjs
    cat > "$APP_DIR/ecosystem.config.cjs" <<EOF
module.exports = {
  apps: [{
    name: '${SERVICE_NAME}',
    script: './dist-server/server/index.js',

    // 集群模式: 利用所有 CPU 核心
    instances: '${WORKERS}',
    exec_mode: 'cluster',

    env: {
      NODE_ENV: 'production',
      SERVER_PORT: ${PORT},
      DATABASE_PATH: '${DATABASE_PATH}',
      REDIS_URL: process.env.REDIS_URL || '${REDIS_URL}',
      USE_REDIS: 'true',
      AUTH_MODE: 'linux',  // PAM 认证模式
      JWT_SECRET: process.env.JWT_SECRET || '${JWT_SECRET}',  // 持久化的 JWT Secret
    },

    // 内存限制: 4GB/worker (自动重启防泄漏)
    max_memory_restart: '${MAX_MEMORY}',

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
EOF

    log_success "PM2 配置文件已生成"

    chmod 600 "$APP_DIR/ecosystem.config.cjs"
    log_info "已加固配置文件权限 (600)"

    # 启动或重启服务
    if pm2 list | grep -q "${SERVICE_NAME}"; then
        log_info "重启现有 PM2 进程..."
        pm2 delete "${SERVICE_NAME}" 2>/dev/null || true
    fi

    cd "$APP_DIR"
    pm2 start ecosystem.config.cjs
    pm2 save

    # 等待服务启动 (给足够时间初始化)
    log_info "等待服务启动 (最多 15 秒)..."
    local MAX_RETRIES=5
    local RETRY_COUNT=0
    local ALL_ONLINE=false

    while [[ $RETRY_COUNT -lt $MAX_RETRIES ]]; do
        sleep 3
        RETRY_COUNT=$((RETRY_COUNT + 1))

        # 检查所有 worker 是否都 online (使用更可靠的方法)
        local ONLINE_COUNT=$(pm2 list | grep "${SERVICE_NAME}" | grep -c "online" || true)
        local TOTAL_COUNT=$(pm2 list | grep -c "${SERVICE_NAME}" || true)

        if [[ "$ONLINE_COUNT" -gt 0 ]] && [[ "$ONLINE_COUNT" -eq "$TOTAL_COUNT" ]]; then
            ALL_ONLINE=true
            break
        fi

        log_info "   等待中... ($((RETRY_COUNT * 3))s) - Online: ${ONLINE_COUNT}/${TOTAL_COUNT}"
    done

    # 验证最终状态
    if [[ "$ALL_ONLINE" == "true" ]]; then
        log_success "✅ PM2 集群已成功启动"
        log_success "   Worker 数量: ${WORKERS} 进程"
        log_success "   内存限制: ${MAX_MEMORY}/worker"
        log_success "   总并发支持: ~500 连接 (50 用户 × 10 会话)"

        # 显示当前状态
        echo ""
        pm2 list | grep -A "$WORKERS" "${SERVICE_NAME}" || true
        echo ""
    else
        log_error "❌ PM2 集群启动失败 (部分 Worker 未启动)"
        log_error "   当前状态:"
        pm2 list | grep "${SERVICE_NAME}" || true
        echo ""
        log_error "   最近日志 (最后 30 行):"
        pm2 logs "${SERVICE_NAME}" --lines 30 --nostream || true
        exit 1
    fi

    # 设置 PM2 开机自启 (自动执行)
    log_info "配置 PM2 开机自启..."

    # 生成 startup 脚本
    local PM2_STARTUP_OUTPUT=$(pm2 startup systemd -u root --hp /root 2>&1 || true)

    if echo "$PM2_STARTUP_OUTPUT" | grep -q "sudo"; then
        # 提取并自动执行 startup 命令
        local STARTUP_CMD=$(echo "$PM2_STARTUP_OUTPUT" | grep "sudo " | tail -1)
        log_info "执行 PM2 startup 命令..."

        if eval "$STARTUP_CMD" 2>/dev/null; then
            # 保存当前进程列表
            pm2 save
            log_success "✅ PM2 开机自启已配置"
        else
            log_warn "⚠️ PM2 startup 执行失败, 尝试备用方案..."
            # 备用方案: 手动创建 systemd service
            setup_pm2_systemd_service
        fi
    elif echo "$PM2_STARTUP_OUTPUT" | grep -q "already"; then
        log_success "✅ PM2 开机自启已存在"
        pm2 save
    else
        log_warn "⚠️ 无法自动配置 PM2 开机自启"
        log_info "请手动执行:"
        echo "   pm2 startup"
        echo "   pm2 save"
    fi
}

# =============================================================================
# 防火墙配置
# =============================================================================
configure_firewall() {
    log_step "第 7 步: 防火墙配置"

    if command -v ufw &> /dev/null; then
        # 检查 UFW 是否已启用
        local UFW_ACTIVE=false
        if ufw status | grep -q "^Status: active"; then
            UFW_ACTIVE=true
            log_info "UFW 防火墙已启用, 仅添加缺失的规则..."
        else
            log_info "UFW 防火墙未启用, 将添加规则并启用..."
        fi

        # 只添加规则, 绝不删除已有规则
        local RULES_TO_ADD=(
            "22/tcp:SSH"
            "80/tcp:HTTP"
            "${PORT}/tcp:CloudCLI Direct"
        )

        local ADDED=0
        for rule in "${RULES_TO_ADD[@]}"; do
            local PORT_RULE="${rule%%:*}"
            local COMMENT="${rule##*:}"

            if ! ufw status | grep -q "${PORT_RULE}"; then
                ufw allow "${PORT_RULE}" comment "${COMMENT}"
                log_info "  已添加规则: ${PORT_RULE} (${COMMENT})"
                ADDED=$((ADDED + 1))
            fi
        done

        if [[ "$UFW_ACTIVE" == "false" ]]; then
            echo ""
            log_warn "即将启用 UFW 防火墙..."
            log_info "当前规则将生效:"
            ufw status numbered 2>/dev/null | head -20
            echo ""
            read -p "是否启用 UFW 防火墙? (yes/no): " CONFIRM_UFW
            if [[ "$CONFIRM_UFW" == "yes" ]]; then
                echo "y" | ufw enable
                log_success "UFW 防火墙已启用"
            else
                log_warn "跳过启用 UFW, 规则已添加但未激活"
            fi
        elif [[ $ADDED -gt 0 ]]; then
            log_success "已添加 ${ADDED} 条新规则"
        else
            log_info "所有必要规则已存在, 无需修改"
        fi
    else
        log_warn "UFW 未安装, 跳过防火墙配置"
    fi
}

# =============================================================================
# 健康检查
# =============================================================================
health_check() {
    log_step "第 8 步: 系统健康检查"

    local ALL_OK=true

    # 检查 Node.js 进程 (PM2 集群模式)
    if pm2 list | grep -q "${SERVICE_NAME}.*online"; then
        log_success "PM2 进程状态: ✓ 正常运行"
    else
        log_error "PM2 进程状态: ✗ 异常"
        ALL_OK=false
    fi

    # 检查 Redis
    if redis-cli ping 2>/dev/null | grep -q "PONG"; then
        log_success "Redis 连接: ✓ 正常"
    else
        log_error "Redis 连接: ✗ 异常"
        ALL_OK=false
    fi

    # 检查 Nginx
    if [[ "$ENABLE_NGINX" == "true" ]]; then
        if systemctl is-active --quiet nginx; then
            log_success "Nginx 服务: ✓ 正常运行"
        else
            log_error "Nginx 服务: ✗ 未运行"
            ALL_OK=false
        fi

        # 测试 HTTP 端点
        if curl -sf -o /dev/null "http://localhost:${PORT}/health" 2>/dev/null; then
            log_success "HTTP 健康检查: ✓ 通过 (http://localhost:${PORT})"
        else
            log_warn "HTTP 健康检查: ⚠ 无法连接 (可能还在启动中)"
        fi
    fi

    # 系统资源检查
    local MEM_USED_PERCENT=$(free | awk '/Mem/{printf "%.0f", $3/$2*100}')
    local DISK_USED_PERCENT=$(df "$APP_DIR" | awk 'NR==2{printf "%.0f", $5}')

    log_info "系统资源使用率:"
    log_info "  内存: ${MEM_USED_PERCENT}% (${TOTAL_MEM_GB}GB 总计)"
    log_info "  磁盘: ${DISK_USED_PERCENT}%"

    if [[ "$MEM_USED_PERCENT" -gt 90 ]]; then
        log_warn "⚠ 内存使用率过高 (>90%)"
    fi

    if [[ "$DISK_USED_PERCENT" -gt 90 ]]; then
        log_warn "⚠ 磁盘使用率过高 (>90%)"
    fi

    if $ALL_OK; then
        return 0
    else
        return 1
    fi
}

# =============================================================================
# 输出部署摘要 (包含完整的访问信息)
# =============================================================================
print_summary() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                                                              ║"
    echo "║           🎉 CloudCLI 部署完成                               ║"
    echo "║                                                              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""

    # ---- 🌐 访问信息 (最重要，放在最前面) ----
    echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║  🌐  访问信息                                         ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""

    local LAN_IP=$(hostname -I | awk '{print $1}')
    local LOCAL_IP="127.0.0.1"

    echo -e "  ${GREEN}服务地址:${NC}"

    if [[ "$ENABLE_NGINX" == "true" ]]; then
        echo -e "    ${YELLOW}通过 Nginx:${NC}"
        echo -e "      本地:   http://${LOCAL_IP}:80"
        if [[ -n "$LAN_IP" ]]; then
            echo -e "      局域网: http://${LAN_IP}:80"
        fi
        echo -e ""
        echo -e "    ${YELLOW}直连端口:${NC}"
        echo -e "      本地:   http://${LOCAL_IP}:${PORT}"
        if [[ -n "$LAN_IP" ]]; then
            echo -e "      局域网: http://${LAN_IP}:${PORT}"
        fi
    else
        echo -e "      本地:   http://${LOCAL_IP}:${PORT}"
        if [[ -n "$LAN_IP" ]]; then
            echo -e "      局域网: http://${LAN_IP}:${PORT}"
        fi
    fi

    echo ""

    # ---- 🔐 认证信息 ----
    echo -e "  ${GREEN}认证方式:${NC}"
    echo -e "    类型: Linux PAM 认证"
    echo -e "    说明: 使用系统 Linux 用户名和密码登录"
    echo ""

    echo -e "  ${GREEN}登录账户:${NC}"
    echo -e "    用户名: <您的 Linux 用户名>"
    echo -e "    密码:   <您的 Linux 登录密码>"
    echo -e ""
    echo -e "    ${YELLOW}示例:${NC}"
    echo -e "    如果您的用户是 '${CURRENT_USER:-root}', 则使用:"
    echo -e "      用户名: ${CURRENT_USER:-root}"
    echo -e "      密码:   **** (您设置的系统密码)"
    echo ""

    # ---- 👥 快速开始指南 ----
    echo -e "  ${GREEN}快速开始:${NC}"
    echo -e "    1. 打开浏览器访问上方地址"
    echo -e "    2. 输入您的 Linux 用户名和密码"
    echo -e "    3. 开始使用 CloudCLI!"
    echo ""

    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    # ---- 📋 部署详情 ----
    echo "📋 部署配置:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  部署模式:     PM2 集群 (${WORKERS} Workers)"
    echo "  服务端口:     ${PORT}"
    echo "  Worker 数量:  ${WORKERS} 进程"
    echo "  数据库:       ${DATA_DIR}/auth.db"
    echo "  Redis:        ${REDIS_URL}"
    echo "  JWT Secret:   已配置 (${#JWT_SECRET} 字符) - 保存在 ${DATA_DIR}/.jwt_secret"
    echo ""

    echo "📦 PM2 管理命令:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  pm2 status                    查看集群状态"
    echo "  pm2 logs ${SERVICE_NAME}       实时查看日志"
    echo "  pm2 monit                      监控面板 (交互式)"
    echo "  pm2 restart ${SERVICE_NAME}    重启所有 worker"
    echo "  pm2 reload ${SERVICE_NAME}     优雅重启 (零停机)"
    echo ""

    # ---- 👥 用户使用说明 ----
    echo "👥 用户管理:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  创建用户: sudo adduser newuser"
    echo "  管理界面: 登录后访问 Web UI 后台"
    echo "  权限设置: sudo usermod -aG sudo username (提升为管理员)"
    echo ""

    # ---- 🔧 故障排查 ----
    echo "🔧 故障排查:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  应用日志:  tail -f ${APP_DIR}/logs/error.log"
    echo "  Redis 状态: redis-cli ping"
    echo "  系统资源:  htop / free -h / df -h"
    echo "  网络连接:  ss -tlnp | grep -E '(nginx|node|redis)'"
    echo ""

    # ---- 📊 性能指标 ----
    echo "📊 性能配置:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  目标并发:     500 WebSocket 连接 (50用户 × 10会话)"
    echo "  Worker 数:    ${WORKERS} 进程 (${CPU_CORES} CPU 核心)"
    echo "  内存配置:     ${MAX_MEMORY}/worker ≈ $(( WORKERS * 4 )) GB 总计"
    echo "  会话存储:     Redis (${REDIS_MAX_MEMORY})"
    echo "  负载均衡:     Nginx ip_hash (粘性会话)"
    echo ""

    # ---- � 开机自启状态 ----
    echo -e "${GREEN}🔄 开机自启:${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # 检查 Redis
    if command -v redis-server &>/dev/null && systemctl is-enabled --quiet redis-server 2>/dev/null; then
        echo -e "  ✅ Redis:       已配置开机自启"
    else
        echo -e "  ⚠️  Redis:       未配置"
    fi

    # 检查 Nginx
    if command -v nginx &>/dev/null && [[ "$ENABLE_NGINX" == "true" ]] && systemctl is-enabled --quiet nginx 2>/dev/null; then
        echo -e "  ✅ Nginx:       已配置开机自启"
    elif [[ "$ENABLE_NGINX" != "true" ]]; then
        echo -e "  ℹ️  Nginx:       未启用"
    else
        echo -e "  ⚠️  Nginx:       未配置"
    fi

    # 检查应用服务 (PM2 集群)
    if [[ -f "/etc/systemd/system/pm2-${SERVICE_NAME}.service" ]] || \
       [[ -f "/etc/systemd/system/pm2-root.service" ]] || \
       systemctl is-enabled --quiet "pm2-${SERVICE_NAME}" 2>/dev/null; then
        echo -e "  ✅ PM2 集群:     已配置开机自启"
    else
        echo -e "  ⚠️  PM2 集群:     可能未配置 (请检查上方验证结果)"
    fi

    echo ""
    echo -e "  ${YELLOW}💡 提示: 服务器重启后, 所有标记 ✅ 的服务将自动启动${NC}"
    echo ""

    # ---- �️ 卸载信息 ----
    echo -e "${RED}🗑️  卸载删除:${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "  ${YELLOW}sudo $0 --uninstall${NC}"
    echo -e "  (将删除所有部署内容, 需要逐步确认)"
    echo ""
}

# =============================================================================
# 主流程
# =============================================================================
main() {
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                                                              ║"
    echo "║     🚀 CloudCLI 一键部署脚本 v2.0                            ║"
    echo "║                                                              ║"
    echo "║     适用场景: Ubuntu / 40核 256GB / 50用户×10会话            ║"
    echo "║     认证方式: Linux PAM (验证现有系统用户)                    ║"
    echo "║     用户管理: 系统命令 + Web UI 管理后台                     ║"
    echo "║                                                              ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""

    # 执行部署步骤
    check_prerequisites

    deploy_pm2_cluster

    deploy_nginx
    configure_pam_environment
    configure_firewall

    # 最终健康检查
    if health_check; then
        # 验证并配置开机自启 (确保服务器重启后自动启动)
        verify_autostart

        print_summary
        echo "✅ 所有组件运行正常, 部署成功!"
        echo ""
        exit 0
    else
        log_error "❌ 健康检查未完全通过, 请查看上方错误信息"
        echo ""
        exit 1
    fi
}

# =============================================================================
# 卸载功能 (需要用户逐步确认)
# =============================================================================
uninstall_production() {
  echo ""
  echo -e "${RED}==============================================${NC}"
  echo -e "${RED}  ⚠️  CloudCLI 生产环境卸载向导${NC}"
  echo -e "${RED}==============================================${NC}"
  echo ""
  log_warn "此操作将删除以下内容:"
  echo "  1. 停止并删除 PM2 集群进程 (${SERVICE_NAME})"
  echo "  2. 停止并禁用 ${SERVICE_NAME}.service (如果存在)"
  echo "  3. 删除 Nginx 站点配置"
  echo "  4. 删除防火墙规则 (端口 ${PORT})"
  echo "  5. 停止 Redis 服务"
  echo "  6. 删除系统优化配置 (sysctl/limits)"
  echo "  7. 删除 sudoers 权限配置"
  echo "  8. 删除数据目录: ${DATA_DIR}/"
  echo "     (包含数据库: ${DATA_DIR}/auth.db)"
  echo "  9. 清理日志目录: /var/log/${SERVICE_NAME}/"
  echo ""

  # ---- 确认开始卸载 ----
  read -p "是否继续卸载? (输入 'yes' 确认): " CONFIRM_START
  if [[ "$CONFIRM_START" != "yes" ]]; then
    log_info "已取消卸载操作"
    exit 0
  fi

  local STEP=0
  TOTAL_STEPS=9

  # =========================================================================
  # 第 1 步: 停止并删除 PM2 进程
  # =========================================================================
  STEP=$((STEP + 1))
  echo ""
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} PM2 集群进程管理"

  if command -v pm2 &> /dev/null && pm2 list 2>/dev/null | grep -q "${SERVICE_NAME}"; then
    echo "   当前状态:"
    pm2 list | grep -A1 "${SERVICE_NAME}" || true
    echo ""
    read -p "   停止并删除 PM2 进程? (yes/no): " CONFIRM_PM2

    if [[ "$CONFIRM_PM2" == "yes" ]]; then
      pm2 stop "${SERVICE_NAME}" 2>/dev/null || true
      pm2 delete "${SERVICE_NAME}" 2>/dev/null || true
      pm2 save 2>/dev/null || true
      log_success "✓ PM2 进程已停止并删除"

      # 清理 PM2 开机自启配置
      if [[ -f "/etc/systemd/system/pm2-${SERVICE_NAME}.service" ]]; then
        systemctl stop "pm2-${SERVICE_NAME}.service" 2>/dev/null || true
        systemctl disable "pm2-${SERVICE_NAME}.service" 2>/dev/null || true
        rm -f "/etc/systemd/system/pm2-${SERVICE_NAME}.service"
        systemctl daemon-reload 2>/dev/null || true
        log_success "✓ PM2 开机自启已移除 (pm2-${SERVICE_NAME}.service)"
      fi

      # 清理通用 PM2 startup 配置 (如果有)
      for pm2_svc in pm2-root.service pm2-${USER:-root}.service; do
        if [[ -f "/etc/systemd/system/${pm2_svc}" ]]; then
          systemctl disable "${pm2_svc}" 2>/dev/null || true
          rm -f "/etc/systemd/system/${pm2_svc}"
          log_success "✓ PM2 开机自启已移除 (${pm2_svc})"
        fi
      done

      # 可选: 卸载 PM2 日志轮转模块
      read -p "   同时卸载 PM2 日志轮转模块? (yes/no): " CONFIRM_LOGROTATE
      if [[ "$CONFIRM_LOGROTATE" == "yes" ]]; then
        pm2 uninstall pm2-logrotate 2>/dev/null || true
        log_success "✓ PM2 日志模块已卸载"
      fi
    else
      log_warn "跳过 PM2 进程管理"
    fi
  else
    echo "   PM2 未安装或无 ${SERVICE_NAME} 进程, 跳过"
  fi

  # =========================================================================
  # 第 2 步: 停止并禁用 Systemd 服务
  # =========================================================================
  STEP=$((STEP + 1))
  echo ""
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} Systemd 服务管理"

  if systemctl is-enabled "${SERVICE_NAME}.service" &>/dev/null || systemctl is-active "${SERVICE_NAME}.service" &>/dev/null; then
    read -p "   停止并删除 ${SERVICE_NAME}.service? (yes/no): " CONFIRM_SYSTEMD

    if [[ "$CONFIRM_SYSTEMD" == "yes" ]]; then
      systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
      systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
      rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
      systemctl daemon-reload
      log_success "✓ Systemd 服务已停止并删除"
    else
      log_warn "跳过 Systemd 服务"
    fi
  else
    echo "   Systemd 服务不存在, 跳过"
  fi

  # =========================================================================
  # 第 3 步: 删除 Nginx 配置
  # =========================================================================
  STEP=$((STEP + 1))
  echo ""
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} Nginx 配置管理"

  if [[ -f "/etc/nginx/sites-available/${SERVICE_NAME}" ]] || [[ -L "/etc/nginx/sites-enabled/${SERVICE_NAME}" ]]; then
    echo "   当前配置:"
    ls -lh /etc/nginx/sites-enabled/${SERVICE_NAME} 2>/dev/null || true
    echo ""
    read -p "   删除 Nginx 站点配置? (yes/no): " CONFIRM_NGINX

    if [[ "$CONFIRM_NGINX" == "yes" ]]; then
      rm -f "/etc/nginx/sites-available/${SERVICE_NAME}"
      rm -f "/etc/nginx/sites-enabled/${SERVICE_NAME}"
      nginx -t && systemctl reload nginx 2>/dev/null || true
      log_success "✓ Nginx 配置已删除并重载"
    else
      log_warn "跳过 Nginx 配置"
    fi
  else
    echo "   Nginx 配置不存在, 跳过"
  fi

  # =========================================================================
  # 第 4 步: 删除防火墙规则
  # =========================================================================
  STEP=$((STEP + 1))
  echo ""
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} 防火墙规则管理"

  if command -v ufw &> /dev/null && ufw status | grep -q "${PORT}/tcp"; then
    echo "   当前规则: 端口 ${PORT}/tcp (CloudCLI Direct)"
    read -p "   删除此防火墙规则? (yes/no): " CONFIRM_UFW

    if [[ "$CONFIRM_UFW" == "yes" ]]; then
      ufw delete allow "${PORT}/tcp" 2>/dev/null || true
      log_success "✓ 防火墙规则已删除 (端口 ${PORT})"
    else
      log_warn "跳过删除防火墙规则"
    fi
  else
    echo "   无 CloudCLI 防火墙规则, 跳过"
  fi

  # =========================================================================
  # 第 5 步: 停止 Redis 服务
  # =========================================================================
  STEP=$((STEP + 1))
  echo ""
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} Redis 服务管理"

  if pgrep -x redis-server > /dev/null 2>&1; then
    echo "   Redis 正在运行 (PID: $(pgrep -x redis-server))"
    read -p "   停止 Redis 服务? (yes/no): " CONFIRM_REDIS_STOP

    if [[ "$CONFIRM_REDIS_STOP" == "yes" ]]; then
      systemctl stop redis-server.service 2>/dev/null || true
      pkill -9 redis-server 2>/dev/null || true
      log_success "✓ Redis 已停止"
    else
      log_info "保留 Redis 运行"
    fi

    # 恢复 Redis 默认配置
    local REDIS_SERVICE="/etc/systemd/system/redis-server.service"
    if [[ -f "$REDIS_SERVICE" ]] && grep -q "Type=forking" "$REDIS_SERVICE"; then
      echo ""
      read -p "   [可选] 恢复 redis-server 为 Ubuntu 默认配置? (yes/no): " CONFIRM_REDIS_RESTORE

      if [[ "$CONFIRM_REDIS_RESTORE" == "yes" ]]; then
        rm -f "$REDIS_SERVICE"
        systemctl daemon-reload

        # 尝试恢复 redis.conf 备份
        LATEST_BAK=$(ls -t /etc/redis/redis.conf.bak.* 2>/dev/null | head -1)
        if [[ -n "$LATEST_BAK" ]]; then
          cp "$LATEST_BAK" /etc/redis/redis.conf
          log_success "✓ 已恢复 redis.conf 备份"
        fi

        log_success "✓ Redis 已恢复为默认配置"
      else
        log_info "保留当前 Redis 配置"
      fi
    fi
  else
    echo "   Redis 未运行, 跳过"
  fi

  # =========================================================================
  # 第 6 步: 删除系统优化配置
  # =========================================================================
  STEP=$((STEP + 1))
  echo ""
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} 系统优化配置管理"

  local HAS_TUNING=false
  if [[ -f "/etc/sysctl.d/99-cloudcli.conf" ]]; then
    echo "   • 内核参数配置: /etc/sysctl.d/99-cloudcli.conf"
    HAS_TUNING=true
  fi
  if [[ -f "/etc/security/limits.d/99-cloudcli.conf" ]]; then
    echo "   • 文件描述符限制: /etc/security/limits.d/99-cloudli.conf"
    HAS_TUNING=true
  fi

  if [[ "$HAS_TUNING" == "true" ]]; then
    echo ""
    read -p "   删除系统优化配置? (yes/no): " CONFIRM_TUNING

    if [[ "$CONFIRM_TUNING" == "yes" ]]; then
      rm -f /etc/sysctl.d/99-cloudcli.conf
      rm -f /etc/security/limits.d/99-cloudcli.conf
      sysctl --system 2>/dev/null || true
      log_success "✓ 系统优化配置已删除"
      log_warn "⚠️  已生效的参数将在重启后失效"
    else
      log_warn "跳过删除系统配置"
    fi
  else
    echo "   未找到优化配置, 跳过"
  fi

  # =========================================================================
  # 第 7 步: 删除 sudoers 权限配置
  # =========================================================================
  STEP=$((STEP + 1))
  echo ""
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} Sudoers 权限配置"

  local SUDOERS_FILE="/etc/sudoers.d/${SERVICE_NAME}"
  if [[ -f "$SUDOERS_FILE" ]]; then
    echo "   文件: ${SUDOERS_FILE}"
    read -p "   删除 sudoers 配置? (yes/no): " CONFIRM_SUDOERS

    if [[ "$CONFIRM_SUDOERS" == "yes" ]]; then
      rm -f "$SUDOERS_FILE"
      log_success "✓ Sudoers 配置已删除"
    else
      log_warn "跳过删除 sudoers"
    fi
  else
    echo "   sudoers 配置不存在, 跳过"
  fi

  # =========================================================================
  # 第 8 步: 删除数据目录
  # =========================================================================
  STEP=$((STEP + 1))
  echo ""
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} 数据目录管理"

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
      log_success "✓ 数据目录已删除"
    else
      log_warn "跳过删除数据目录"
    fi
  else
    echo "   数据目录不存在, 跳过"
  fi

  # =========================================================================
  # 第 9 步: 清理日志目录
  # =========================================================================
  STEP=$((STEP + 1))
  echo ""
  echo -e "${YELLOW}[${STEP}/${TOTAL_STEPS}]${NC} 日志目录清理"

  local LOG_DIR="/var/log/${SERVICE_NAME}"
  if [[ -d "$LOG_DIR" ]]; then
    local LOG_SIZE=$(du -sh "$LOG_DIR" 2>/dev/null | cut -f1)
    echo "   目录: ${LOG_DIR}/"
    echo "   大小: ${LOG_SIZE:-未知}"
    read -p "   清理日志目录? (yes/no): " CONFIRM_LOGS

    if [[ "$CONFIRM_LOGS" == "yes" ]]; then
      rm -rf "$LOG_DIR"
      log_success "✓ 日志目录已清理"
    else
      log_warn "跳过日志清理"
    fi
  else
    echo "   日志目录不存在, 跳过"
  fi

  # =========================================================================
  # 完成
  # =========================================================================
  echo ""
  echo -e "${GREEN}==============================================${NC}"
  echo -e "${GREEN}  ✅ 生产环境卸载完成${NC}"
  echo -e "${GREEN}==============================================${NC}"
  echo ""
  log_info "卸载摘要:"
  echo "  • PM2 进程: 已停止并删除"
  echo "  • Systemd 服务: 已停止并删除"
  echo "  • Nginx 配置: 已删除"
  echo "  • Redis 服务: 已停止"
  echo "  • 系统配置: 已清理"
  echo "  • 数据目录: 已删除"
  echo "  • 日志文件: 已清理"
  echo ""
  log_info "剩余可手动清理项:"
  echo "  • 应用源码: ${APP_DIR}/ (如需完全删除)"
  echo "  • PM2 全局: npm uninstall -g pm2 (如果不再需要)"
  echo "  • Journal 日志: sudo journalctl --vacuum-time=3d"
  echo "  • Node.js: apt remove nodejs (如果不再需要)"
  echo ""
}

# =============================================================================
# 入口: 根据参数选择安装或卸载
# =============================================================================
if [[ "$UNINSTALL_MODE" == "true" ]]; then
  uninstall_production
else
  main "$@"
fi
