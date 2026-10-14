@echo off
chcp 65001 >nul
echo ====================================================
echo        正在启动 csTimer 本地网页服务...
echo ====================================================
echo.
echo 本地服务地址: http://localhost:8000
echo 正在为你自动打开浏览器...
echo (关闭此黑框窗口即可停止运行)
echo.

start http://localhost:8000
python -m http.server 8000

pause
