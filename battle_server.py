#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
csTimer 本地内网穿透对战服务端 (HTTP + WebSocket 双合一)
- 零第三方依赖：纯 Python 3 内置标准库 (asyncio, hashlib, base64, struct, json, os, mimetypes)
- 单端口复用：同一个端口同时提供网页静态文件服务与 WebSocket 对战房间管理，配合内网穿透软件只需映射 1 个端口！
- 100% 连通：纯 TCP / WebSocket 协议，彻底摆脱公网 WebRTC 对称 NAT 打洞失败的烦恼！
"""

import sys
import os
import json
import asyncio
import hashlib
import base64
import struct
import mimetypes
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# ----------------- 房间管理状态 -----------------
# rooms: roomId -> dict
rooms = {}

def get_or_create_room(room_id, first_player_id, initial_scramble=None):
    if room_id not in rooms:
        rooms[room_id] = {
            "roomId": room_id,
            "curSolveId": 1,
            "curScramble": initial_scramble or "R U R' U'",
            "lastScramble": "",
            "players": {},       # accountId -> { accountId, elo, status, isHost, multiplier, writer }
            "solves": [],        # list of { accountId, solveId, time, soltime }
            "multipliers": {},
            "autoNext": True,
            "scoreboard": {
                "enabled": True,
                "x": 3,
                "y": 5,
                "scores": {},    # accountId -> int
                "bigScores": {}, # accountId -> int
                "winner": None
            },
            "scoredSolveIds": {}
        }
    room = rooms[room_id]
    if initial_scramble and room["curScramble"] in ("R U R' U'", ""):
        room["curScramble"] = initial_scramble
    return room

def build_room_info(room):
    players_list = []
    for acc_id, p in room["players"].items():
        players_list.append({
            "accountId": acc_id,
            "elo": p.get("elo", 1500),
            "status": p.get("status", "READY"),
            "isHost": p.get("isHost", False),
            "multiplier": room["multipliers"].get(acc_id, 1.0)
        })
    return {
        "roomId": room["roomId"],
        "players": players_list,
        "cur": [room["curSolveId"], room["curScramble"]],
        "last": [room["curSolveId"] - 1, room["lastScramble"]],
        "solves": room["solves"][:],
        "multipliers": dict(room["multipliers"]),
        "scoreboard": {
            "enabled": bool(room["scoreboard"]["enabled"]),
            "x": room["scoreboard"].get("x", 3),
            "y": room["scoreboard"].get("y", 5),
            "scores": dict(room["scoreboard"]["scores"]),
            "bigScores": dict(room["scoreboard"]["bigScores"]),
            "winner": room["scoreboard"]["winner"]
        }
    }

async def broadcast_room(room):
    info = build_room_info(room)
    msg_bytes = encode_ws_frame(json.dumps({"roomInfo": info}))
    dead_accs = []
    for acc_id, p in list(room["players"].items()):
        writer = p.get("writer")
        if writer and not writer.is_closing():
            try:
                writer.write(msg_bytes)
                await writer.drain()
            except Exception:
                dead_accs.append(acc_id)
        else:
            dead_accs.append(acc_id)
    for da in dead_accs:
        remove_player_from_room(room, da)

def remove_player_from_room(room, acc_id):
    if acc_id in room["players"]:
        was_host = room["players"][acc_id].get("isHost", False)
        del room["players"][acc_id]
        if was_host and room["players"]:
            next_host = next(iter(room["players"]))
            room["players"][next_host]["isHost"] = True
    if not room["players"]:
        if room["roomId"] in rooms:
            del rooms[room["roomId"]]

# ----------------- WebSocket 帧编解码 -----------------
def encode_ws_frame(text):
    payload = text.encode("utf-8")
    length = len(payload)
    if length < 126:
        header = struct.pack("!BB", 0x81, length)
    elif length <= 0xFFFF:
        header = struct.pack("!BBH", 0x81, 126, length)
    else:
        header = struct.pack("!BBQ", 0x81, 127, length)
    return header + payload

async def read_ws_frame(reader):
    header = await reader.readexactly(2)
    b1, b2 = header[0], header[1]
    fin = (b1 & 0x80) != 0
    opcode = b1 & 0x0F
    is_masked = (b2 & 0x80) != 0
    payload_len = b2 & 0x7F

    if payload_len == 126:
        ext = await reader.readexactly(2)
        payload_len = struct.unpack("!H", ext)[0]
    elif payload_len == 127:
        ext = await reader.readexactly(8)
        payload_len = struct.unpack("!Q", ext)[0]

    mask_key = None
    if is_masked:
        mask_key = await reader.readexactly(4)

    payload_data = await reader.readexactly(payload_len)
    if is_masked and mask_key:
        unmasked = bytearray(payload_len)
        for i in range(payload_len):
            unmasked[i] = payload_data[i] ^ mask_key[i % 4]
        payload_data = bytes(unmasked)

    return opcode, payload_data

# ----------------- 核心连接处理 -----------------
async def handle_connection(reader, writer):
    peer = writer.get_extra_info('peername')
    print(f"\n[收到新连接] 来源: {peer}")
    try:
        # 开启 TCP_NODELAY 彻底关闭 Nagle 算法，消除 200ms~500ms 缓冲延迟
        sock = writer.get_extra_info('socket')
        if sock:
            try:
                import socket
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except Exception:
                pass

        # 读取 HTTP 请求头（超时5秒防止挂起）
        request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
        if not request_line:
            print("[连接关闭] 未收到任何请求数据即断开")
            writer.close()
            return
        req_str = request_line.decode("utf-8", errors="ignore").strip()
        print(f"[收到请求行] {req_str}")
        parts = req_str.split()
        if len(parts) < 2:
            writer.close()
            return
        method, path = parts[0], parts[1]

        headers = {}
        while True:
            line = await reader.readline()
            if not line or line in (b"\r\n", b"\n"):
                break
            h_str = line.decode("utf-8", errors="ignore").strip()
            if ":" in h_str:
                k, v = h_str.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        # 判断是否为 WebSocket 握手
        if headers.get("upgrade", "").lower() == "websocket" and "sec-websocket-key" in headers:
            ws_key = headers["sec-websocket-key"]
            accept_hash = hashlib.sha1((ws_key + WS_GUID).encode("utf-8")).digest()
            accept_val = base64.b64encode(accept_hash).decode("utf-8")

            resp = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept_val}\r\n"
                "\r\n"
            )
            writer.write(resp.encode("utf-8"))
            await writer.drain()

            # 进入 WebSocket 消息处理循环
            await handle_ws_session(reader, writer)
            return

        # 否则作为静态 HTTP 文件服务器响应
        await handle_http_request(method, path, writer)
    except Exception as e:
        import traceback
        print(f"[Server Error] {e}")
        traceback.print_exc()
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass

async def handle_ws_session(reader, writer):
    current_room = None
    current_acc_id = None
    try:
        while True:
            try:
                opcode, data = await read_ws_frame(reader)
            except (asyncio.IncompleteReadError, ConnectionResetError):
                break

            if opcode == 0x8:  # Close
                break
            elif opcode == 0x9:  # Ping
                writer.write(struct.pack("!BB", 0x8A, 0))  # Pong
                await writer.drain()
                continue
            elif opcode == 0xA:  # Pong
                continue
            elif opcode != 0x1:  # 仅处理文本帧
                continue

            text = data.decode("utf-8", errors="ignore")
            if not text:
                continue

            try:
                msg = json.loads(text)
            except Exception:
                continue

            action = msg.get("action")
            msg_id = msg.get("msgid")

            # 心跳保活处理：立即应答，防止 NAT 超时静默断流
            if action == "heartBeat":
                ack = encode_ws_frame(json.dumps({"action": "heartBeatAck", "ret": 0, "msgid": msg_id}))
                writer.write(ack)
                await writer.drain()
                continue

            # 极速时钟跳动转发：零缓冲直接推向其他选手
            elif action == "liveTick" and current_room and current_acc_id:
                tick_bytes = encode_ws_frame(text)
                for pid, pl in current_room["players"].items():
                    if pid != current_acc_id:
                        w = pl.get("writer")
                        if w and not w.is_closing():
                            try:
                                w.write(tick_bytes)
                            except Exception:
                                pass
                continue

            # 极速停止计时广播：在选手松手/敲击空格瞬间立即让对手界面定格，彻底消灭1~2秒延迟！
            elif action == "timerStop" and current_room and current_acc_id:
                if current_acc_id in current_room["players"]:
                    current_room["players"][current_acc_id]["status"] = "STOPPED"
                    current_room["players"][current_acc_id]["stoppedTime"] = msg.get("finalMs")
                stop_bytes = encode_ws_frame(json.dumps({
                    "action": "timerStop",
                    "accountId": current_acc_id,
                    "stopAt": msg.get("stopAt", int(time.time() * 1000)),
                    "finalMs": msg.get("finalMs")
                }))
                for pid, pl in current_room["players"].items():
                    if pid != current_acc_id:
                        w = pl.get("writer")
                        if w and not w.is_closing():
                            try:
                                w.write(stop_bytes)
                            except Exception:
                                pass
                continue

            elif action == "joinRoom":
                room_id = str(msg.get("roomId", "100")).strip()
                acc_id = str(msg.get("accountId", "Player")).strip()
                scramble = msg.get("scramble")

                current_room = get_or_create_room(room_id, acc_id, scramble)
                current_acc_id = acc_id

                is_first = (len(current_room["players"]) == 0)
                current_room["players"][acc_id] = {
                    "accountId": acc_id,
                    "elo": 1500,
                    "status": "READY",
                    "isHost": is_first or current_room["players"].get(acc_id, {}).get("isHost", False),
                    "writer": writer
                }
                current_room["multipliers"][acc_id] = current_room["multipliers"].get(acc_id, 1.0)

                if msg_id:
                    ack = encode_ws_frame(json.dumps({"msgid": msg_id, "ret": 0}))
                    writer.write(ack)
                    await writer.drain()
                await broadcast_room(current_room)

            elif action == "updateStatus":
                if current_room and current_acc_id in current_room["players"]:
                    status = msg.get("status", "READY")
                    current_room["players"][current_acc_id]["status"] = status
                    if msg_id:
                        ack = encode_ws_frame(json.dumps({"msgid": msg_id, "ret": 0}))
                        writer.write(ack)
                        await writer.drain()
                    await broadcast_room(current_room)

            elif action == "uploadSolve":
                if current_room and current_acc_id in current_room["players"]:
                    solve_id = msg.get("solveId", current_room["curSolveId"])
                    time_data = msg.get("time")
                    next_scr = msg.get("scramble")

                    raw_time_ms = -1
                    if time_data and len(time_data) > 0 and len(time_data[0]) > 1:
                        raw_time_ms = time_data[0][1]

                    solve_entry = {
                        "accountId": current_acc_id,
                        "solveId": solve_id,
                        "time": time_data,
                        "soltime": (raw_time_ms / 1000.0) if raw_time_ms > 0 else -1
                    }
                    current_room["solves"].append(solve_entry)
                    current_room["players"][current_acc_id]["status"] = "SOLVED"

                    # 计分板小分逻辑
                    sb = current_room["scoreboard"]
                    if sb.get("enabled"):
                        mult = current_room["multipliers"].get(current_acc_id, 1.0)
                        eff_time = raw_time_ms * mult if raw_time_ms > 0 else 9999999
                        # 检查本小局胜者
                        if solve_id not in current_room["scoredSolveIds"]:
                            current_room["scoredSolveIds"][solve_id] = (current_acc_id, eff_time)
                            sb["scores"][current_acc_id] = sb["scores"].get(current_acc_id, 0) + 1
                        else:
                            best_acc, best_eff = current_room["scoredSolveIds"][solve_id]
                            if eff_time < best_eff:
                                sb["scores"][best_acc] = max(0, sb["scores"].get(best_acc, 0) - 1)
                                sb["scores"][current_acc_id] = sb["scores"].get(current_acc_id, 0) + 1
                                current_room["scoredSolveIds"][solve_id] = (current_acc_id, eff_time)

                    # 检查是否全员完成
                    all_solved = True
                    for pid, pdata in current_room["players"].items():
                        if pdata.get("status") != "SOLVED":
                            all_solved = False
                            break

                    if all_solved and len(current_room["players"]) > 1 and current_room.get("autoNext", True):
                        current_room["lastScramble"] = current_room["curScramble"]
                        if next_scr:
                            current_room["curScramble"] = next_scr
                        current_room["curSolveId"] += 1
                        for pid in current_room["players"]:
                            current_room["players"][pid]["status"] = "READY"

                    if msg_id:
                        ack = encode_ws_frame(json.dumps({"msgid": msg_id, "ret": 0}))
                        writer.write(ack)
                        await writer.drain()
                    await broadcast_room(current_room)

            elif action == "setMultiplier":
                if current_room:
                    target = msg.get("targetAccountId")
                    mult = float(msg.get("multiplier", 1.0))
                    if target and mult > 0:
                        current_room["multipliers"][target] = mult
                    if msg_id:
                        ack = encode_ws_frame(json.dumps({"msgid": msg_id, "ret": 0}))
                        writer.write(ack)
                        await writer.drain()
                    await broadcast_room(current_room)

            elif action == "advanceRound":
                if current_room:
                    current_room["lastScramble"] = current_room["curScramble"]
                    next_scr = msg.get("scramble")
                    if next_scr:
                        current_room["curScramble"] = next_scr
                    current_room["curSolveId"] += 1
                    for pid in current_room["players"]:
                        current_room["players"][pid]["status"] = "READY"
                    if msg_id:
                        ack = encode_ws_frame(json.dumps({"msgid": msg_id, "ret": 0}))
                        writer.write(ack)
                        await writer.drain()
                    await broadcast_room(current_room)

            elif action == "setAutoNext":
                if current_room:
                    current_room["autoNext"] = bool(msg.get("autoNext", True))
                    if msg_id:
                        ack = encode_ws_frame(json.dumps({"msgid": msg_id, "ret": 0}))
                        writer.write(ack)
                        await writer.drain()
                    await broadcast_room(current_room)

            elif action == "setScoreboardConfig":
                if current_room:
                    sb = current_room.setdefault("scoreboard", {"enabled": True, "x": 3, "y": 5, "scores": {}, "bigScores": {}, "winner": None})
                    if "enabled" in msg:
                        sb["enabled"] = bool(msg["enabled"])
                    if "x" in msg:
                        sb["x"] = int(msg["x"])
                    if "y" in msg:
                        sb["y"] = int(msg["y"])
                    if msg_id:
                        ack = encode_ws_frame(json.dumps({"msgid": msg_id, "ret": 0}))
                        writer.write(ack)
                        await writer.drain()
                    await broadcast_room(current_room)

            elif action == "resetScoreboard":
                if current_room and "scoreboard" in current_room:
                    sb = current_room["scoreboard"]
                    sb["scores"] = {}
                    sb["bigScores"] = {}
                    sb["winner"] = None
                    if msg_id:
                        ack = encode_ws_frame(json.dumps({"msgid": msg_id, "ret": 0}))
                        writer.write(ack)
                        await writer.drain()
                    await broadcast_room(current_room)

            elif action == "leaveRoom":
                if current_room and current_acc_id:
                    remove_player_from_room(current_room, current_acc_id)
                    await broadcast_room(current_room)
                    current_room = None
                    current_acc_id = None
                if msg_id:
                    ack = encode_ws_frame(json.dumps({"msgid": msg_id, "ret": 0}))
                    writer.write(ack)
                    await writer.drain()

    except Exception as e:
        pass
    finally:
        if current_room and current_acc_id:
            remove_player_from_room(current_room, current_acc_id)
            try:
                await broadcast_room(current_room)
            except Exception:
                pass

# ----------------- 静态文件 HTTP 响应 -----------------
async def handle_http_request(method, path, writer):
    clean_path = path.split("?")[0].split("#")[0]
    if clean_path in ("", "/"):
        clean_path = "/index.html"

    clean_path = clean_path.lstrip("/").replace("/", os.sep)
    base_dir = os.path.dirname(os.path.abspath(__file__))
    file_path = os.path.join(base_dir, clean_path)

    # 安全检查：防止目录穿越
    if not os.path.abspath(file_path).startswith(base_dir) or not os.path.isfile(file_path):
        resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found"
        writer.write(resp.encode("utf-8"))
        await writer.drain()
        return

    content_type, _ = mimetypes.guess_type(file_path)
    if not content_type:
        content_type = "application/octet-stream"
    if content_type.startswith("text/") or content_type in ("application/javascript", "application/json"):
        content_type += "; charset=utf-8"

    file_size = os.path.getsize(file_path)
    header = (
        "HTTP/1.1 200 OK\r\n"
        f"Content-Type: {content_type}\r\n"
        f"Content-Length: {file_size}\r\n"
        "Cache-Control: no-cache, no-store, must-revalidate\r\n"
        "Pragma: no-cache\r\n"
        "Expires: 0\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Connection: close\r\n"
        "\r\n"
    )
    writer.write(header.encode("utf-8"))
    await writer.drain()

    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(64 * 1024)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()

async def main():
    port = 8000
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass

    # 监听 None 将同时绑定 IPv4 (0.0.0.0) 和 IPv6 (::)，兼容 localhost / 127.0.0.1 / ::1
    server = await asyncio.start_server(handle_connection, None, port)
    print("=" * 60)
    print(f"  csTimer 本地内网穿透对战服务已启动！")
    print(f"  本地服务地址: http://127.0.0.1:{port} (支持 IPv4/IPv6)")
    print(f"  WebSocket地址: ws://127.0.0.1:{port}/ws")
    print("=" * 60)
    print("【使用提示】:")
    print(f" 1. 打开您的内网穿透软件，映射本地端口: {port}")
    print(" 2. 将内网穿透分配的公网地址发给朋友即可开打！")
    print("=" * 60)

    async with server:
        await server.serve_forever()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n服务已停止。")
