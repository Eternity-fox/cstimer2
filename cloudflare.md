# csTimer 全球对战服务器：Cloudflare Workers + Durable Objects 零基础部署教程

本文档介绍如何利用 **Cloudflare Workers** 及其官方 **Durable Objects（全局持久单例）**，从零开始搭建一个永久免费、自带权威 SSL 证书（合法 `wss://`）、全球低延迟的 csTimer 多人实时对战服务端。

---

## 目录
- [一、核心背景与技术架构](#一核心背景与技术架构)
- [二、准备工作](#二准备工作)
- [三、核心代码与配置文件](#三核心代码与配置文件)
  - [1. worker.js（对战状态机与单例逻辑）](#1-workerjs对战状态机与单例逻辑)
  - [2. wrangler.jsonc（Cloudflare 部署声明）](#2-wranglerjsonccloudflare-部署声明)
- [四、从零部署全流程（纯云端，免装本地开发环境）](#四从零部署全流程纯云端免装本地开发环境)
- [五、进阶：国内直连免梯子配置（绑定自定义域名）](#五进阶国内直连免梯子配置绑定自定义域名)
- [六、客户端联机使用指南](#六客户端联机使用指南)
- [七、常见问题与排错手册（FAQ）](#七常见问题与排错手册faq)

---

## 一、核心背景与技术架构

### 1. 传统局域网/自建对战的痛点
- **HTTPS 混合内容阻断（Mixed Content）**：现代移动端浏览器（Safari / Chrome）通过 `https://` 访问网页时，强制拦截任何非安全的 `ws://` 明文 WebSocket 连接，导致内网穿透直连报 `SecurityError`。
- **对称型 NAT 拦截**：手机 5G / 校园网等处于严格网络防火墙下，纯 P2P 打洞极易失败。

### 2. Cloudflare Durable Objects 解决方案
- **权威 SSL 证书**：Cloudflare 分配的域名原生支持合法安全的 `wss://` 连接，手机端无论在何种网络环境下均可 100% 连通。
- **全局单例房间聚合（Durable Objects）**：传统的 Serverless Worker 会将全球用户分散在数百个边缘物理机房，导致各自在一个房间。通过启用 Durable Objects，全球任意地区（电脑、手机、平板）连入相同房间号时，都会被强制聚合到**同一个运行实例的内存中**，实现实时广播、毫秒级计时同步与计分板共享。

---

## 二、准备工作

1. **Cloudflare 账号**：前往 [Cloudflare 官网](https://dash.cloudflare.com/) 注册一个免费账号。
2. **GitHub 仓库**：确保您的 csTimer 代码存放在 GitHub（例如 `Eternity-fox/cstimer2`）。

---

## 三、核心代码与配置文件

在代码仓库根目录必须包含以下两个核心文件：

### 1. `worker.js`（对战状态机与单例逻辑）
```javascript
// csTimer 全局协同对战服务器 (Durable Object 单例架构)
export class BattleRoom {
  constructor(state, env) {
    this.state = state;
    this.rooms = new Map();
  }

  broadcast(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const info = {
      roomId: room.roomId,
      players: Array.from(room.players.values()).map(p => ({
        accountId: p.accountId,
        elo: p.elo || 1500,
        status: p.status || 'READY',
        isHost: p.isHost || false,
        multiplier: room.multipliers[p.accountId] || 1.0,
        stoppedTime: p.stoppedTime
      })),
      cur: [room.curSolveId, room.curScramble],
      last: [room.curSolveId - 1, room.lastScramble],
      solves: room.solves,
      multipliers: Object.assign({}, room.multipliers),
      scoreboard: room.scoreboard
    };
    const msgStr = JSON.stringify({ roomInfo: info });
    for (const p of room.players.values()) {
      try { p.ws.send(msgStr); } catch (e) {}
    }
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('csTimer WSS Battle Server Online!', {
        status: 200,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }
      });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();

    let curRoom = null;
    let curAccId = null;

    server.addEventListener('message', event => {
      try {
        const msg = JSON.parse(event.data);
        const action = msg.action;
        const msgid = msg.msgid;

        // 1. 心跳保活：立即响应，防止 Cloudflare 100秒无操作强制断开
        if (action === 'heartBeat') {
          try {
            server.send(JSON.stringify({ action: 'heartBeatAck', ret: 0, msgid: msgid }));
          } catch (e) {}
          return;
        }

        // 2. 极速时钟转发：无缓冲直达对手，消除网络堆积
        if (action === 'liveTick' && curRoom && curAccId) {
          const tickStr = JSON.stringify(msg);
          for (const pl of curRoom.players.values()) {
            if (pl.ws !== server) {
              try { pl.ws.send(tickStr); } catch (e) {}
            }
          }
          return;
        }

        // 3. 极速停止计时广播：在选手松手/敲击空格瞬间立即让对手界面定格，彻底消灭1~2秒及更久延迟！
        if (action === 'timerStop' && curRoom && curAccId) {
          const p = curRoom.players.get(curAccId);
          if (p) {
            p.status = 'STOPPED';
            p.stoppedTime = msg.finalMs;
          }
          const stopStr = JSON.stringify({
            action: 'timerStop',
            accountId: curAccId,
            stopAt: msg.stopAt || Date.now(),
            finalMs: msg.finalMs
          });
          for (const pl of curRoom.players.values()) {
            if (pl.ws !== server) {
              try { pl.ws.send(stopStr); } catch (e) {}
            }
          }
          return;
        }

        if (action === 'joinRoom') {
          const roomId = String(msg.roomId || '666').trim();
          let accId = String(msg.accountId || 'Player').trim();
          const scramble = msg.scramble || "R U R' U'";

          if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, {
              roomId,
              curSolveId: 1,
              curScramble: scramble,
              lastScramble: '',
              players: new Map(),
              solves: [],
              multipliers: {},
              autoNext: true,
              scoreboard: { enabled: true, x: 3, y: 5, scores: {}, bigScores: {}, winner: null }
            });
          }
          curRoom = this.rooms.get(roomId);

          // 防止同名覆盖（例如两端默认昵称相同时自动补随机后缀）
          if (curRoom.players.has(accId) && curRoom.players.get(accId).ws !== server) {
            accId = accId + '_' + Math.floor(Math.random() * 90 + 10);
            try {
              server.send(JSON.stringify({ action: 'setAccountId', accountId: accId }));
            } catch (e) {}
          }
          curAccId = accId;

          const isFirst = (curRoom.players.size === 0);
          curRoom.players.set(accId, {
            accountId: accId,
            elo: 1500,
            status: 'READY',
            isHost: isFirst,
            ws: server
          });
          curRoom.multipliers[accId] = curRoom.multipliers[accId] || 1.0;

          if (msgid) server.send(JSON.stringify({ msgid, ret: 0 }));
          this.broadcast(roomId);

        } else if (action === 'updateStatus' && curRoom && curAccId) {
          const p = curRoom.players.get(curAccId);
          if (p) p.status = msg.status || 'READY';
          if (msgid) server.send(JSON.stringify({ msgid, ret: 0 }));
          this.broadcast(curRoom.roomId);

        } else if (action === 'uploadSolve' && curRoom && curAccId) {
          const timeData = msg.time;
          const rawMs = (timeData && timeData[0] && timeData[0][1]) ? timeData[0][1] : -1;
          curRoom.solves.push({
            accountId: curAccId,
            solveId: msg.solveId || curRoom.curSolveId,
            time: timeData,
            soltime: rawMs > 0 ? (rawMs / 1000) : -1
          });
          const p = curRoom.players.get(curAccId);
          if (p) p.status = 'SOLVED';

          let allSolved = true;
          for (const pl of curRoom.players.values()) {
            if (pl.status !== 'SOLVED') { allSolved = false; break; }
          }
          if (allSolved && curRoom.players.size > 1 && curRoom.autoNext) {
            curRoom.lastScramble = curRoom.curScramble;
            if (msg.scramble) curRoom.curScramble = msg.scramble;
            curRoom.curSolveId += 1;
            for (const pl of curRoom.players.values()) pl.status = 'READY';
          }
          if (msgid) server.send(JSON.stringify({ msgid, ret: 0 }));
          this.broadcast(curRoom.roomId);

        } else if (action === 'leaveRoom' && curRoom && curAccId) {
          curRoom.players.delete(curAccId);
          if (curRoom.players.size === 0) this.rooms.delete(curRoom.roomId);
          else this.broadcast(curRoom.roomId);
          if (msgid) server.send(JSON.stringify({ msgid, ret: 0 }));
          curRoom = null;
          curAccId = null;
        }
      } catch (err) {}
    });

    server.addEventListener('close', () => {
      if (curRoom && curAccId) {
        curRoom.players.delete(curAccId);
        if (curRoom.players.size === 0) this.rooms.delete(curRoom.roomId);
        else this.broadcast(curRoom.roomId);
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('csTimer WSS Battle Server Online!', {
        status: 200,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }
      });
    }
    // 全球所有连接自动路由到同一个 global 单例，彻底消除机房隔离
    const id = env.BATTLE_ROOM.idFromName('global');
    const obj = env.BATTLE_ROOM.get(id);
    return obj.fetch(request);
  }
};
```

---

### 2. `wrangler.jsonc`（Cloudflare 部署声明）
> [!IMPORTANT]
> 必须是 `wrangler.jsonc` 文件，避免自动化 CI 编译时因交互式询问而卡住失败。

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cstimer2",
  "main": "worker.js",
  "compatibility_date": "2024-09-23",
  "durable_objects": {
    "bindings": [
      {
        "name": "BATTLE_ROOM",
        "class_name": "BattleRoom"
      }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["BattleRoom"]
    }
  ]
}
```

---

## 四、从零部署全流程（纯云端，免装本地开发环境）

不需要在您本地电脑安装 Node.js、npm 或 Wrangler，全部由 Cloudflare 官方构建机自动完成：

### 步骤 1：提交代码至 GitHub
确保上述 `worker.js` 与 `wrangler.jsonc` 已经推送到您的 GitHub 远程仓库（例如 `main` 或 `master` 分支）。

### 步骤 2：登录 Cloudflare 并关联 GitHub
1. 打开并登录 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2. 在左侧菜单栏点击 **Compute（计算）** -> **Workers & Pages（Workers 和 Pages）**。
3. 点击页面中间或右上角的 **Create application（创建应用程序）**。
4. 切换到 **Pages** 或选择 **Connect to Git（连接到 Git）**。
5. 授权并选中您的代码仓库（如 `Eternity-fox/cstimer2`）。

### 步骤 3：配置构建参数并一键部署
1. **Project name（项目名称）**：填入您喜欢的名称（例如 `cstimer2`）。
2. **Production branch（生产分支）**：选择您推送代码的分支（如 `main` 或 `master`）。
3. **Build command（构建命令）**：**保持留空**（不需要填任何内容）。
4. **Deploy command（部署命令）**：默认保持 `npx wrangler deploy`。
5. 点击 **Save and Deploy（保存并部署）**。

### 步骤 4：确认部署成功
几秒钟后，Cloudflare 构建日志将输出如下信息：
```text
Binding                           Resource            
env.BATTLE_ROOM (BattleRoom)      Durable Object      

Uploaded cstimer2
Deployed cstimer2 triggers
  https://cstimer2.your-name.workers.dev
```
出现绿色的 **`✔ Build Succeeded`** 状态，即代表全局 Durable Object 对战服务器已经全自动部署上线！

---

## 五、进阶：国内直连免梯子配置（绑定自定义域名）

### 为什么默认域名在国内部分网络打不开？
Cloudflare 赠送的免费默认域名后缀为 `*.workers.dev`。该后缀因被国内三大运营商的 DNS 污染拦截，裸连时可能出现超时，通常需要挂代理。

### 彻底解决办法：绑定自有域名（无需翻墙，直连秒开）
如果您持有个人域名（例如 `etfox.com.cn`）：

1. **将域名接入 Cloudflare（免费）**：
   - 在 Cloudflare 控制台首页点击 **Add a domain（添加站点）**，输入您的主域名（如 `etfox.com.cn`），选择 **Free（免费版）**。
   - Cloudflare 会自动扫描并保留您原有的解析记录（如原本解析到 GitHub Pages 的记录不会受到影响）。
   - Cloudflare 会给出两个 Nameserver（如 `xx.ns.cloudflare.com`）。
   - 前往您的域名注册商后台（阿里云/腾讯云/万网），将域名的 DNS 服务器修改为 Cloudflare 的这两个地址。

2. **为 Worker 绑定自定义子域名**：
   - 进入 Cloudflare 控制台 -> **Workers & Pages** -> 选择刚才部署的 `cstimer2` 项目。
   - 切换到 **Settings（设置）** -> **Domains & Routes（域与路由）**。
   - 点击 **Add Custom Domain（添加自定义域）**。
   - 输入您希望的对战子域名，例如：
     ```text
     battle.etfox.com.cn
     ```
   - 点击保存，Cloudflare 会自动完成解析并签发合法的 SSL/TLS 证书。

> 绑定完成后，国内任何 5G 手机、家用 Wi-Fi 访问 `battle.etfox.com.cn` 均可**不挂梯子裸连直通**！

---

## 六、客户端联机使用指南

部署完成后，即可在 csTimer 网页端中畅享联机：

1. **打开对战窗口**：
   - 打开 csTimer（无论本地 `localhost:8000` 还是线上 `https://cstimer.etfox.com.cn`）。
   - 在右侧对战工具面板点击 **【🚀 穿透/服务器对战】**。

2. **输入服务器与房间号**：
   - **服务器地址 (WebSocket)**：填入刚才部署的域名（如 `cstimer2.eternity-fox.workers.dev`，或自定义域名 `battle.etfox.com.cn`）。
   - **对战房间号**：双方填入相同的房间号（例如 `666`）。
   - 点击 **【连接并进入房间】**。

3. **进入对战房间**：
   - 双方进入同一个房间后，房间列表中会立即列出全员名字。
   - 支持**动态打乱同步**、**实时完成秒数计算**、**让步倍率计算**以及**抢 X 局点计分板**。

---

## 七、常见问题与排错手册（FAQ）

### Q1：为什么之前网页端添加 Durable Object 显示 `No Durable Object found`？
**解答**：Cloudflare 限制了网页控制台不能凭空新建 Durable Object。必须在项目中通过 `wrangler.jsonc` 声明 `[durable_objects]` 与 `[migrations]`，由 Cloudflare 自动运行 `npx wrangler deploy` 来完成底层的类注册和数据库激活。

### Q2：两端都填了相同的名字，会不会互相顶掉？
**解答**：不会。`worker.js` 中内置了智能去重机制。如果两端都使用默认昵称（如 `Player`），后加入者会自动加上随机数字后缀（如 `Player_88`），确保两端独立计分。

### Q3：比赛结束后下一轮打乱由谁派发？
**解答**：房间内第一位加入者自动担任**房主**。当勾选“全员完成自动下一轮”时，所有选手完成还原后系统将自动下发全新打乱；房主也可手动点击派发。
