@echo off
setlocal
chcp 65001 >nul
title random-douyin-like - local server
cd /d "%~dp0spike"

cls
echo.
echo   random-douyin-like - starting local server ...
echo.

rem ---------- 1. Node.js installed? ----------
where node >nul 2>nul
if errorlevel 1 (
    echo   [ERROR] Node.js not found.
    echo.
    echo   Install it first:   https://nodejs.org/
    echo   Then run this file again.
    echo.
    pause
    exit /b 1
)

rem ---------- 2. server.mjs present? ----------
if not exist "server.mjs" (
    echo   [ERROR] server.mjs not found in:
    echo     %CD%
    echo.
    echo   Make sure this .bat sits in the random-douyin-like folder.
    echo.
    pause
    exit /b 1
)

rem ---------- 3. already running? restart it, so the latest code actually loads ----------
rem   Node does NOT hot-reload: after server.mjs changes you MUST restart the process.
rem   The old version just opened the browser when the port was busy, which left a
rem   stale server running forever -- that trap cost real debugging time.
rem   Must match LISTENING too: closed connections linger in TIME_WAIT with the same
rem   local port, and matching those would wrongly report "already running".
netstat -ano | findstr /r /c:"127\.0\.0\.1:5178 " | findstr /c:"LISTENING" >nul 2>nul
if not errorlevel 1 (
    echo   An instance is already running - restarting it to load the latest code ...
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127\.0\.0\.1:5178 " ^| findstr /c:"LISTENING"') do (
        taskkill /PID %%p /F >nul 2>nul
    )
    timeout /t 1 >nul
    echo   Done.
    echo.
)

rem ---------- 4. open the browser ~2s later, in the background ----------
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:5178'"

rem ---------- 5. run the server in the foreground ----------
rem   Closing this window (or Ctrl+C) stops the server.
node server.mjs

echo.
echo   Server stopped. Press any key to close.
pause >nul
