@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
echo ==========================================
echo   CloudCLI 启动脚本
echo   端口: 8250
echo ==========================================
echo.

set SERVER_PORT=8250
set WORKSPACES_ROOT=D:\

echo 正在检查端口 8250 是否被占用...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8250 ^| findstr LISTENING') do (
    echo 发现占用端口的进程 PID: %%a，正在终止...
    taskkill /PID %%a /F >nul 2>&1
    if !errorlevel! equ 0 (
        echo 已成功终止进程 %%a
    ) else (
        echo 终止进程 %%a 失败，可能需要管理员权限
    )
    timeout /t 1 >nul
)

echo 端口检查完成
echo.

cd /d D:\

echo 正在启动 CloudCLI...
echo 访问地址: http://localhost:8250
echo.

cloudcli.cmd

pause
