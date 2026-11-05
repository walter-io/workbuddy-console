@echo off
title WorkBuddy Console v2
cd /d "%~dp0"

rem Block WorkBuddy-injected file shims (intermittent EPERM on ~/.wb-switch);
rem keep --use-system-ca (outbound HTTPS behind corporate proxies).
set "NODE_OPTIONS=--use-system-ca"

set "WB_PORT=57913"
set "PORT=%WB_PORT%"

rem Already running: just open the page.
netstat -ano | findstr ":%WB_PORT% " | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  start "" "http://127.0.0.1:%WB_PORT%"
  exit /b 0
)

rem Start the server fully detached via PowerShell (survives this window closing).
rem The scheduler runs in-process: hourly catch-ups + the daily claim at the
rem configured time (+ deterministic daily random delay).
powershell -NoProfile -Command "$env:PORT='57913'; $env:NODE_OPTIONS='--use-system-ca'; Start-Process -FilePath 'node' -ArgumentList 'server/index.mjs' -WorkingDirectory (Get-Location).Path -WindowStyle Hidden"

rem Give the server a moment, then open the console page.
timeout /t 3 >nul
start "" "http://127.0.0.1:%WB_PORT%"
