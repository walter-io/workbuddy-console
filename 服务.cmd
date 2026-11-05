@echo off
chcp 65001 >nul
title WorkBuddy Console Service v2
cd /d "%~dp0"
if not exist logs mkdir logs
echo [%date% %time%] service window started >> logs\service.log

rem 实际跑服务（由「启动控制台.cmd」拉起，独立窗口常驻）。
rem 服务退出（正常停止或启动失败）后窗口停在这里，能看到真实报错。
"%NODE_EXE%" server\index.mjs >> logs\服务.log 2>&1

echo.
echo 服务已退出。若是启动失败，上面的日志（logs\服务.log）里有真实报错；正常停止可直接关窗。
pause
