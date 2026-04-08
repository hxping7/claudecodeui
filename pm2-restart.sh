#!/bin/bash

# Claude Code UI PM2 重启脚本
# 用法: ./pm2-restart.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="claudecodeui"

echo "=============================================="
echo "  Claude Code UI PM2 重启脚本"
echo "=============================================="

# 检查 PM2 是否安装
if ! command -v pm2 &> /dev/null; then
    echo "[错误] PM2 未安装，请先安装 PM2:"
    echo "  npm install -g pm2"
    exit 1
fi

# 进入项目目录
cd "$SCRIPT_DIR"

# 检查应用是否在运行
if pm2 list | grep -q "$APP_NAME"; then
    echo "[信息] 正在重启应用..."
    pm2 restart ecosystem.config.cjs
else
    echo "[信息] 应用未运行，正在启动..."
    mkdir -p logs
    pm2 start ecosystem.config.cjs
fi

echo ""
echo "[成功] 操作完成!"
echo ""
echo "查看状态: pm2 status"
echo "查看日志: pm2 logs $APP_NAME"
echo "=============================================="
