@echo off
title csTimer 对战服务
echo ====================================================
echo        正在启动 csTimer 本地服务...
echo ====================================================
echo.
echo 本地网页地址: http://127.0.0.1:8000
echo.
start http://127.0.0.1:8000
python battle_server.py 8000
pause
