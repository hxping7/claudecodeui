#!/bin/bash

# Claude Code UI PM2 停止脚本
# 用法: ./pm2-stop.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="claudecodeui"

echo "=============================================="
echo "  Claude Code UI PM2 停止脚本"
echo "=============================================="

# 检查 PM2 是否安装
if ! command -v pm2 &> /dev/null; then
    echo "[错误] PM2 未安装"
    exit 1
fi

# 检查应用是否在运行
if ! pm2 list | grep -q "$APP_NAME"; then
    echo "[信息] 应用未在运行"
    exit 0
fi

echo "[信息] 正在停止应用..."
pm2 stop ecosystem.config.cjs

echo ""
echo "[成功] 应用已停止!"
echo "=============================================="
