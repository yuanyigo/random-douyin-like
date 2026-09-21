@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title random-douyin-like - stop server

cls
echo.
echo   random-douyin-like - stopping local server ...
echo.

set FOUND=0
set KILLED=0

rem Find whatever is LISTENING on 127.0.0.1:5178 and kill it.
rem Filtering on LISTENING matters: closed connections linger in TIME_WAIT with
rem the same local port, and acting on those would hit an unrelated PID.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127\.0\.0\.1:5178 " ^| findstr /c:"LISTENING"') do (
    set FOUND=1
    echo   Found server on PID %%p, stopping ...
    taskkill /PID %%p /F >nul 2>nul
    if not errorlevel 1 set KILLED=1
)

echo.
if "!FOUND!"=="0" (
    echo   Nothing is listening on port 5178 - already stopped.
) else (
    if "!KILLED!"=="1" (
        echo   Done. Port 5178 is free now.
    ) else (
        echo   [ERROR] Found the server but could not stop it.
        echo.
        echo   Easiest fix: just close the window that start.bat opened.
        echo   Or: right-click this file -^> Run as administrator
        echo   Or: Task Manager -^> end the "Node.js" process
    )
)

echo.
echo   Press any key to close.
pause >nul
