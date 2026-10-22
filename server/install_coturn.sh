#!/bin/sh
# Coturn 一键安装与启动脚本（支持 Debian / Ubuntu / Alpine / CentOS）

echo "======================================"
echo "正在安装 Coturn (WebRTC TURN/STUN 服务器)..."
echo "======================================"

# 自动识别包管理器安装 coturn
if command -v apt-get >/dev/null 2>&1; then
    apt-get update && apt-get install -y coturn
elif command -v apk >/dev/null 2>&1; then
    apk update && apk add coturn
elif command -v yum >/dev/null 2>&1; then
    yum install -y epel-release && yum install -y coturn
elif command -v dnf >/dev/null 2>&1; then
    dnf install -y coturn
else
    echo "❌ 无法识别系统的包管理器，请手动安装 coturn"
    exit 1
fi

echo "✅ Coturn 软件包安装完成！"

# 获取本机的公网 IP
PUBLIC_IP=$(curl -s4 ifconfig.me || curl -s4 ip.sb || curl -s4 api.ipify.org)
echo "检测到你的公网 IP 为: $PUBLIC_IP"

# 覆盖生成 /etc/turnserver.conf
cat <<EOF > /etc/turnserver.conf
listening-port=3478
listening-ip=0.0.0.0
external-ip=$PUBLIC_IP
fingerprint
lt-cred-mech
realm=cstimer.local
user=cstimer:cstimer123
min-port=49160
max-port=49200
verbose
EOF

echo "✅ 配置文件 /etc/turnserver.conf 已生成！"

# 如果是 Debian/Ubuntu，默认禁用了 coturn，需要激活
if [ -f /etc/default/coturn ]; then
    sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/g' /etc/default/coturn
    sed -i 's/TURNSERVER_ENABLED=0/TURNSERVER_ENABLED=1/g' /etc/default/coturn
fi

# 启动服务
if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
    systemctl daemon-reload
    systemctl enable --now coturn || systemctl restart coturn
    echo "✅ 已通过 systemd 启动 Coturn！"
else
    # 容器 / Alpine 环境后台直接启动
    pkill -f turnserver 2>/dev/null
    nohup turnserver -o -c /etc/turnserver.conf > /var/log/turnserver.log 2>&1 &
    echo "✅ 已后台启动 turnserver 进程！"
fi

echo "======================================"
echo "🎉 部署完成！请在 csTimer 对战页面填入："
echo "TURN 服务器地址: turn:$PUBLIC_IP:3478"
echo "用户名: cstimer"
echo "密码: cstimer123"
echo "======================================"
echo "⚠️ 注意：请务必在云服务器控制台安全组放行以下端口："
echo "1. UDP/TCP: 3478"
echo "2. UDP: 49160-49200"
echo "======================================"
