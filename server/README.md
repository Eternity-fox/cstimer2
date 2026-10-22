# csTimer2 WebRTC P2P 对战中转服务（TURN/STUN）

用于解决两个魔友在公网因**对称型 NAT（Symmetric NAT）**或严格防火墙导致无法直连时的**流量中继与打洞辅助**。

---

## 📁 文件说明

* **[install_coturn.sh](file:///c:/Users/Etern/Documents/GitHub/cstimer2/server/install_coturn.sh)**：Linux 一键安装与配置脚本（自动识别系统并配置好公网 IP、账号密码）。
* **[turnserver.conf](file:///c:/Users/Etern/Documents/GitHub/cstimer2/server/turnserver.conf)**：Coturn 核心配置文件模板。

---

## 🚀 极速部署方式（1 分钟完成）

在你的 Linux 服务器终端执行以下两行命令即可完成安装并启动：

```sh
# 1. 下载一键脚本并赋予执行权限（如果直接上传了脚本，直接执行即可）
sh install_coturn.sh
```

脚本会自动检测你的公网 IP，安装 `coturn` 并启动服务。

---

## 🎮 在 csTimer 中配置使用

部署完成后，打开 csTimer 的**对战模式**（右侧面板中的“如在公网因双方对称 NAT 导致直连困难，可填入中转服务器”）：

* **服务器地址**：`turn:你的服务器公网IP:3478`
* **用户名**：`cstimer`
* **密码**：`cstimer123`

点击**保存**即可！双方对战时若直连失败，将自动经由你这台云服务器进行低延迟中转。

---

## ⚠️ 关键防火墙放行规则（云控制台安全组）

务必在阿里云 / 腾讯云 / 华为云的安全组放行以下端口：
1. **端口 3478**：协议选择 **TCP + UDP**（STUN/TURN 主通信端口）
2. **端口 49160 - 49200**：协议选择 **UDP**（P2P 媒体/数据中继流量传输通道）
