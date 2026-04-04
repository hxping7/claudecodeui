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
set "FOUND_PID="
set "FOUND_PROCESS="
set "FOUND_CMDLINE="
set "IS_CLOUDCLI=0"

for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8250 ^| findstr LISTENING') do (
    set "FOUND_PID=%%a"
)

if defined FOUND_PID (
    for /f "tokens=1" %%b in ('tasklist /FI "PID eq !FOUND_PID!" /NH 2^>nul ^| findstr !FOUND_PID!') do (
        set "FOUND_PROCESS=%%b"
    )
    
    for /f "tokens=*" %%c in ('wmic process where "ProcessId=!FOUND_PID!" get CommandLine /value 2^>nul ^| findstr "CommandLine="') do (
        set "FOUND_CMDLINE=%%c"
    )
    
    echo !FOUND_CMDLINE! | findstr /i "cloudcli server/index.js" >nul 2>&1
    if !errorlevel! equ 0 (
        set "IS_CLOUDCLI=1"
    )
    
    if "!IS_CLOUDCLI!"=="1" (
        echo 发现 CloudCLI 进程 (PID: !FOUND_PID!)，正在终止...
        taskkill /PID !FOUND_PID! /F >nul 2>&1
        timeout /t 1 >nul
        echo 已终止旧进程
    ) else (
        echo.
        echo [错误] 端口 8250 被其他应用占用:
        echo   PID: !FOUND_PID!
        echo   进程名: !FOUND_PROCESS!
        if defined FOUND_CMDLINE (
        echo   命令行: !FOUND_CMDLINE:CommandLine=!
        )
        echo.
        echo 请手动关闭该进程后重试。
        pause
        exit /b 1
    )
) else (
    echo 端口 8250 空闲
)

echo.
cd /d D:\

echo 正在启动 CloudCLI...
echo 访问地址: http://localhost:8250
echo.

cloudcli.cmd

pause
