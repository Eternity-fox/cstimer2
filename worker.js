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
        multiplier: room.multipliers[p.accountId] || 1.0
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

          // 防止同名覆盖（例如两端默认都叫 Player_123）
          if (curRoom.players.has(accId) && curRoom.players.get(accId).ws !== server) {
            accId = accId + '_' + Math.floor(Math.random() * 90 + 10);
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
