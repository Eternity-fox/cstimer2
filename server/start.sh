#!/bin/sh
# Realm 快捷启动管理脚本（兼容 systemd 与非 systemd/Alpine/容器环境）

CONFIG_PATH="/etc/realm/config.toml"
BIN_PATH="/usr/local/bin/realm"
LOG_PATH="/var/log/realm.log"
PID_FILE="/var/run/realm.pid"

check_systemd() {
    if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

start() {
    if [ ! -f "$BIN_PATH" ]; then
        echo "❌ 未找到 realm 程序 ($BIN_PATH)，请先安装。"
        exit 1
    fi
    if [ ! -f "$CONFIG_PATH" ]; then
        echo "❌ 未找到配置文件 ($CONFIG_PATH)，请先上传。"
        exit 1
    fi

    if check_systemd; then
        echo "检测到 systemd，正在通过 systemctl 启动..."
        systemctl start realm
        systemctl status realm --no-pager
    else
        echo "未检测到 systemd（容器/精简环境），使用后台常驻方式启动..."
        if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
            echo "⚠️ Realm 已经在运行中 (PID: $(cat "$PID_FILE"))"
            exit 0
        fi
        nohup "$BIN_PATH" -c "$CONFIG_PATH" > "$LOG_PATH" 2>&1 &
        echo $! > "$PID_FILE"
        sleep 1
        if kill -0 $(cat "$PID_FILE") 2>/dev/null; then
            echo "✅ Realm 启动成功！(PID: $(cat "$PID_FILE"))"
            echo "日志路径: $LOG_PATH"
        else
            echo "❌ Realm 启动失败，请检查日志: $LOG_PATH"
        fi
    fi
}

stop() {
    if check_systemd; then
        systemctl stop realm
        echo "✅ 已停止 Realm 服务。"
    else
        if [ -f "$PID_FILE" ]; then
            kill $(cat "$PID_FILE") 2>/dev/null
            rm -f "$PID_FILE"
            echo "✅ 已停止后台 Realm 进程。"
        else
            pkill -f "$BIN_PATH" 2>/dev/null && echo "✅ 已终止 Realm 进程。" || echo "⚠️ 未找到正在运行的 Realm 进程。"
        fi
    fi
}

status() {
    if check_systemd; then
        systemctl status realm --no-pager
    else
        if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
            echo "✅ Realm 正在运行 (PID: $(cat "$PID_FILE"))"
        else
            echo "⭕ Realm 未运行"
        fi
        ps | grep realm | grep -v grep
    fi
}

case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        stop
        sleep 1
        start
        ;;
    status)
        status
        ;;
    *)
        echo "使用方法: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
