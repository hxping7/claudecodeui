#!/bin/bash

# Claude Code UI PM2 启动脚本
# 用法: ./pm2-start.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="claudecodeui"

echo "=============================================="
echo "  Claude Code UI PM2 启动脚本"
echo "=============================================="

# 检查 PM2 是否安装
if ! command -v pm2 &> /dev/null; then
    echo "[错误] PM2 未安装，请先安装 PM2:"
    echo "  npm install -g pm2"
    exit 1
fi

# 进入项目目录
cd "$SCRIPT_DIR"

# 创建日志目录
mkdir -p logs

# 检查是否已在运行
if pm2 list | grep -q "$APP_NAME"; then
    echo "[信息] 应用已在 PM2 中注册"
    echo "[信息] 正在重启应用..."
    pm2 restart ecosystem.config.cjs
else
    echo "[信息] 正在启动应用..."
    pm2 start ecosystem.config.cjs
fi

echo ""
echo "[成功] 应用已启动!"
echo ""
echo "常用命令:"
echo "  查看状态: pm2 status"
echo "  查看日志: pm2 logs $APP_NAME"
echo "  停止应用: ./pm2-stop.sh"
echo "  重启应用: ./pm2-restart.sh"
echo ""
echo "访问地址: http://localhost:8250"
echo "=============================================="
