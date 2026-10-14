"use strict";

var battle = execMain(function() {
	var accountDiv = $('<div>');
	var wcaSpan = $('<span class="click">');
	var uidSpan = $('<span class="click">');
	var headStr = TOOLS_BATTLE_HEAD.split('|');
	var joinRoomSpan = $('<span class="click">').html(headStr[1]);
	var leaveRoomSpan = $('<span class="click">').html('[X]');

	// Current battle mode: 'p2p_host' | 'p2p_client' | 'server'
	var battleMode = 'p2p_host';
	var roomId = null;
	var compId = null;
	var roomInfo = null;
	var localLastSolve = [[-1, 1], null];
	var isInit = false;
	var roomTable;
	var scrResolve = null;
	var lastStatus = 'READY';
	var playerSolvingStart = {}; // accountId -> 本地等效开始时间戳
	var liveTimer = null;        // 实时刷新计时器
	var currentHostToken = null;

	// ==================== General Battle Utilities ====================
	function generate333Scramble() {
		try {
			if (typeof scramble_333 !== 'undefined' && scramble_333.getRandomScramble) {
				return scramble_333.getRandomScramble().trim();
			}
		} catch (e) {}
		return "R U R' U'";
	}

	function formatName(accId) {
		if (!accId) return '匿名';
		if (typeof accId === 'string') {
			if (accId.indexOf('|') !== -1) {
				return accId.split('|')[1];
			}
			if (accId.length > 10) {
				return accId.slice(0, 4) + '...' + accId.slice(accId.length - 3);
			}
		}
		return String(accId);
	}

	// ==================== WebRTC Configuration & Utilities ====================
	// 内置全球免费 TURN 公网中继服务，保证跨网络/手机5G对等穿透 100% 成功
	var DEFAULT_TURN_SERVERS = [
		{
			urls: [
				'turn:openrelay.metered.ca:443?transport=tcp',
				'turn:openrelay.metered.ca:443',
				'turn:openrelay.metered.ca:80',
				'stun:openrelay.metered.ca:80'
			],
			username: 'openrelayproject',
			credential: 'openrelayproject'
		}
	];

	var DEFAULT_STUN_SERVERS = [
		{ urls: 'stun:stun.aliyun.com:3478' },
		{ urls: 'stun:stun.qq.com:1863' },
		{ urls: 'stun:stun.miwifi.com:3478' },
		{ urls: 'stun:stun.chat.bilibili.com:3478' },
		{ urls: 'stun:stun.hitv.com:3478' },
		{ urls: 'stun:stun.cloudflare.com:3478' }
	];

	var CUSTOM_TURN_CONFIG = null;

	function getRtcIceServers() {
		var servers = DEFAULT_STUN_SERVERS.concat(DEFAULT_TURN_SERVERS);
		if (CUSTOM_TURN_CONFIG && CUSTOM_TURN_CONFIG.urls) {
			servers.push(CUSTOM_TURN_CONFIG);
		}
		try {
			var localTurn = localStorage.getItem('cstimer_custom_turn');
			if (localTurn) {
				var parsed = JSON.parse(localTurn);
				if (parsed && parsed.urls) {
					servers.push(parsed);
				}
			}
		} catch (e) {}
		return servers;
	}

	function createPeerConnection() {
		var RTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
		if (!RTCPC) {
			alert('当前浏览器不支持 WebRTC，无法进行 P2P 直连对战！');
			return null;
		}
		return new RTCPC({
			iceServers: getRtcIceServers()
		});
	}

	function waitIceGathering(pc, maxTimeoutMs) {
		maxTimeoutMs = maxTimeoutMs || 4000;
		return new Promise(function(resolve) {
			if (pc.iceGatheringState === 'complete') {
				resolve();
				return;
			}
			var timer = null;
			var candidateCount = 0;
			var hasSrflx = false;
			var hasRelay = false;
			var minWaitTimer = null;

			function done() {
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				if (minWaitTimer) {
					clearTimeout(minWaitTimer);
					minWaitTimer = null;
				}
				pc.removeEventListener('icegatheringstatechange', onStateChange);
				pc.onicecandidate = null;
				resolve();
			}

			function onStateChange() {
				if (pc.iceGatheringState === 'complete') {
					done();
				}
			}

			pc.onicecandidate = function(e) {
				if (!e.candidate) {
					done();
					return;
				}
				candidateCount++;
				var cand = e.candidate.candidate || '';
				if (cand.indexOf('typ relay') !== -1) {
					hasRelay = true;
				} else if (cand.indexOf('typ srflx') !== -1) {
					hasSrflx = true;
				}
				// 收集到中继 (relay) 候选或公网反射候选且达到一定数量后，稍作等待收尾返回
				if ((hasRelay || (hasSrflx && candidateCount >= 3)) && !minWaitTimer) {
					minWaitTimer = setTimeout(done, 600);
				}
			};

			pc.addEventListener('icegatheringstatechange', onStateChange);
			timer = setTimeout(done, maxTimeoutMs);
		});
	}

	function encodeToken(obj) {
		try {
			var str = JSON.stringify(obj);
			return LZString.compressToBase64(str);
		} catch (e) {
			return '';
		}
	}

	function decodeToken(tokenStr) {
		if (!tokenStr) return null;
		tokenStr = tokenStr.trim();
		var hashIdx = tokenStr.indexOf('#');
		if (hashIdx !== -1) {
			var hashPart = tokenStr.substring(hashIdx + 1);
			var eqIdx = hashPart.indexOf('=');
			if (eqIdx !== -1) {
				tokenStr = hashPart.substring(eqIdx + 1);
			} else {
				tokenStr = hashPart;
			}
		}
		tokenStr = tokenStr.replace(/^["'\s]+|["'\s]+$/g, '');
		var decomp = LZString.decompressFromBase64(tokenStr);
		if (!decomp) {
			decomp = tokenStr;
		}
		try {
			return JSON.parse(decomp);
		} catch (e) {
			return null;
		}
	}

	function copyToClipboard(text, msg) {
		msg = msg || '已复制到剪贴板';
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(function() {
				logohint.push(msg);
			}).catch(function() {
				fallbackCopy(text, msg);
			});
		} else {
			fallbackCopy(text, msg);
		}
	}

	function fallbackCopy(text, msg) {
		var ta = $('<textarea>').val(text).css({ position: 'fixed', left: '-9999px', top: '-9999px' }).appendTo('body');
		ta[0].select();
		try {
			document.execCommand('copy');
			logohint.push(msg || '已复制到剪贴板');
		} catch (e) {
			prompt('请手动复制：', text);
		}
		ta.remove();
	}

	// ==================== WebSocket Connection (支持官方服务器与本地/穿透服务) ====================
	var wsConn = (function() {
		var socket;
		var isOpen = false;
		var idseq = 1;
		var waitList = {};
		var TIMEOUT = 5000;
		var callback = null;
		var toResolves = [];
		var activeWsUrl = 'wss://cstimer.net/ws20230409';

		function formatWsUrl(raw) {
			if (!raw) {
				var proto = (location.protocol === 'https:') ? 'wss://' : 'ws://';
				return proto + location.host + '/ws';
			}
			raw = raw.trim();
			if (!/^wss?:\/\//i.test(raw)) {
				// 纯 IP 地址（例如 36.213.26.203:50615）无 SSL 证书，强制使用 ws://
				var isIpAddr = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(:[0-9]+)?(\/.*)?$/i.test(raw);
				var proto = (!isIpAddr && location.protocol === 'https:' && !/^127\.|^localhost/i.test(raw)) ? 'wss://' : 'ws://';
				raw = proto + raw;
			}
			if (!/\/ws$/i.test(raw) && raw.indexOf('/ws20230409') === -1 && raw.indexOf('/', 8) === -1) {
				raw += '/ws';
			}
			return raw;
		}

		function connect(targetUrl) {
			targetUrl = formatWsUrl(targetUrl || activeWsUrl);
			activeWsUrl = targetUrl;
			if (isOpen && socket && socket.url === targetUrl) {
				return Promise.resolve();
			}
			if (socket) {
				try { socket.close(); } catch (e) {}
				isOpen = false;
			}
			return new Promise(function(resolve, reject) {
				var connectTimer = setTimeout(function() {
					reject(new Error('连接超时 (5秒)，请确认本地 start.bat 已重新启动且穿透软件已开启'));
				}, 5000);

				toResolves.push(function() {
					clearTimeout(connectTimer);
					resolve();
				});

				try {
					socket = new WebSocket(targetUrl);
				} catch (e) {
					clearTimeout(connectTimer);
					reject(e);
					return;
				}
				socket.onopen = function() {
					isOpen = true;
					while (toResolves.length > 0) {
						toResolves.pop()();
					}
				};
				socket.onclose = function() {
					isOpen = false;
					callback && callback('close');
				};
				socket.onerror = function(err) {
					clearTimeout(connectTimer);
					isOpen = false;
					reject(new Error('无法连接到 WebSocket 服务器: ' + targetUrl));
					callback && callback('error');
				};
				socket.onmessage = function(e) {
					try {
						var msg = JSON.parse(e.data);
						var msgid = msg['msgid'];
						if (msgid in waitList) {
							var res = waitList[msgid];
							delete waitList[msgid];
							res(msg);
						} else {
							callback && callback('msg', msg);
						}
					} catch (parseErr) {
						console.error('[ws parse error]', parseErr);
					}
				};
			});
		}

		function remoteCall(msg) {
			return new Promise(function(resolve, reject) {
				if (!isOpen) {
					reject(-1);
					return;
				}
				msg['msgid'] = idseq;
				waitList[idseq] = resolve;
				idseq++;
				socket.send(JSON.stringify(msg));
				setTimeout(function(rej) {
					rej(-2);
				}.bind(null, reject), TIMEOUT);
			});
		}

		function pushMsg(msg) {
			if (!isOpen) return -1;
			socket.send(JSON.stringify(msg));
			return 0;
		}

		function close() {
			if (!isOpen) return -1;
			socket.close();
			isOpen = false;
			return 0;
		}

		return {
			connect: connect,
			close: close,
			isConnected: function() { return isOpen; },
			setCallback: function(cb) { callback = cb; },
			pushMsg: pushMsg,
			remoteCall: remoteCall
		};
	})();

	// ==================== P2P Host Room Engine (房主主机状态机) ====================
	var hostEngine = (function() {
		var state = {
			roomId: '',
			curSolveId: 1,
			curScramble: '',
			lastScramble: '',
			players: {},    // accountId -> { accountId, elo, status, isHost, multiplier }
			solves: [],     // [ { accountId, solveId, time, soltime } ]
			clients: [],    // [ { id, pc, dc, accountId } ]
			autoNext: true,
			nextTimer: null,
			multipliers: {}, // accountId -> float (default 1.0)
			scoreboard: {
				enabled: false,
				x: 3,
				y: 5,
				scores: {},    // accountId -> number (当前小局小分)
				bigScores: {}, // accountId -> number (大积分)
				winner: null   // 最终胜者 accountId
			},
			scoredSolveIds: {} // solveId -> winnerAccId
		};

		function init(rId, hostAccId) {
			state.hostAccId = hostAccId;
			if (state.roomId === rId && state.players[hostAccId] && state.clients.length > 0) {
				broadcast();
				return;
			}
			state.roomId = rId;
			state.curSolveId = 1;
			state.curScramble = generate333Scramble();
			state.lastScramble = '';
			state.players = {};
			state.solves = [];
			closeAllClients();
			state.clients = [];
			state.multipliers = {};
			state.multipliers[hostAccId] = 1.0;
			state.scoreboard = {
				enabled: true,
				x: 3,
				y: 5,
				scores: {},
				bigScores: {},
				winner: null
			};
			state.scoredSolveIds = {};
			state.players[hostAccId] = {
				accountId: hostAccId,
				elo: 1500,
				status: 'READY',
				isHost: true,
				multiplier: 1.0
			};
			broadcast();
		}

		function closeAllClients() {
			for (var i = 0; i < state.clients.length; i++) {
				try {
					if (state.clients[i].dc) state.clients[i].dc.close();
					if (state.clients[i].pc) state.clients[i].pc.close();
				} catch (e) {}
			}
			state.clients = [];
		}

		function broadcast() {
			var info = {
				roomId: state.roomId,
				players: [],
				cur: [state.curSolveId, state.curScramble],
				last: [state.curSolveId - 1, state.lastScramble],
				solves: state.solves.slice(),
				multipliers: Object.assign({}, state.multipliers),
				scoreboard: {
					enabled: !!state.scoreboard.enabled,
					x: state.scoreboard.x || 3,
					y: state.scoreboard.y || 5,
					scores: Object.assign({}, state.scoreboard.scores),
					bigScores: Object.assign({}, state.scoreboard.bigScores),
					winner: state.scoreboard.winner
				}
			};
			for (var key in state.players) {
				state.players[key].multiplier = (state.multipliers[key] !== undefined) ? state.multipliers[key] : 1.0;
				info.players.push(state.players[key]);
			}
			for (var i = 0; i < state.clients.length; i++) {
				var cl = state.clients[i];
				if (cl.dc && cl.dc.readyState === 'open') {
					try {
						cl.dc.send(JSON.stringify({ roomInfo: info }));
					} catch (e) {}
				}
			}
			onNotify('msg', { roomInfo: info });
		}

		function handleClientMessage(clientObj, msg) {
			if (!msg || typeof msg !== 'object') return;
			var action = msg['action'];
			var accId = msg['accountId'];

			// 统一分配/纠正重名选手（如两端同在 localhost 共享 localStorage）
			if (!accId || accId === state.hostAccId) {
				accId = (accId || 'Player') + '_选手';
				try {
					clientObj.dc.send(JSON.stringify({ action: 'setAccountId', accountId: accId }));
				} catch (e) {}
			}
			clientObj.accountId = accId;

			// 容错：自动确保此选手在 state.players 中，杜绝因偶发网络时序遗漏登记
			if (!state.players[accId]) {
				state.multipliers[accId] = state.multipliers[accId] || 1.0;
				state.players[accId] = {
					accountId: accId,
					elo: 1500,
					status: 'READY',
					isHost: false,
					multiplier: state.multipliers[accId]
				};
			}

			if (action === 'joinRoom') {
				kernel.hideDialog();
				if (msg.msgid) {
					try {
						clientObj.dc.send(JSON.stringify({ msgid: msg.msgid, ret: 0 }));
					} catch (e) {}
				}
				broadcast();
			} else if (action === 'updateStatus') {
				var alreadySolved = false;
				for (var si = 0; si < state.solves.length; si++) {
					if (state.solves[si].accountId === accId && state.solves[si].solveId === state.curSolveId) {
						alreadySolved = true;
						break;
					}
				}
				if (alreadySolved) {
					state.players[accId].status = 'SOLVED';
				} else {
					state.players[accId].status = msg.status;
					if (msg.status === 'SOLVING') {
						state.players[accId].startAt = (msg.startAt !== undefined) ? msg.startAt : Date.now();
					} else {
						delete state.players[accId].startAt;
					}
				}
				if (msg.msgid) {
					try {
						clientObj.dc.send(JSON.stringify({ msgid: msg.msgid, ret: 0 }));
					} catch (e) {}
				}
				broadcast();
			} else if (action === 'uploadSolve') {
				state.players[accId].status = 'SOLVED';
				var alreadyHasSolve = false;
				for (var si = 0; si < state.solves.length; si++) {
					if (state.solves[si].accountId === accId && state.solves[si].solveId === msg.solveId) {
						alreadyHasSolve = true;
						break;
					}
				}
				if (!alreadyHasSolve && msg.time && msg.time[0]) {
					var rawMs = msg.time[0][1];
					var penalty = (msg.time[0][0] == -1) ? 0 : (msg.time[0][0] || 0);
					var soltime = rawMs + penalty;
					state.solves.push({
						accountId: accId,
						solveId: msg.solveId,
						time: msg.time,
						soltime: soltime
					});
				}
				if (msg.msgid) {
					try {
						clientObj.dc.send(JSON.stringify({ msgid: msg.msgid, ret: 0 }));
					} catch (e) {}
				}
				broadcast();
				checkAutoAdvance();
			} else if (action === 'getRoomInfo') {
				broadcast();
			} else if (action === 'leaveRoom') {
				if (state.players[accId]) {
					state.players[accId].status = 'LOSS';
				}
				if (msg.msgid) {
					clientObj.dc.send(JSON.stringify({ msgid: msg.msgid, ret: 0 }));
				}
				broadcast();
			} else if (action === 'liveTick') {
				if (arena && arena.onLiveTick) {
					arena.onLiveTick(accId, msg.curTime);
				}
				var tickStr = JSON.stringify(msg);
				for (var ci = 0; ci < state.clients.length; ci++) {
					var otherCl = state.clients[ci];
					if (otherCl !== clientObj && otherCl.dc && otherCl.dc.readyState === 'open') {
						try { otherCl.dc.send(tickStr); } catch (e) {}
					}
				}
			} else if (action === 'heartBeat') {
				if (msg.msgid) {
					clientObj.dc.send(JSON.stringify({ msgid: msg.msgid, ret: 0 }));
				}
			}
		}

		function handleClientDisconnect(clientObj) {
			if (clientObj.accountId && state.players[clientObj.accountId]) {
				state.players[clientObj.accountId].status = 'LOSS';
				broadcast();
			}
		}

		function hostUpdateStatus(accId, status, startAt) {
			if (state.players[accId]) {
				var alreadySolvedHost = false;
				for (var si = 0; si < state.solves.length; si++) {
					if (state.solves[si].accountId === accId && state.solves[si].solveId === state.curSolveId) {
						alreadySolvedHost = true;
						break;
					}
				}
				if (alreadySolvedHost) {
					state.players[accId].status = 'SOLVED';
				} else {
					state.players[accId].status = status;
					if (status === 'SOLVING') {
						state.players[accId].startAt = (startAt !== undefined) ? startAt : Date.now();
					} else {
						delete state.players[accId].startAt;
					}
				}
				broadcast();
				if (accId === state.hostAccId) {
					startBotIfPresent(status);
				}
			}
		}

		function hostUploadSolve(accId, solveId, time) {
			if (state.players[accId]) {
				state.players[accId].status = 'SOLVED';
				var soltime = time[0][1];
				state.solves.push({
					accountId: accId,
					solveId: solveId,
					time: time,
					soltime: soltime
				});
				broadcast();
				checkAutoAdvance();
			}
		}

		function processRoundScore(solveId) {
			if (!state.scoreboard || !state.scoreboard.enabled) return;
			if (state.scoredSolveIds[solveId]) return;
			if (state.scoreboard.winner) return;

			var bestEffMs = Infinity;
			var bestAccId = null;

			for (var i = 0; i < state.solves.length; i++) {
				var s = state.solves[i];
				if (s.solveId === solveId) {
					var acc = s.accountId;
					var rawMs = null;
					if (s.time && s.time[0]) {
						if (s.time[0][0] === -1) {
							rawMs = -1; // DNF
						} else {
							rawMs = (s.time[0][1] || 0) + (s.time[0][0] || 0);
						}
					}
					if (rawMs !== null && rawMs > 0) {
						var mult = (state.multipliers[acc] !== undefined) ? state.multipliers[acc] : 1.0;
						var effMs = Math.round(rawMs * mult);
						if (effMs < bestEffMs) {
							bestEffMs = effMs;
							bestAccId = acc;
						}
					}
				}
			}

			if (!bestAccId || bestEffMs === Infinity) {
				state.scoredSolveIds[solveId] = 'NONE';
				return;
			}

			state.scoredSolveIds[solveId] = bestAccId;
			state.scoreboard.scores[bestAccId] = (state.scoreboard.scores[bestAccId] || 0) + 1;

			var curSmall = state.scoreboard.scores[bestAccId];
			var targetX = state.scoreboard.x || 3;
			var targetY = state.scoreboard.y || 5;
			var winnerName = formatName(bestAccId);

			if (curSmall >= targetX) {
				// 达到 x 分，赢得本局胜利，积一大积分
				state.scoreboard.bigScores[bestAccId] = (state.scoreboard.bigScores[bestAccId] || 0) + 1;
				var curBig = state.scoreboard.bigScores[bestAccId];

				// 重置本局小积分
				for (var p in state.players) {
					state.scoreboard.scores[p] = 0;
				}

				if (curBig >= targetY) {
					// 大积分最先到 y 分者获得最终胜利
					state.scoreboard.winner = bestAccId;
					logohint.push('👑 最终胜利！恭喜 ' + winnerName + ' 率先达到 ' + targetY + ' 大分，夺得全场最终胜利！');
				} else {
					logohint.push('🏆 本局胜利！恭喜 ' + winnerName + ' 率先达到 ' + targetX + ' 分，赢得本局（大积分 +1）！');
				}
			} else {
				logohint.push('⭐ ' + winnerName + ' 本轮最快，小积分 +1 (' + curSmall + '/' + targetX + ')');
			}

			broadcast();
		}

		function setScoreboardConfig(enabled, x, y) {
			state.scoreboard.enabled = !!enabled;
			if (typeof x === 'number' && x > 0) state.scoreboard.x = x;
			if (typeof y === 'number' && y > 0) state.scoreboard.y = y;
			broadcast();
		}

		function resetScoreboard() {
			state.scoreboard.scores = {};
			state.scoreboard.bigScores = {};
			state.scoreboard.winner = null;
			state.scoredSolveIds = {};
			broadcast();
			logohint.push('比分已重置');
		}

		function checkAutoAdvance() {
			var curId = state.curSolveId;
			var allSolved = true;
			var count = 0;
			for (var key in state.players) {
				count++;
				var p = state.players[key];
				if (p.status === 'LOSS') {
					continue;
				}
				var hasSolve = false;
				for (var si = 0; si < state.solves.length; si++) {
					if (state.solves[si].accountId === key && state.solves[si].solveId === curId) {
						hasSolve = true;
						break;
					}
				}
				if (!hasSolve && p.status !== 'SOLVED') {
					allSolved = false;
					break;
				}
			}
			if (allSolved && count > 0) {
				processRoundScore(state.curSolveId);
				if (!state.autoNext) return;
				if (state.nextTimer) clearTimeout(state.nextTimer);
				state.nextTimer = setTimeout(function() {
					advanceRound();
				}, 1200);
			}
		}

		function timeSort(a, b) {
			var ta = a[0] == -1 ? -1 : a[0] + a[1];
			var tb = b[0] == -1 ? -1 : b[0] + b[1];
			if (ta == tb) return 0;
			if (ta == -1 || tb == -1) return ta == -1 ? 1 : -1;
			return ta > tb ? 1 : -1;
		}

		function updateScore() {
			var lastSolveId = state.curSolveId;
			var playerTimes = [];
			for (var i = 0; i < state.solves.length; i++) {
				var sObj = state.solves[i];
				if (sObj['solveId'] === lastSolveId) {
					playerTimes.push([sObj['accountId'], sObj['time'][0]]);
				}
			}
			if (playerTimes.length < 2) return;
			playerTimes.sort(function(a, b) {
				return timeSort(a[1], b[1]);
			});
			for (var i = 0; i < playerTimes.length; i++) {
				var selfAcc = playerTimes[i][0];
				var selfObj = state.players[selfAcc];
				if (!selfObj) continue;
				var selfTime = playerTimes[i][1];
				var eloChange = 0;
				for (var j = 0; j < playerTimes.length; j++) {
					if (i === j) continue;
					var otherAcc = playerTimes[j][0];
					var otherObj = state.players[otherAcc];
					if (!otherObj) continue;
					var otherTime = playerTimes[j][1];
					var s = (timeSort(otherTime, selfTime) + 1) / 2;
					var ea = 1 / (1 + Math.pow(10, ((otherObj.elo || 1500) - (selfObj.elo || 1500)) / 400));
					eloChange += Math.round((s - ea) * 32 / (playerTimes.length - 1));
				}
				selfObj.elo = Math.max(100, (selfObj.elo || 1500) + eloChange);
			}
		}

		function advanceRound() {
			if (state.nextTimer) {
				clearTimeout(state.nextTimer);
				state.nextTimer = null;
			}
			try {
				processRoundScore(state.curSolveId);
			} catch (e) {
				console.error('Scoreboard score error:', e);
			}
			try {
				updateScore();
			} catch (e) {
				console.error('Elo update error:', e);
			}
			state.curSolveId++;
			state.lastScramble = state.curScramble;
			state.curScramble = generate333Scramble();
			for (var key in state.players) {
				if (state.players[key].status !== 'LOSS') {
					state.players[key].status = 'READY';
				}
			}
			broadcast();
		}

		var botTimer = null;
		var botSolveTimer = null;

		function startBotIfPresent(status) {
			var botPlayer = state.players['CubingBot_高手'];
			if (!botPlayer) return;
			if (status === 'SOLVING') {
				if (botTimer) clearTimeout(botTimer);
				botTimer = setTimeout(function() {
					botPlayer.status = 'SOLVING';
					botPlayer.startAt = Date.now();
					broadcast();
					var targetTime = (9.5 + Math.random() * 4.5) * 1000;
					var startT = Date.now();
					if (botSolveTimer) clearInterval(botSolveTimer);
					botSolveTimer = setInterval(function() {
						var cur = Date.now() - startT;
						if (arena && arena.onLiveTick) {
							arena.onLiveTick('CubingBot_高手', cur);
						}
						if (cur >= targetTime) {
							clearInterval(botSolveTimer);
							botSolveTimer = null;
							botPlayer.status = 'SOLVED';
							var solveTime = Math.round(targetTime);
							state.solves.push({
								accountId: 'CubingBot_高手',
								solveId: state.curSolveId,
								time: [[0, solveTime], null, null, null],
								soltime: solveTime
							});
							broadcast();
							checkAutoAdvance();
						}
					}, 50);
				}, 350);
			} else if (status === 'INSPECT') {
				botPlayer.status = 'INSPECT';
				broadcast();
			} else if (status === 'READY') {
				if (botSolveTimer) {
					clearInterval(botSolveTimer);
					botSolveTimer = null;
				}
				if (botTimer) {
					clearTimeout(botTimer);
					botTimer = null;
				}
				botPlayer.status = 'READY';
				broadcast();
			}
		}

		function addBotPlayer() {
			var botId = 'CubingBot_高手';
			state.multipliers[botId] = state.multipliers[botId] || 1.0;
			state.players[botId] = {
				accountId: botId,
				elo: 1620,
				status: 'READY',
				isHost: false,
				isBot: true,
				multiplier: state.multipliers[botId]
			};
			broadcast();
		}

		function removeBotPlayer() {
			var botId = 'CubingBot_高手';
			if (botSolveTimer) {
				clearInterval(botSolveTimer);
				botSolveTimer = null;
			}
			if (botTimer) {
				clearTimeout(botTimer);
				botTimer = null;
			}
			delete state.players[botId];
			delete state.multipliers[botId];
			broadcast();
		}

		function setMultiplier(accId, mult) {
			mult = Math.round(parseFloat(mult) * 10) / 10;
			if (isNaN(mult) || mult <= 0) mult = 1.0;
			state.multipliers[accId] = mult;
			if (state.players[accId]) {
				state.players[accId].multiplier = mult;
			}
			broadcast();
		}

		function broadcastMsg(msg) {
			var str = JSON.stringify(msg);
			for (var i = 0; i < state.clients.length; i++) {
				var cl = state.clients[i];
				if (cl.dc && cl.dc.readyState === 'open') {
					try { cl.dc.send(str); } catch (e) {}
				}
			}
		}

		function addClient(clientObj) {
			state.clients.push(clientObj);
		}

		return {
			init: init,
			advanceRound: advanceRound,
			hostUpdateStatus: hostUpdateStatus,
			hostUploadSolve: hostUploadSolve,
			handleClientMessage: handleClientMessage,
			handleClientDisconnect: handleClientDisconnect,
			addClient: addClient,
			closeAll: closeAllClients,
			broadcastMsg: broadcastMsg,
			addBotPlayer: addBotPlayer,
			removeBotPlayer: removeBotPlayer,
			setMultiplier: setMultiplier,
			setAutoNext: function(val) { state.autoNext = !!val; },
			getAutoNext: function() { return state.autoNext; },
			getClientsCount: function() { return state.clients.length; },
			setScoreboardConfig: setScoreboardConfig,
			resetScoreboard: resetScoreboard,
			getScoreboard: function() { return state.scoreboard; }
		};
	})();

	// ==================== P2P Client Connection (客户机通信) ====================
	var clientConn = (function() {
		var pc = null;
		var dc = null;
		var isOpen = false;
		var idseq = 1;
		var waitList = {};
		var TIMEOUT = 5000;
		var callback = null;

		function setup(pConn, dChan) {
			pc = pConn;
			dc = dChan;

			function handleOpen() {
				if (isOpen) return;
				isOpen = true;
				logohint.push('P2P直连已打通！');
				kernel.hideDialog();
				connReady();
			}

			dc.onclose = function() {
				isOpen = false;
				callback && callback('close');
			};
			dc.onerror = function(err) {
				console.error('[client dc error]', err);
				isOpen = false;
				callback && callback('error');
			};
			dc.onmessage = function(e) {
				try {
					var msg = JSON.parse(e.data);
					if (msg['action'] === 'setAccountId') {
						compId = msg['accountId'];
						pushMsg({
							'action': 'joinRoom',
							'roomId': roomId,
							'accountId': compId,
							'scramble': generate333Scramble()
						});
						return;
					}
					var msgid = msg['msgid'];
					if (msgid in waitList) {
						var res = waitList[msgid];
						delete waitList[msgid];
						res(msg);
					} else {
						callback && callback('msg', msg);
					}
				} catch (err) {
					console.error('[client dc onmessage parse error]', err);
				}
			};

			if (dc.readyState === 'open') {
				setTimeout(handleOpen, 0);
			} else {
				dc.onopen = handleOpen;
			}
		}

		function connReady() {
			kernel.hideDialog();
			var joinMsg = {
				'action': 'joinRoom',
				'roomId': roomId,
				'accountId': compId,
				'scramble': generate333Scramble()
			};
			pushMsg(joinMsg);
			remoteCall(joinMsg).then(function(ret) {
				DEBUG && console.log('[battle client] joinRoom ret=', ret);
				kernel.hideDialog();
			}).catch(function(err) {
				console.warn('[battle client] joinRoom ack timeout, sending pushMsg fallback:', err);
				pushMsg(joinMsg);
				kernel.hideDialog();
			});
		}

		function remoteCall(msg) {
			return new Promise(function(resolve, reject) {
				if (!dc || dc.readyState !== 'open') {
					reject(-1);
					return;
				}
				msg['msgid'] = idseq;
				waitList[idseq] = resolve;
				idseq++;
				try {
					dc.send(JSON.stringify(msg));
				} catch (err) {
					reject(err);
					return;
				}
				setTimeout(function(rej) {
					rej(-2);
				}.bind(null, reject), TIMEOUT);
			});
		}

		function pushMsg(msg) {
			if (!dc) return -1;
			try {
				if (dc.readyState === 'open') {
					dc.send(JSON.stringify(msg));
					return 0;
				}
			} catch (e) {
				console.error('[pushMsg error]', e);
			}
			return -1;
		}

		function close() {
			if (dc) {
				try { dc.close(); } catch (e) {}
			}
			if (pc) {
				try { pc.close(); } catch (e) {}
			}
			isOpen = false;
			dc = null;
			pc = null;
		}

		return {
			setup: setup,
			close: close,
			isConnected: function() { return isOpen; },
			setCallback: function(cb) { callback = cb; },
			pushMsg: pushMsg,
			remoteCall: remoteCall
		};
	})();

	// ==================== Combined Connection Interface ====================
	var conn = {
		connect: function() {
			if (battleMode === 'server') return wsConn.connect();
			return Promise.resolve();
		},
		close: function() {
			if (battleMode === 'server') return wsConn.close();
			if (battleMode === 'p2p_host') {
				hostEngine.closeAll();
				return 0;
			}
			return clientConn.close();
		},
		isConnected: function() {
			if (battleMode === 'server') return wsConn.isConnected();
			if (battleMode === 'p2p_host') return !!roomInfo;
			return clientConn.isConnected();
		},
		pushMsg: function(msg) {
			if (battleMode === 'server') return wsConn.pushMsg(msg);
			if (battleMode === 'p2p_host') return 0;
			return clientConn.pushMsg(msg);
		},
		remoteCall: function(msg) {
			if (battleMode === 'server') return wsConn.remoteCall(msg);
			if (battleMode === 'p2p_host') return Promise.resolve({ ret: 0 });
			return clientConn.remoteCall(msg);
		}
	};

	wsConn.setCallback(onNotify);
	clientConn.setCallback(onNotify);

	// ==================== Handshake Modals (握手界面) ====================

	// 可选的 TURN 中继设置面板组件
	function createTurnConfigSection() {
		var sec = $('<div style="margin-top: 15px; border-top: 1px dashed #bbb; padding-top: 8px; font-size: 0.8em; color: #666;"></div>');
		var toggleBtn = $('<a href="javascript:void(0)" style="color: #666; text-decoration: underline; cursor: pointer;">⚙️ 高级网络设置 (TURN中继)</a>');
		var content = $('<div style="display: none; margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.03); border: 1px solid #ddd; border-radius: 4px;"></div>');

		var savedTurn = null;
		try { savedTurn = JSON.parse(localStorage.getItem('cstimer_custom_turn') || 'null'); } catch(e) {}

		var urlInput = $('<input type="text" placeholder="TURN地址，例: turn:cstimer.etfox.com.cn:3478" style="width: 100%; box-sizing: border-box; margin-bottom: 4px; font-size: 0.85em;">');
		var userInput = $('<input type="text" placeholder="用户名 (选填)" style="width: 48%; box-sizing: border-box; margin-right: 4%; font-size: 0.85em;">');
		var pwdInput = $('<input type="password" placeholder="密码 (选填)" style="width: 48%; box-sizing: border-box; font-size: 0.85em;">');
		var saveBtn = $('<input type="button" value="保存中继配置" style="margin-top: 6px; font-size: 0.8em;">');
		var clearBtn = $('<input type="button" value="清空配置" style="margin-top: 6px; margin-left: 6px; font-size: 0.8em;">');
		var tip = $('<span style="margin-left: 8px; font-size: 0.8em;"></span>');

		if (savedTurn && savedTurn.urls) {
			urlInput.val(savedTurn.urls);
			userInput.val(savedTurn.username || '');
			pwdInput.val(savedTurn.credential || '');
		}

		toggleBtn.click(function() {
			content.toggle();
		});

		saveBtn.click(function() {
			var u = urlInput.val().trim();
			if (!u) {
				localStorage.removeItem('cstimer_custom_turn');
				tip.css('color', '#888').text('已清空中继，使用默认STUN打洞').show().fadeOut(3000);
				return;
			}
			var cfg = { urls: u };
			var user = userInput.val().trim();
			var pwd = pwdInput.val().trim();
			if (user) cfg.username = user;
			if (pwd) cfg.credential = pwd;
			localStorage.setItem('cstimer_custom_turn', JSON.stringify(cfg));
			tip.css('color', 'green').text('中继配置已保存生效！').show().fadeOut(3000);
		});

		clearBtn.click(function() {
			urlInput.val('');
			userInput.val('');
			pwdInput.val('');
			localStorage.removeItem('cstimer_custom_turn');
			tip.css('color', '#888').text('已恢复默认设置').show().fadeOut(2000);
		});

		content.append(
			'<div style="margin-bottom: 4px; color: #555;">如在公网因双方对称 NAT 导致直连超时，可填入 TURN 中继服务器（选填）：</div>',
			urlInput,
			$('<div></div>').append(userInput, pwdInput),
			$('<div></div>').append(saveBtn, clearBtn, tip)
		);
		sec.append(toggleBtn, content);
		return sec;
	}

	// 1. Host Room Modal (创建主机房间)
	function showHostModal() {
		checkConnState(false);
		var defRoomId = roomId || ('' + (100 + ~~(Math.random() * 900)));
		var modalDiv = $('<div style="text-align: left; padding: 12px; width: 100%; height: 100%; box-sizing: border-box; overflow-y: auto; font-size: 0.9em;"></div>');

		var row1 = $('<div style="margin-bottom: 10px;"><b>房间号: </b></div>');
		var rInput = $('<input type="text" style="width: 100px; margin-left: 5px;">').val(defRoomId);
		var btnGen = $('<input type="button" class="buttonOK" value="生成邀请码" style="margin-left: 10px;">');
		row1.append(rInput, btnGen);

		var offerArea = $('<textarea readonly style="width: 100%; height: 75px; margin: 6px 0; font-size: 0.8em; word-break: break-all; box-sizing: border-box;"></textarea>').click(function() { this.select(); });
		var btnCopyOffer = $('<input type="button" value="复制邀请码" style="margin-right: 8px;">');
		var btnCopyLink = $('<input type="button" value="复制对战链接">');
		var qrCanvas = $('<canvas style="display: block; margin: 10px auto; background: #fff; padding: 6px; border: 1px solid #ccc;"></canvas>').hide();

		var answerSec = $('<div style="margin-top: 15px; border-top: 1px dashed #888; padding-top: 10px;"></div>');
		answerSec.append('<div><b>步骤 2：接纳选手</b>（在下方粘贴选手发来的确认码）：</div>');
		var answerInput = $('<textarea placeholder="在此粘贴选手的确认码..." style="width: 100%; height: 60px; margin: 6px 0; font-size: 0.8em; box-sizing: border-box;"></textarea>');
		var btnAccept = $('<input type="button" class="buttonOK" value="接纳选手加入 (连接)" style="font-weight: bold; width: 100%; height: 32px; margin-top: 4px;">');
		var acceptStatusTip = $('<div style="margin-top: 6px; font-size: 0.85em; min-height: 20px; line-height: 1.4;"></div>');
		answerSec.append(answerInput, btnAccept, acceptStatusTip);

		modalDiv.append(
			'<div style="color: #4a90e2; font-weight: bold; margin-bottom: 8px;">👑 房主主机模式 (设备对设备直连)</div>',
			row1,
			'<div><b>步骤 1：复制邀请码或链接发给对手</b></div>',
			offerArea,
			$('<div></div>').append(btnCopyOffer, btnCopyLink),
			qrCanvas,
			answerSec,
			createTurnConfigSection()
		);

		var currentHostPC = null;
		var currentHostDC = null;
		var hostConnectTimer = null;

		function clearHostConnectTimer() {
			if (hostConnectTimer) {
				clearTimeout(hostConnectTimer);
				hostConnectTimer = null;
			}
		}

		function generateHostOffer() {
			try {
				var rId = rInput.val().trim();
				if (!/^[0-9a-zA-Z]{2,20}$/.exec(rId)) {
					alert('房间号格式不正确 (2-20位英文字母或数字)');
					return;
				}
				roomId = rId;
				battleMode = 'p2p_host';
				compId = getMyAccountId();
				hostEngine.init(roomId, compId);

				clearHostConnectTimer();
				if (currentHostPC) {
					try { currentHostPC.close(); } catch(e) {}
					currentHostPC = null;
				}

				var pc = createPeerConnection();
				if (!pc) {
					offerArea.val('创建失败：当前浏览器不支持 WebRTC');
					return;
				}
				currentHostPC = pc;
				var dc = pc.createDataChannel('cstimer_battle', { ordered: true });
				currentHostDC = dc;

				offerArea.val('正在探测并获取公网连接信息，请稍候...');
				btnGen.val('正在生成...');
				var clientObj = { pc: pc, dc: dc, accountId: null };

				function handleHostDCOpen() {
					clearHostConnectTimer();
					logohint.push('选手已成功接入！');
					kernel.hideDialog();
					hostEngine.broadcast();
				}
				dc.onopen = handleHostDCOpen;
				dc.onmessage = function(e) {
					try {
						var msg = JSON.parse(e.data);
						hostEngine.handleClientMessage(clientObj, msg);
					} catch (err) {
						console.error('[Host dc msg error]', err);
					}
				};
				dc.onclose = function() {
					hostEngine.handleClientDisconnect(clientObj);
				};

				pc.ondatachannel = function(e) {
					var inDc = e.channel;
					clientObj.dc = inDc;
					inDc.onopen = handleHostDCOpen;
					inDc.onmessage = dc.onmessage;
					inDc.onclose = dc.onclose;
				};

				hostEngine.addClient(clientObj);

				pc.createOffer().then(function(offer) {
					return pc.setLocalDescription(offer);
				}).then(function() {
					return waitIceGathering(pc, 3500);
				}).then(function() {
					var token = encodeToken({
						type: 'offer',
						sdp: pc.localDescription.sdp,
						roomId: roomId
					});
					currentHostToken = token;
					offerArea.val(token);
					btnGen.val('生成邀请码');
					var shareUrl = location.protocol + '//' + location.host + location.pathname + '#battleOffer=' + token;

					btnCopyOffer.unbind('click').click(function() {
						copyToClipboard(token, '邀请码已复制！');
						btnCopyOffer.val('✓ 已复制');
						setTimeout(function() { btnCopyOffer.val('复制邀请码'); }, 2000);
					});
					btnCopyLink.unbind('click').click(function() {
						copyToClipboard(shareUrl, '对战链接已复制！');
						btnCopyLink.val('✓ 已复制链接');
						setTimeout(function() { btnCopyLink.val('复制对战链接'); }, 2000);
					});

					if (window.QRCode && qrCanvas[0]) {
						try {
							QRCode.draw(qrCanvas[0], shareUrl, 160);
							qrCanvas.show();
						} catch (e) {
							qrCanvas.hide();
						}
					}
				}).catch(function(err) {
					offerArea.val('生成失败: ' + err);
					btnGen.val('生成邀请码');
				});
			} catch (err) {
				console.error('[Host generate error]', err);
				offerArea.val('生成异常: ' + err);
				btnGen.val('生成邀请码');
			}
		}

		btnGen.click(generateHostOffer);

		btnAccept.click(function() {
			if (!currentHostPC) {
				alert('请先生成邀请码！');
				return;
			}
			// 1. 拦截重复点击与状态冲突，防止出现 Called in wrong state: stable 报错
			if (currentHostPC.signalingState === 'stable') {
				acceptStatusTip.html('<span style="color: #f80; font-weight: bold;">⚠️ 已提交接纳，通道正在打洞探测中，请耐心稍候...</span>');
				return;
			}

			var ansToken = answerInput.val().trim();
			var ansObj = decodeToken(ansToken);
			if (!ansObj || ansObj.type !== 'answer') {
				alert('确认码无效，请确保选手已正确生成并发送确认码！');
				return;
			}

			// 2. 状态提示与按钮禁用
			btnAccept.prop('disabled', true).val('⏳ 正在打通通道，请稍候...');
			acceptStatusTip.html('<span style="color: #0288d1; font-weight: bold;">已收到确认码，正在向选手发起网络握手...</span>');

			function updateHostIceState() {
				if (!currentHostPC) return;
				var state = currentHostPC.iceConnectionState || currentHostPC.connectionState;
				if (state === 'checking') {
					acceptStatusTip.html('<span style="color: #0288d1; font-weight: bold;">🌐 正在进行公网穿透探测 (ICE Checking)...</span>');
				} else if (state === 'connected' || state === 'completed') {
					acceptStatusTip.html('<span style="color: #2e7d32; font-weight: bold;">✅ 通道打通成功！正在同步数据进入房间...</span>');
				} else if (state === 'failed' || state === 'disconnected') {
					clearHostConnectTimer();
					acceptStatusTip.html('<span style="color: #d32f2f; font-weight: bold;">❌ 公网穿透失败：受到网络防火墙或对称 NAT 拦截。<br>建议双方连接同一 Wi-Fi 或开启手机热点重试。</span>');
					btnAccept.prop('disabled', false).val('重新接纳加入');
				}
			}

			currentHostPC.oniceconnectionstatechange = updateHostIceState;
			if ('onconnectionstatechange' in currentHostPC) {
				currentHostPC.onconnectionstatechange = updateHostIceState;
			}

			clearHostConnectTimer();
			hostConnectTimer = setTimeout(function() {
				if (currentHostDC && currentHostDC.readyState !== 'open') {
					var curState = currentHostPC ? currentHostPC.iceConnectionState : '';
					if (curState === 'checking' || curState === 'new') {
						acceptStatusTip.html('<span style="color: #d32f2f; font-weight: bold;">⚠️ 穿透超时：公网未能成功连通，可能是受到对称型 NAT 或端口防火墙隔离。</span>');
						btnAccept.prop('disabled', false).val('重试接纳选手');
					}
				}
			}, 15000);

			currentHostPC.setRemoteDescription(new RTCSessionDescription({
				type: 'answer',
				sdp: ansObj.sdp
			})).then(function() {
				logohint.push('已提交确认，正在打通直连通道...');
				updateHostIceState();
				if (currentHostDC && currentHostDC.readyState === 'open') {
					clearHostConnectTimer();
					logohint.push('选手已成功接入！');
					kernel.hideDialog();
				}
			}).catch(function(err) {
				clearHostConnectTimer();
				acceptStatusTip.html('<span style="color: #d32f2f; font-weight: bold;">连接建立失败: ' + err + '</span>');
				btnAccept.prop('disabled', false).val('接纳选手加入 (连接)');
			});
		});

		function applyHostDialogLayout() {
			$('.dialog').css({
				'left': '15%',
				'right': '15%',
				'top': '10%',
				'bottom': '10%',
				'min-height': '380px',
				'min-width': '300px'
			});
		}

		function onCancelHostModal() {
			clearHostConnectTimer();
			if (currentHostPC) {
				try { currentHostPC.close(); } catch (e) {}
				currentHostPC = null;
			}
			if (hostEngine.getClientsCount() === 0) {
				leaveRoom(true);
			}
		}

		kernel.showDialog([modalDiv, null, onCancelHostModal, onCancelHostModal], 'battleHost', '创建对战房间 (房主主机)', applyHostDialogLayout);
		applyHostDialogLayout();

		// Auto generate on open
		setTimeout(generateHostOffer, 100);
	}

	// 2. Client Room Modal (客户机加入房间)
	function showClientModal(prefilledOffer) {
		checkConnState(false);
		var modalDiv = $('<div style="text-align: left; padding: 12px; width: 100%; height: 100%; box-sizing: border-box; overflow-y: auto; font-size: 0.9em;"></div>');

		var offerInput = $('<textarea placeholder="在此粘贴房主的邀请码或对战链接..." style="width: 100%; height: 70px; margin: 6px 0; font-size: 0.8em; box-sizing: border-box;"></textarea>');
		if (prefilledOffer) {
			offerInput.val(prefilledOffer);
		}
		var btnGenAnswer = $('<input type="button" class="buttonOK" value="生成确认码" style="margin-bottom: 10px;">');

		var answerSec = $('<div style="margin-top: 10px; border-top: 1px dashed #888; padding-top: 10px;"></div>').hide();
		answerSec.append('<div><b>步骤 2：将生成的确认码复制发送给房主</b></div>');
		var answerArea = $('<textarea readonly style="width: 100%; height: 75px; margin: 6px 0; font-size: 0.8em; word-break: break-all; box-sizing: border-box;"></textarea>').click(function() { this.select(); });
		var btnCopyAnswer = $('<input type="button" value="复制确认码">');
		var qrCanvas = $('<canvas style="display: block; margin: 10px auto; background: #fff; padding: 6px; border: 1px solid #ccc;"></canvas>').hide();
		var tipWait = $('<div style="color: #f80; margin-top: 6px; font-size: 0.85em; line-height: 1.4;">等待房主在主机端点击【接纳】后即可秒连对战...</div>');
		answerSec.append(answerArea, btnCopyAnswer, qrCanvas, tipWait);

		modalDiv.append(
			'<div style="color: #2e7d32; font-weight: bold; margin-bottom: 8px;">🎮 选手加入模式 (直连房主)</div>',
			'<div><b>步骤 1：粘贴房主的邀请码</b></div>',
			offerInput,
			btnGenAnswer,
			answerSec,
			createTurnConfigSection()
		);

		var currentClientPC = null;

		function generateClientAnswer() {
			try {
				var offerToken = offerInput.val().trim();
				var offerObj = decodeToken(offerToken);
				if (!offerObj || offerObj.type !== 'offer') {
					alert('邀请码无效，请检查是否完整复制了房主的邀请码或链接！');
					return;
				}
				roomId = offerObj.roomId || 'BattleRoom';
				battleMode = 'p2p_client';
				compId = getMyAccountId();

				clientConn.close();
				if (currentClientPC) {
					try { currentClientPC.close(); } catch (e) {}
					currentClientPC = null;
				}

				var pc = createPeerConnection();
				if (!pc) {
					alert('当前浏览器不支持 WebRTC');
					return;
				}
				currentClientPC = pc;

				function updateClientIceState() {
					if (!currentClientPC) return;
					var state = currentClientPC.iceConnectionState || currentClientPC.connectionState;
					if (state === 'checking') {
						tipWait.html('<span style="color: #0288d1; font-weight: bold;">🌐 房主已提交接纳，正在打通公网通道 (ICE Checking)...</span>');
					} else if (state === 'connected' || state === 'completed') {
						tipWait.html('<span style="color: #2e7d32; font-weight: bold;">✅ 通道建立成功！正在同步进入房间...</span>');
					} else if (state === 'failed' || state === 'disconnected') {
						tipWait.html('<span style="color: #d32f2f; font-weight: bold;">❌ 公网穿透失败：受到网络防火墙或对称 NAT 拦截。建议双方连同一 Wi-Fi 或开启手机热点重试。</span>');
					}
				}

				currentClientPC.oniceconnectionstatechange = updateClientIceState;
				if ('onconnectionstatechange' in currentClientPC) {
					currentClientPC.onconnectionstatechange = updateClientIceState;
				}

				pc.ondatachannel = function(e) {
					var receivedDC = e.channel;
					clientConn.setup(pc, receivedDC);
				};

				btnGenAnswer.val('正在获取公网连接信息...');
				pc.setRemoteDescription(new RTCSessionDescription({
					type: 'offer',
					sdp: offerObj.sdp
				})).then(function() {
					return pc.createAnswer();
				}).then(function(answer) {
					return pc.setLocalDescription(answer);
				}).then(function() {
					return waitIceGathering(pc, 3500);
				}).then(function() {
					var token = encodeToken({
						type: 'answer',
						sdp: pc.localDescription.sdp
					});
					answerArea.val(token);
					answerSec.show();
					btnGenAnswer.val('生成确认码');
					tipWait.html('<span style="color: #f80;">等待房主在主机端点击【接纳】后即可秒连对战...</span>');

					btnCopyAnswer.unbind('click').click(function() {
						copyToClipboard(token, '确认码已复制！请发给房主');
						btnCopyAnswer.val('✓ 已复制');
						setTimeout(function() { btnCopyAnswer.val('复制确认码'); }, 2000);
					});

					if (window.QRCode && qrCanvas[0]) {
						try {
							QRCode.draw(qrCanvas[0], token, 160);
							qrCanvas.show();
						} catch (e) {
							qrCanvas.hide();
						}
					}
				}).catch(function(err) {
					alert('解析失败: ' + err);
					btnGenAnswer.val('生成确认码');
				});
			} catch (err) {
				console.error('[Client generate error]', err);
				alert('处理异常: ' + err);
				btnGenAnswer.val('生成确认码');
			}
		}

		btnGenAnswer.click(generateClientAnswer);

		function applyClientDialogLayout() {
			$('.dialog').css({
				'left': '15%',
				'right': '15%',
				'top': '12%',
				'bottom': '12%',
				'min-height': '360px',
				'min-width': '300px'
			});
		}

		function onCancelClientModal() {
			if (currentClientPC) {
				try { currentClientPC.close(); } catch (e) {}
				currentClientPC = null;
			}
			clientConn.close();
		}

		kernel.showDialog([modalDiv, null, onCancelClientModal, onCancelClientModal], 'battleClient', '加入对战房间 (选手)', applyClientDialogLayout);
		applyClientDialogLayout();

		if (prefilledOffer) {
			setTimeout(generateClientAnswer, 150);
		}
	}

	// 3. Official Server Join (官方服务器加入)
	function joinServerRoom() {
		battleMode = 'server';
		var val = prompt(TOOLS_BATTLE_JOINALERT + ' [a-zA-Z0-9]', roomId || (100 + ~~(Math.random() * 900)));
		if (!val || !/^[0-9a-zA-Z]{3,20}$/.exec(val)) {
			if (val) alert('invalid room ID');
			return;
		}
		roomId = val;
		if (!conn.isConnected()) {
			conn.connect().then(function() {
				joinServerRoomWithId(roomId);
			});
			return;
		}
		joinServerRoomWithId(roomId);
	}

	function joinServerRoomWithId(rId) {
		if (!checkConnState() || !rId) return;
		conn.remoteCall({
			'action': 'joinRoom',
			'roomId': rId,
			'accountId': compId,
			'scramble': generate333Scramble()
		}).then(function(ret) {
			DEBUG && console.log('[server battle] joinRoom ret=', ret);
		});
	}

	// 4. Tunnel / Self-Hosted Server Join (内网穿透 / 自建对战服务)
	function showTunnelBattleModal(prefilledServer, prefilledRoom) {
		checkConnState(false);
		var modalDiv = $('<div style="text-align: left; padding: 14px; width: 100%; height: 100%; box-sizing: border-box; overflow-y: auto; font-size: 0.9em;"></div>');

		var defServer = prefilledServer || localStorage.getItem('cstimer_tunnel_server') || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
		var defRoom = prefilledRoom || roomId || ('' + (100 + ~~(Math.random() * 900)));

		var serverInput = $('<input type="text" style="width: 100%; box-sizing: border-box; padding: 5px; font-size: 0.9em; margin: 4px 0 10px 0;">').val(defServer);
		var roomInput = $('<input type="text" style="width: 140px; box-sizing: border-box; padding: 5px; font-size: 0.9em; margin: 4px 0 12px 0;">').val(defRoom);

		var btnConnect = $('<input type="button" class="buttonOK" value="🚀 连接并进入房间" style="font-weight: bold; padding: 6px 14px; margin-right: 10px;">');
		var statusTip = $('<div style="margin-top: 10px; font-size: 0.85em; min-height: 20px;"></div>');

		var shareSec = $('<div style="margin-top: 14px; border-top: 1px dashed #bbb; padding-top: 10px; display: none;"></div>');
		var shareUrlInput = $('<input type="text" readonly style="width: 100%; box-sizing: border-box; font-size: 0.8em; padding: 5px; margin: 4px 0 6px 0;">').click(function() { this.select(); });
		var btnCopyShare = $('<input type="button" value="复制对战邀请链接" style="margin-right: 8px;">');
		var qrCanvas = $('<canvas style="display: block; margin: 10px auto; background: #fff; padding: 6px; border: 1px solid #ccc;"></canvas>');
		shareSec.append('<div style="font-weight: bold; color: #2e7d32;">🔗 专属好友秒连链接（发给好友点击即连）：</div>', shareUrlInput, btnCopyShare, qrCanvas);

		modalDiv.append(
			'<div style="color: #2e7d32; font-weight: bold; font-size: 1.1em; margin-bottom: 8px;">🚀 内网穿透 / 本地服务器秒连模式</div>',
			'<div style="color: #666; font-size: 0.85em; margin-bottom: 12px; line-height: 1.4;">无需复制邀请码/确认码，纯 WebSocket 直连，100% 连通无阻！</div>',
			'<div style="color: #333; margin-bottom: 4px;"><b>1. 服务器地址 (WebSocket)：</b><br><span style="font-size: 0.8em; color: #888;">填入内网穿透公网地址（如 <code>abc.cpolar.top:12345</code>）或本地地址：</span></div>',
			serverInput,
			'<div style="color: #333; margin-bottom: 4px;"><b>2. 对战房间号：</b></div>',
			roomInput,
			$('<div></div>').append(btnConnect),
			statusTip,
			shareSec
		);

		btnConnect.click(function() {
			var sUrl = serverInput.val().trim();
			var rId = roomInput.val().trim();
			if (!sUrl) { alert('请输入对战服务器地址！'); return; }
			if (!rId) { alert('请输入房间号！'); return; }

			localStorage.setItem('cstimer_tunnel_server', sUrl);
			statusTip.html('<span style="color: #0288d1; font-weight: bold;">⏳ 正在连接服务器...</span>');
			btnConnect.prop('disabled', true);

			battleMode = 'server';
			roomId = rId;
			compId = getMyAccountId();

			wsConn.connect(sUrl).then(function() {
				statusTip.html('<span style="color: #2e7d32; font-weight: bold;">✅ 服务器连接成功，正在加入房间 ' + rId + ' ...</span>');
				joinServerRoomWithId(rId);

				// 构造好友秒连 URL
				var rawHost = sUrl.replace(/^wss?:\/\//i, '').replace(/\/ws$/i, '');
				var shareBase = location.protocol + '//' + location.host + location.pathname;
				var fullShareUrl = shareBase + '#battleServer=' + encodeURIComponent(rawHost) + '&room=' + encodeURIComponent(rId);
				shareUrlInput.val(fullShareUrl);

				btnCopyShare.unbind('click').click(function() {
					copyToClipboard(fullShareUrl, '对战秒连链接已复制！');
					btnCopyShare.val('✓ 已复制链接');
					setTimeout(function() { btnCopyShare.val('复制对战邀请链接'); }, 2000);
				});

				if (window.QRCode && qrCanvas[0]) {
					try {
						QRCode.draw(qrCanvas[0], fullShareUrl, 150);
						qrCanvas.show();
					} catch (e) {
						qrCanvas.hide();
					}
				}
				shareSec.show();
				btnConnect.prop('disabled', false).val('进入对战房间');
				btnConnect.unbind('click').click(function() {
					kernel.hideDialog();
				});
			}).catch(function(err) {
				statusTip.html('<span style="color: #d32f2f; font-weight: bold;">❌ 连接失败: ' + err + '<br>请确认本地已运行 <code>start.bat</code>，且内网穿透端口与地址填写正确。</span>');
				btnConnect.prop('disabled', false);
			});
		});

		function applyModalLayout() {
			$('.dialog').css({
				'left': '15%',
				'right': '15%',
				'top': '10%',
				'bottom': '10%',
				'min-height': '380px',
				'min-width': '300px'
			});
		}

		kernel.showDialog([modalDiv, null, null, null], 'battleTunnel', '内网穿透对战 (秒连模式)', applyModalLayout);
		applyModalLayout();

		if (prefilledServer && prefilledRoom) {
			setTimeout(function() {
				btnConnect.click();
			}, 100);
		}
	}

	function leaveRoom(direct) {
		if (!checkConnState(true) || !roomId) {
			return;
		}
		if (!direct) {
			if (!confirm(TOOLS_BATTLE_LEAVEALERT + '?')) {
				return;
			}
		}
		if (battleMode === 'server') {
			conn.remoteCall({
				'action': 'leaveRoom',
				'roomId': roomId,
				'accountId': compId
			}).then(conn.close, conn.close);
		} else {
			conn.close();
		}
		roomInfo = null;
		roomId = null;
		compId = null;
		if (arena && arena.unmount) arena.unmount();
		renderRoom();
	}

	function getMyAccountId() {
		var id = (exportFunc && exportFunc.getDataId('wcaData', 'cstimer_token')) ||
		         (exportFunc && exportFunc.getDataId('locData', 'compid'));
		if (!id) {
			id = 'Player_' + (~~(Math.random() * 900) + 100);
			try {
				if (window.localStorage) {
					var loc = JSON.parse(localStorage['locData'] || '{}');
					loc.compid = id;
					localStorage['locData'] = JSON.stringify(loc);
				}
			} catch (e) {}
		}
		return id;
	}

	function checkConnState(checkRoom) {
		if (checkRoom && !roomInfo) {
			return null;
		}
		if (!compId) {
			compId = getMyAccountId();
		}
		return compId;
	}

	function submitStatus(status) {
		if (!checkConnState(true) || !roomId) {
			return;
		}
		var startAt = (status === 'SOLVING') ? Date.now() : undefined;
		if (battleMode === 'p2p_host') {
			hostEngine.hostUpdateStatus(compId, status, startAt);
		} else {
			var remoteMsg = {
				'action': 'updateStatus',
				'roomId': roomId,
				'accountId': compId,
				'status': status
			};
			if (startAt !== undefined) remoteMsg.startAt = startAt;
			conn.remoteCall(remoteMsg);
		}
	}

	function submitSolve(time, isLast) {
		if (!checkConnState(true) || !roomId || !roomInfo) {
			return;
		}
		var solvScr = (time && time[1]) ? time[1] : '';
		var curScr = (roomInfo['cur'] && roomInfo['cur'][1]) ? roomInfo['cur'][1] : '';
		var lastScr = (roomInfo['last'] && roomInfo['last'][1]) ? roomInfo['last'][1] : '';
		if (solvScr.trim() != curScr.trim() && solvScr.trim() != lastScr.trim()) {
			if (curScr) {
				solvScr = curScr;
			}
		}
		if (localLastSolve && localLastSolve[1] == time[1] && (!isLast || time[0][1] != localLastSolve[0][1])) {
			return;
		}
		localLastSolve = time;
		var solveId = (solvScr == curScr) ? roomInfo['cur'][0] : (roomInfo['last'] ? roomInfo['last'][0] : roomInfo['cur'][0]);

		if (battleMode === 'p2p_host') {
			hostEngine.hostUploadSolve(compId, solveId, time);
		} else {
			conn.remoteCall({
				'action': 'uploadSolve',
				'roomId': roomId,
				'accountId': compId,
				'solveId': solveId,
				'time': time,
				'scramble': generate333Scramble()
			});
		}
	}

	function onNotify(event, obj) {
		if (event == 'msg') {
			if ('roomInfo' in obj) {
				roomInfo = obj['roomInfo'];
				if (battleMode !== 'p2p_host') {
					kernel.hideDialog();
					// 如果选手端收到 roomInfo 发现自己在 players 列表中未登记，立即自动补发 joinRoom
					if (battleMode === 'p2p_client' && roomInfo.players) {
						var meIn = false;
						for (var pi = 0; pi < roomInfo.players.length; pi++) {
							if (roomInfo.players[pi].accountId === compId) {
								meIn = true;
								break;
							}
						}
						if (!meIn) {
							conn.pushMsg({
								'action': 'joinRoom',
								'roomId': roomId,
								'accountId': compId,
								'scramble': generate333Scramble()
							});
						}
					}
				}
				onRoomInfo();
				if (arena && arena.sync) arena.sync(roomInfo);
			} else if (obj['action'] === 'liveTick') {
				if (arena && arena.onLiveTick) {
					arena.onLiveTick(obj['accountId'], obj['curTime']);
				}
				return;
			}
		} else {
			roomInfo = null;
			if (arena && arena.unmount) arena.unmount();
			if (kernel.getProp('scrType') == 'remoteBattle') {
				kernel.pushSignal('ctrl', ['scramble', 'next']);
			}
		}
		renderRoom();
	}

	function onRoomInfo() {
		if (!roomInfo) return;
		var newScr = roomInfo['cur'][1];
		if (newScr && newScr !== localLastSolve[1]) {
			if (kernel.getProp('scrType') !== 'remoteBattle') {
				kernel.setProp('scrType', 'remoteBattle');
			} else {
				if (scrResolve) {
					scrResolve(['$T333$' + newScr]);
					scrResolve = null;
				} else if (window.scramble && window.scramble.pushScramble) {
					window.scramble.pushScramble('$T333$' + newScr);
				} else {
					kernel.pushSignal('ctrl', ['scramble', 'next']);
				}
			}
		}
		// ── 实时计时：追踪哪些玩家正在还原 ──────────────────────────
		var anyoneSolving = false;
		var rPlayers = roomInfo['players'] || [];
		for (var ri = 0; ri < rPlayers.length; ri++) {
			var rp = rPlayers[ri];
			var rpId = rp['accountId'] || '';
			if (rp['status'] === 'SOLVING') {
				anyoneSolving = true;
				if (playerSolvingStart[rpId] === undefined) {
					// 首次检测到该玩家进入 SOLVING
					if (rp['startAt'] !== undefined) {
						// 方案三：使用远端时间戳（两端时钟同步，误差 < 50ms）
						playerSolvingStart[rpId] = rp['startAt'];
					} else {
						// 方案一兜底：使用本地收到消息的时刻
						playerSolvingStart[rpId] = Date.now();
					}
				}
			} else {
				// 状态不再是 SOLVING，清除记录
				delete playerSolvingStart[rpId];
			}
		}
		// 有人在还原时启动刷新定时器，否则停止
		if (anyoneSolving && !liveTimer) {
			liveTimer = setInterval(function() { renderRoom(); }, 100);
		} else if (!anyoneSolving && liveTimer) {
			clearInterval(liveTimer);
			liveTimer = null;
		}
	}

	function extractTimePair(val) {
		if (!val) return null;
		if (typeof val === 'object' && !Array.isArray(val)) {
			if (val.time) return extractTimePair(val.time);
			if (typeof val.soltime === 'number') return [0, val.soltime];
		}
		if (Array.isArray(val)) {
			if (val.length >= 2 && typeof val[0] === 'number' && typeof val[1] === 'number') {
				return [val[0], val[1]];
			}
			if (Array.isArray(val[0])) {
				return extractTimePair(val[0]);
			}
		}
		if (typeof val === 'number') {
			return [0, val];
		}
		return null;
	}

	function formatSolveTime(val, showDNF) {
		var pair = extractTimePair(val);
		if (!pair) return '--:--';
		return stats.pretty(pair, showDNF !== false);
	}

	function getSolveMillis(val) {
		var pair = extractTimePair(val);
		if (!pair) return null;
		if (pair[0] === -1) return -1;
		return pair[0] + pair[1];
	}

	function getPlayerMultiplier(accId) {
		if (roomInfo && roomInfo.multipliers && roomInfo.multipliers[accId] !== undefined) {
			return roomInfo.multipliers[accId];
		}
		if (roomInfo && roomInfo.players) {
			for (var i = 0; i < roomInfo.players.length; i++) {
				if (roomInfo.players[i].accountId === accId && roomInfo.players[i].multiplier !== undefined) {
					return roomInfo.players[i].multiplier;
				}
			}
		}
		return 1.0;
	}

	function calcTrimmedAvg(timesList, size) {
		if (!timesList || timesList.length < size) return null;
		var slice = timesList.slice(-size);
		var dnfs = 0;
		var valids = [];
		for (var i = 0; i < slice.length; i++) {
			var t = slice[i];
			if (t === -1 || t === null) {
				dnfs++;
			} else {
				valids.push(t);
			}
		}
		if (dnfs >= 2) {
			return -1; // DNF
		}
		valids.sort(function(a, b) { return a - b; });
		if (dnfs === 1) {
			valids.shift();
		} else {
			valids.shift();
			valids.pop();
		}
		var sum = 0;
		for (var j = 0; j < valids.length; j++) {
			sum += valids[j];
		}
		return Math.round(sum / valids.length);
	}

	function getPlayerSolvesList(accId) {
		if (!roomInfo || !roomInfo['solves']) return [];
		var list = [];
		var allSolves = roomInfo['solves'];
		for (var i = 0; i < allSolves.length; i++) {
			var s = allSolves[i];
			if (s['accountId'] === accId) {
				list.push(s);
			}
		}
		list.sort(function(a, b) { return a['solveId'] - b['solveId']; });
		return list;
	}

	function updatePlayerAvgStr(elem, accId) {
		if (!elem || !elem.length) return;
		var solves = getPlayerSolvesList(accId);
		var times = [];
		for (var i = 0; i < solves.length; i++) {
			var ms = getSolveMillis(solves[i]);
			if (ms !== null) {
				times.push(ms);
			}
		}
		var ao5 = calcTrimmedAvg(times, 5);
		var ao12 = calcTrimmedAvg(times, 12);
		var ao5Str = 'ao5: ' + (ao5 === null ? '-' : (ao5 === -1 ? 'DNF' : (ao5 / 1000).toFixed(2)));
		var ao12Str = 'ao12: ' + (ao12 === null ? '-' : (ao12 === -1 ? 'DNF' : (ao12 / 1000).toFixed(2)));
		elem.html('<span>' + ao5Str + '</span><br><span>' + ao12Str + '</span>');
	}

	function onMultiplierClick(accId, name, currentM) {
		if (battleMode !== 'p2p_host') {
			alert('只有房主可以调节倍率');
			return;
		}
		var input = prompt('设置【' + name + '】的倍率 (支持1位小数，如 0.8, 1.0, 1.2):', (currentM || 1.0).toFixed(1));
		if (input === null) return;
		var num = parseFloat(input);
		if (isNaN(num) || num <= 0) {
			alert('请输入大于 0 的有效数字');
			return;
		}
		var newMult = Math.round(num * 10) / 10;
		if (hostEngine && hostEngine.setMultiplier) {
			hostEngine.setMultiplier(accId, newMult);
		}
	}

	function renderRoom() {
		DEBUG && console.log('[battle] render room', roomInfo);
		if (roomInfo) {
			accountDiv.hide();
		} else {
			accountDiv.show();
		}
		roomTable.empty();
		var titles = ['排名', '昵称', '倍率', '身份', '状态', '时间'];

		if (!roomInfo) {
			// 未加入房间时的操作界面
			var headerTr = $('<tr>').append($('<td colspan=6 style="padding: 10px 4px; text-align: center;"></td>'));
			var btnTunnel = $('<input type="button" class="buttonOK" value="🚀 穿透/服务器对战 (推荐)" style="font-weight: bold; margin-right: 8px; padding: 6px 14px; background: #2e7d32; color: #fff; cursor: pointer;">');
			var btnHost = $('<input type="button" class="buttonOK" value="👑 P2P局域网主机" style="margin-right: 6px; padding: 5px 9px; font-size: 0.85em; cursor: pointer;">');
			var btnClient = $('<input type="button" class="buttonOK" value="🎮 P2P选手加入" style="margin-right: 6px; padding: 5px 9px; font-size: 0.85em; cursor: pointer;">');
			var btnServer = $('<span class="click" style="font-size: 0.8em; color: #888; text-decoration: underline; margin-left: 6px;">[官方公共服务]</span>');

			btnTunnel.click(function() { showTunnelBattleModal(); });
			btnHost.click(showHostModal);
			btnClient.click(function() { showClientModal(); });
			btnServer.click(joinServerRoom);

			headerTr.find('td').append(btnTunnel, btnHost, btnClient, $('<div style="margin-top: 8px;"></div>').append(btnServer));
			roomTable.append(headerTr);

			var infoText = '<b>🌟 推荐【🚀 穿透/服务器对战】</b>：配合房主电脑内网穿透（如 cpolar / natfrp 等），好友点击链接秒连，100% 连通无阻！<br>若双方在同一 Wi-Fi 下，亦可选择 P2P 局域网直连。';
			roomTable.append('<tr><td colspan=6 style="width:0; padding: 8px 4px; color: #666; font-size: 0.85em; text-align: center; line-height: 1.5;">' + infoText + '</td></tr>');
		} else {
			// 已在房间中的对战界面
			var isHost = (battleMode === 'p2p_host');
			var hostBadge = isHost ? '<span style="color:#f80;font-weight:bold;">[房主主机]</span> ' : (battleMode === 'server' ? '<span style="color:#4a90e2;">[服务器]</span> ' : '<span style="color:#2e7d32;">[客户机]</span> ');
			var headRow = $('<tr>').append($('<td colspan=6 style="padding: 6px 4px;"></td>'));
			headRow.find('td').append(
				headStr[0] + ': <b>' + roomInfo['roomId'] + '</b> ' + hostBadge,
				'&nbsp;',
				leaveRoomSpan.html('[离开房间]').unbind('click').click(leaveRoom.bind(null, false)).show()
			);

			// 房主专属控制栏
			if (isHost) {
				var hostCtrl = $('<div style="margin-top: 5px; font-size: 0.9em;"></div>');
				var btnNextScr = $('<input type="button" class="buttonOK" value="▶ 派发新打乱 (下一轮)" style="margin-right: 8px; font-size: 0.85em;">');
				var btnInviteMore = $('<input type="button" value="+ 邀请新选手" style="margin-right: 8px; font-size: 0.85em;">');
				var chkAuto = $('<label style="font-size: 0.85em; cursor: pointer;"><input type="checkbox" ' + (hostEngine.getAutoNext() ? 'checked' : '') + '> 全员完成自动下一轮</label>');

				btnNextScr.click(function() {
					hostEngine.advanceRound();
				});
				btnInviteMore.click(function() {
					showHostModal();
				});
				chkAuto.find('input').change(function() {
					hostEngine.setAutoNext($(this).prop('checked'));
				});

				// 计分板设置控制栏
				var sbState = (hostEngine.getScoreboard ? hostEngine.getScoreboard() : { enabled: false, x: 3, y: 5 }) || {};
				var scoreCtrl = $('<div style="margin-top: 6px; padding-top: 5px; border-top: 1px dashed #ccc; font-size: 0.85em; display: flex; align-items: center; flex-wrap: wrap; gap: 6px;"></div>');
				var chkScore = $('<label style="cursor: pointer; font-weight: bold;"><input type="checkbox" ' + (sbState.enabled ? 'checked' : '') + '> 开启计分板</label>');
				var inputX = $('<input type="number" min="1" max="99" value="' + (sbState.x || 3) + '" style="width: 38px; text-align: center; margin: 0 2px;">');
				var inputY = $('<input type="number" min="1" max="99" value="' + (sbState.y || 5) + '" style="width: 38px; text-align: center; margin: 0 2px;">');
				var btnResetScore = $('<input type="button" value="重置比分" style="font-size: 0.8em; padding: 1px 6px;">');

				function updateScoreCfg() {
					var en = chkScore.find('input').prop('checked');
					var vx = parseInt(inputX.val()) || 3;
					var vy = parseInt(inputY.val()) || 5;
					hostEngine.setScoreboardConfig(en, vx, vy);
				}
				chkScore.find('input').change(updateScoreCfg);
				inputX.change(updateScoreCfg);
				inputY.change(updateScoreCfg);
				btnResetScore.click(function() {
					if (confirm('确认重置当前计分与胜负状态？')) {
						hostEngine.resetScoreboard();
					}
				});

				scoreCtrl.append(
					chkScore,
					$('<span>').append('局点(x): ', inputX, ' 分'),
					$('<span>').append('大分(y): ', inputY, ' 局'),
					btnResetScore
				);

				hostCtrl.append(btnNextScr, btnInviteMore, chkAuto, scoreCtrl);
				headRow.find('td').append(hostCtrl);
			}

			roomTable.append(headRow);

			if (roomInfo.scoreboard && roomInfo.scoreboard.enabled) {
				var sb = roomInfo.scoreboard;
				var sbRow = $('<tr><td colspan=6 style="padding: 4px; background: rgba(0, 132, 168, 0.08); text-align: center; font-size: 0.85em;"></td></tr>');
				var sbTxt = '🏆 <b>抢分模式</b> (单局 ' + sb.x + ' 分胜出 | 抢 ' + sb.y + ' 局夺冠)';
				if (sb.winner) {
					sbTxt += '<br><b style="color:#d84315; font-size: 1.1em;">👑 最终胜者：' + formatName(sb.winner) + ' 赢得全场最终胜利！</b>';
				}
				sbRow.find('td').html(sbTxt);
				roomTable.append(sbRow);
			}

			roomTable.append('<tr><th>' + titles.join('</th><th>') + '</th></tr>');

			var players = roomInfo['players'] || [];
			var solves = roomInfo['solves'] || [];
			var solveDict = {};
			var statusMap = ('???|' + TOOLS_BATTLE_STATUS).split('|');

			for (var i = 0; i < solves.length; i++) {
				var solveObj = solves[i];
				var accountId = solveObj['accountId'];
				solveDict[accountId] = solveDict[accountId] || {};
				solveDict[accountId][solveObj['solveId']] = solveObj;
			}

			var curSolveId = roomInfo['cur'][0];
			var playerStats = [];
			var bestEffMs = Infinity;
			var bestAccId = null;

			for (var i = 0; i < players.length; i++) {
				var p = players[i];
				var rawAccId = p['accountId'] || '';
				var mult = getPlayerMultiplier(rawAccId);
				var pSolves = solveDict[rawAccId] || {};
				var pSolve = pSolves[curSolveId];
				var rawMs = pSolve ? getSolveMillis(pSolve) : null;
				var effMs = null;
				if (rawMs !== null) {
					effMs = (rawMs === -1) ? -1 : Math.round(rawMs * mult);
					if (effMs > 0 && effMs < bestEffMs) {
						bestEffMs = effMs;
						bestAccId = rawAccId;
					}
				}
				playerStats.push({
					player: p,
					rawAccId: rawAccId,
					mult: mult,
					pSolves: pSolves,
					pSolve: pSolve,
					rawMs: rawMs,
					effMs: effMs,
					status: p['status']
				});
			}

			// 排名排序：已完成成绩按 effMs 升序排序，未完成的排在后面
			playerStats.sort(function(a, b) {
				var va = (a.effMs !== null && a.status === 'SOLVED') ? (a.effMs === -1 ? 999999998 : a.effMs) : 999999999;
				var vb = (b.effMs !== null && b.status === 'SOLVED') ? (b.effMs === -1 ? 999999998 : b.effMs) : 999999999;
				return va - vb;
			});

			for (var i = 0; i < playerStats.length; i++) {
				var ps = playerStats[i];
				var rawAccId = ps.rawAccId;
				var account = rawAccId || '匿名';
				var isBot = ps.player.isBot;
				var roleText = ps.player['isHost'] ? '<span style="color:#f80;">房主</span>' : (isBot ? '🤖 陪练' : '选手');
				if (typeof account === 'string') {
					if (account.indexOf('|') != -1) {
						account = '<b>' + account.split('|')[1] + '</b>';
					} else if (account.length > 10) {
						account = account.slice(0, 4) + '...' + account.slice(account.length - 3);
					}
				}

				if (roomInfo.scoreboard && roomInfo.scoreboard.enabled) {
					var sb = roomInfo.scoreboard;
					var pSmall = (sb.scores && sb.scores[rawAccId]) || 0;
					var pBig = (sb.bigScores && sb.bigScores[rawAccId]) || 0;
					var isWinner = (sb.winner === rawAccId);
					account += ' <span style="color:#0084a8; font-size: 0.85em; font-weight: bold;">[' + pBig + '大分 | ' + pSmall + '分]</span>';
					if (isWinner) {
						account += ' 👑';
					}
				}

				var isSolved = ps.status === 'SOLVED';
				var isSolving = ps.status === 'SOLVING';
				var isInspect = ps.status === 'INSPECT';
				var lastTimeStr = 'N/A';

				if (isSolving && playerSolvingStart[rawAccId] !== undefined) {
					var elapsed = (Date.now() - playerSolvingStart[rawAccId]) / 1000;
					var effElapsed = elapsed * ps.mult;
					lastTimeStr = '<span style="color:#4a90e2;font-weight:bold">' + effElapsed.toFixed(2) + '</span>';
				} else if (isInspect) {
					lastTimeStr = '<span style="color:#f80">检查中</span>';
				} else if (isSolved && ps.effMs !== null) {
					var formattedEff = (ps.effMs === -1) ? 'DNF' : (ps.effMs / 1000).toFixed(2);
					if (rawAccId === bestAccId) {
						lastTimeStr = '<span style="color:#008000;font-weight:bold;">' + formattedEff + '</span>';
					} else {
						lastTimeStr = '<span style="color:#f00;font-weight:bold;">' + formattedEff + '</span>';
					}
				} else {
					// 未完成当前轮，向前找最近一把历史成绩
					var prevSolve = null;
					for (var sid = curSolveId - 1; sid >= 1; sid--) {
						if (ps.pSolves[sid]) {
							prevSolve = ps.pSolves[sid];
							break;
						}
					}
					if (prevSolve) {
						var prevRawMs = getSolveMillis(prevSolve);
						if (prevRawMs !== null) {
							var prevEff = (prevRawMs === -1) ? 'DNF' : (Math.round(prevRawMs * ps.mult) / 1000).toFixed(2);
							lastTimeStr = '<span style="color:#888;">' + prevEff + '</span>';
						}
					}
				}

				var tr = $('<tr></tr>');
				tr.append('<td>' + (i + 1) + '</td>');
				tr.append('<td>' + account + '</td>');

				var multTd = $('<td>' + ps.mult.toFixed(1) + '</td>');
				if (isHost) {
					multTd.addClass('battle-mult-click').attr('title', '点击修改该成员倍率').click((function(acc, name, m) {
						return function(e) {
							e.stopPropagation();
							onMultiplierClick(acc, name, m);
						};
					})(rawAccId, formatName(rawAccId), ps.mult));
				}
				tr.append(multTd);
				tr.append('<td>' + roleText + '</td>');
				tr.append('<td>' + (statusMap[['READY', 'INSPECT', 'SOLVING', 'SOLVED', 'LOSS'].indexOf(ps.status) + 1] || ps.status) + '</td>');
				tr.append('<td>' + lastTimeStr + '</td>');
				roomTable.append(tr);
			}
		}
	}

	function updateAccountDiv() {
		accountDiv.empty().append('ID: ');
		wcaSpan.empty();
		uidSpan.empty();

		var wcauid = exportFunc.getDataId('wcaData', 'cstimer_token');
		if (wcauid) {
			var wcaid = exportFunc.getDataId('wcaData', 'wca_me')['wca_id'];
			wcaSpan.append(wcaid || 'WCA Account', ' (WCA)').click(function() {
				exportFunc.logoutFromWCA(true);
				updateAccountDiv();
			});
			accountDiv.append(wcaSpan);
			return;
		} else {
			wcaSpan.append(EXPORT_LOGINWCA);
			wcaSpan.click(function() {
				location.href = exportFunc.wcaLoginUrl;
			});
		}
		var compid = exportFunc.getDataId('locData', 'compid');
		uidSpan.append((compid || 'N/A') + ' (' + OLCOMP_ANONYM + ')');
		accountDiv.append(uidSpan.unbind('click').click(setCompId), ' | ', wcaSpan);
	}

	function setCompId() {
		var compid = prompt(OLCOMP_SUBMITAS, exportFunc.getDataId('locData', 'compid'));
		if (compid == null) {
			return false;
		} else if (!exportFunc.isValidId(compid)) {
			alert(EXPORT_INVID);
			return false;
		}
		localStorage['locData'] = JSON.stringify({ id: exportFunc.getDataId('locData', 'id'), compid: compid });
		updateAccountDiv();
		return compid;
	}

	function execFunc(fdiv, e) {
		if (!fdiv || isInit) {
			isInit = !!fdiv;
			if (!fdiv) {
				conn.close();
			}
			return;
		}
		fdiv.empty().append($('<div style="font-size: 0.75em; text-align: center;">')
			.append(accountDiv, roomTable));
		updateAccountDiv();
		renderRoom();
		isInit = true;

		// Check URL hash for battle offer
		checkHashForOffer();
	}

	function checkHashForOffer() {
		var hash = window.location.hash || '';
		if (hash.indexOf('battleOffer=') !== -1 || hash.indexOf('p2pOffer=') !== -1) {
			var token = hash.split('battleOffer=')[1] || hash.split('p2pOffer=')[1];
			if (token) {
				token = token.split('&')[0];
				showClientModal(token);
			}
		} else if (hash.indexOf('battleServer=') !== -1) {
			var params = {};
			var raw = hash.replace(/^#/, '');
			raw.split('&').forEach(function(pair) {
				var kv = pair.split('=');
				if (kv.length === 2) params[kv[0]] = decodeURIComponent(kv[1]);
			});
			if (params['battleServer'] && params['room']) {
				setTimeout(function() {
					showTunnelBattleModal(params['battleServer'], params['room']);
				}, 200);
			}
		}
	}

	// ==================== Battle Split Screen (对战分屏：一分为多，一左一右，图二原生风格) ====================
	var arena = (function() {
		var isMounted = false;
		var liveBroadcastTimer = null;
		var liveTickMap = {}; // accountId -> { curTime: number, recvAt: number }
		var animFrameId = null;

		function syncTimerStyles() {
			var container = $('#container');
			if (!container.length) return;
			var fSize = container.css('font-size');
			var fFam = container.css('font-family');
			var fColor = container.css('color') || '#000';
			$('#timer.in-battle-mode td.battle-pane-opp').css({
				'font-size': fSize,
				'font-family': fFam,
				'color': fColor
			});
			// 确保左右计时器和统计数字完全 1:1 等大
			var lcdSize = $('#lcd').css('font-size');
			if (lcdSize) {
				$('#battle-opp-lcd, [id^="battle-lcd-"]').css('font-size', lcdSize);
			}
			var avgSize = $('#avgstr').css('font-size');
			if (avgSize) {
				$('#battle-opp-avgstr, [id^="battle-avgstr-"]').css('font-size', avgSize);
			}
		}

		function getTr() {
			var tr = $('#timer > tbody > tr').first();
			if (!tr.length) tr = $('#timer tr').first();
			return tr;
		}

		function mount() {
			if (isMounted) return;
			var timerTable = $('#timer');
			var tr = getTr();
			if (!tr.length) return;

			timerTable.addClass('in-battle-mode');
			$('#container').addClass('battle-pane-self');

			// 己方计分板方框：[大比分] [小比分]
			if (!$('#battle-self-score-group').length) {
				$('#container').prepend('<div id="battle-self-score-group" class="battle-score-group">' +
					'<div class="battle-score-box big-score" id="battle-self-big" title="大比分">0</div>' +
					'<div class="battle-score-box small-score" id="battle-self-small" title="小比分">0</div>' +
					'</div>');
			}

			// 检查是否已有对手面板，若无则添加（默认为 1v1 右侧面板）
			// 对手方框为对称排列：紧贴中线为 [小比分]，外侧为 [大比分]
			if (!$('#battle-opp-container').length) {
				var oppTd = $('<td id="battle-opp-container" class="battle-pane-right battle-pane-opp">' +
					'<div id="battle-opp-score-group" class="battle-score-group">' +
					'<div class="battle-score-box small-score" id="battle-opp-small" title="小比分">0</div>' +
					'<div class="battle-score-box big-score" id="battle-opp-big" title="大比分">0</div>' +
					'</div>' +
					'<div id="battle-opp-lcd">--:--</div>' +
					'<div id="battle-opp-avgstr" class="battle-opp-avgstr"><span>ao5: -</span><br><span>ao12: -</span></div>' +
					'</td>');
				tr.append(oppTd);
			}

			syncTimerStyles();
			isMounted = true;
			startAnimLoop();
		}

		function unmount() {
			if (!isMounted) return;
			stopAnimLoop();
			stopLocalBroadcast();

			var timerTable = $('#timer');
			timerTable.removeClass('in-battle-mode players-3 players-4');
			$('#container').removeClass('battle-pane-self');

			// 移除所有对手分屏单元格及计分元素
			$('td.battle-pane-opp, td.battle-pane-right').remove();
			$('.battle-score-group, #battle-topleft-banner, [id^="battle-score-"]').remove();

			isMounted = false;
			liveTickMap = {};
		}

		function startLocalBroadcast() {
			stopLocalBroadcast();
			liveBroadcastTimer = setInterval(function() {
				if (timer && timer.getCurTime) {
					var cur = timer.getCurTime();
					var msg = {
						action: 'liveTick',
						accountId: compId,
						curTime: cur
					};
					if (battleMode === 'p2p_host') {
						hostEngine.broadcastMsg(msg);
					} else if (battleMode === 'p2p_client') {
						clientConn.pushMsg(msg);
					}
				}
			}, 50);
		}

		function stopLocalBroadcast() {
			if (liveBroadcastTimer) {
				clearInterval(liveBroadcastTimer);
				liveBroadcastTimer = null;
			}
		}

		function onLiveTick(accId, curTime) {
			liveTickMap[accId] = {
				curTime: curTime,
				recvAt: Date.now()
			};
		}

		function startAnimLoop() {
			if (animFrameId) return;
			function loop() {
				renderLiveOpponents();
				animFrameId = requestAnimationFrame(loop);
			}
			animFrameId = requestAnimationFrame(loop);
		}

		function stopAnimLoop() {
			if (animFrameId) {
				cancelAnimationFrame(animFrameId);
				animFrameId = null;
			}
		}

		function renderLiveOpponents() {
			if (!isMounted || !roomInfo) return;
			syncTimerStyles();

			var players = roomInfo['players'] || [];
			var curSolveId = roomInfo['cur'][0];
			var solves = roomInfo['solves'] || [];
			var solveDict = {};
			for (var i = 0; i < solves.length; i++) {
				var s = solves[i];
				solveDict[s['accountId']] = solveDict[s['accountId']] || {};
				solveDict[s['accountId']][s['solveId']] = s;
			}

			// 比较所有已完成选手的乘以倍率后的时间，决出第一名 (绿色)，其余为红色
			var bestEffMs = Infinity;
			var bestAccId = null;
			for (var pi = 0; pi < players.length; pi++) {
				var pid = players[pi]['accountId'];
				var pSol = solveDict[pid] && solveDict[pid][curSolveId];
				if (pSol && players[pi]['status'] === 'SOLVED') {
					var pRaw = getSolveMillis(pSol);
					if (pRaw !== null && pRaw > 0) {
						var pMult = getPlayerMultiplier(pid);
						var pEff = Math.round(pRaw * pMult);
						if (pEff < bestEffMs) {
							bestEffMs = pEff;
							bestAccId = pid;
						}
					}
				}
			}

			// 1. 同步自己左侧计时器（大字为实际时间，括号为乘以倍率后的时间，第一名绿色，其余红色）
			var selfSolve = solveDict[compId] && (solveDict[compId][curSolveId] || solveDict[compId][curSolveId - 1]);
			var selfPlayer = null;
			for (var pi = 0; pi < players.length; pi++) {
				if (players[pi]['accountId'] === compId) {
					selfPlayer = players[pi];
					break;
				}
			}
			if (selfSolve) {
				var sidUsed = (solveDict[compId] && solveDict[compId][curSolveId]) ? curSolveId : (curSolveId - 1);
				var selfMult = getPlayerMultiplier(compId);
				var selfRawMs = getSolveMillis(selfSolve);
				var selfEffMs = (selfRawMs === -1) ? -1 : Math.round(selfRawMs * selfMult);
				var selfEffStr = (selfEffMs === -1) ? '(DNF)' : '(' + (selfEffMs / 1000).toFixed(2) + ')';
				var isWinnerSelf = false;
				if (sidUsed === curSolveId) {
					isWinnerSelf = (compId === bestAccId);
				} else {
					var sbWinner = (roomInfo.scoreboard && roomInfo.scoredSolveIds && roomInfo.scoredSolveIds[sidUsed]) || null;
					isWinnerSelf = (sbWinner === compId);
				}
				var selfColor = isWinnerSelf ? '#008000' : '#f00';
				var selfDiffLabel = $('#lcd .difflabel');
				if (!selfDiffLabel.length) {
					selfDiffLabel = $('<div class="difflabel"></div>').appendTo('#lcd');
				}
				selfDiffLabel.html(selfEffStr).css('color', selfColor).show();
				setTimeout(function() {
					$('#lcd .difflabel').html(selfEffStr).css('color', selfColor).show();
				}, 20);
			}

			var otherPlayers = [];
			for (var i = 0; i < players.length; i++) {
				if (players[i]['accountId'] !== compId) {
					otherPlayers.push(players[i]);
				}
			}

			// 计分板实时更新（所有人都能看到）
			var sb = (roomInfo && roomInfo.scoreboard) || { enabled: true, scores: {}, bigScores: {} };
			if (sb.enabled) {
				$('.battle-score-group').show();
			} else {
				$('.battle-score-group').hide();
			}
			var selfSmall = (sb.scores && sb.scores[compId]) || 0;
			var selfBig = (sb.bigScores && sb.bigScores[compId]) || 0;
			$('#battle-self-big').text(selfBig);
			$('#battle-self-small').text(selfSmall);

			if (otherPlayers.length === 1) {
				var oppAcc = otherPlayers[0]['accountId'];
				var oppSmall = (sb.scores && sb.scores[oppAcc]) || 0;
				var oppBig = (sb.bigScores && sb.bigScores[oppAcc]) || 0;
				$('#battle-opp-big').text(oppBig);
				$('#battle-opp-small').text(oppSmall);
			} else if (otherPlayers.length > 1) {
				for (var oi = 0; oi < otherPlayers.length; oi++) {
					var mAcc = otherPlayers[oi]['accountId'];
					var mSmall = (sb.scores && sb.scores[mAcc]) || 0;
					var mBig = (sb.bigScores && sb.bigScores[mAcc]) || 0;
					$('#battle-big-' + oi).text(mBig);
					$('#battle-small-' + oi).text(mSmall);
				}
			}

			if (sb.winner) {
				var wName = formatName(sb.winner);
				if (!$('#battle-topleft-banner').length) {
					$('body').append('<div id="battle-topleft-banner">👑 最终胜者：【' + wName + '】 赢得全场最终胜利！</div>');
				} else {
					$('#battle-topleft-banner').html('👑 最终胜者：【' + wName + '】 赢得全场最终胜利！').show();
				}
			} else {
				$('#battle-topleft-banner').remove();
			}

			if (otherPlayers.length <= 1) {
				// 1v1 对战模式（对应图二）
				var oppLcd = $('#battle-opp-lcd');
				if (!oppLcd.length) return;

				if (otherPlayers.length === 0) {
					// 等待对手模式：右侧显示 --:--
					oppLcd.html('--:--');
					$('#battle-opp-avgstr').html('<span>ao5: -</span><br><span>ao12: -</span>');
					return;
				}

				var opp = otherPlayers[0];
				var oppId = opp['accountId'];
				var oppStatus = opp['status'] || 'READY';

				// 刷新对手的 ao5 和 ao12 显示
				updatePlayerAvgStr($('#battle-opp-avgstr'), oppId);

				if (oppStatus === 'SOLVING') {
					var now = Date.now();
					var elapsed = 0;
					if (liveTickMap[oppId]) {
						var delta = Math.min(3000, now - liveTickMap[oppId].recvAt);
						elapsed = liveTickMap[oppId].curTime + delta;
					} else if (playerSolvingStart[oppId]) {
						elapsed = now - playerSolvingStart[oppId];
					}
					// 实时以数字跳动显示对手的用时（大字为实际时间）
					oppLcd.html(kernel.pretty(Math.max(0, elapsed), true));
				} else if (oppStatus === 'INSPECT') {
					delete liveTickMap[oppId];
					oppLcd.html('15');
				} else if (oppStatus === 'SOLVED') {
					delete liveTickMap[oppId];
					var oppSolve = solveDict[oppId] && solveDict[oppId][curSolveId];
					var formattedOppRaw = formatSolveTime(oppSolve, true); // 大字：实际时间
					var oppRawMs = getSolveMillis(oppSolve);
					var oppMult = getPlayerMultiplier(oppId);
					var oppEffMs = (oppRawMs === -1) ? -1 : Math.round(oppRawMs * oppMult);
					var oppEffStr = (oppEffMs === -1) ? '(DNF)' : '(' + (oppEffMs / 1000).toFixed(2) + ')'; // 括号：乘以倍率之后的时间
					var oppColor = (oppId === bestAccId) ? '#008000' : '#f00'; // 第一名绿色，其余红色
					var diffHtml = '<div class="difflabel" style="color:' + oppColor + ';">' + oppEffStr + '</div>';
					oppLcd.html(formattedOppRaw + diffHtml);
				} else {
					delete liveTickMap[oppId];
					// READY 状态，若有上一把成绩则显示上一把及折算括号时间，否则显示 --:--
					var lastSid = curSolveId - 1;
					var prevS = solveDict[oppId] && solveDict[oppId][lastSid];
					if (prevS) {
						var formattedPrev = formatSolveTime(prevS, true);
						var prevRawMs = getSolveMillis(prevS);
						var prevMult = getPlayerMultiplier(oppId);
						var prevEffMs = (prevRawMs === -1) ? -1 : Math.round(prevRawMs * prevMult);
						var prevEffStr = (prevEffMs === -1) ? '(DNF)' : '(' + (prevEffMs / 1000).toFixed(2) + ')';
						var sbWinner = (roomInfo.scoreboard && roomInfo.scoredSolveIds && roomInfo.scoredSolveIds[lastSid]) || null;
						var prevColor = (sbWinner === oppId) ? '#008000' : '#f00';
						var prevDiffHtml = '<div class="difflabel" style="color:' + prevColor + ';">' + prevEffStr + '</div>';
						oppLcd.html(formattedPrev + prevDiffHtml);
					} else {
						oppLcd.html('--:--');
					}
				}
			} else {
				// 多人对战模式（3人或4人）
				for (var oi = 0; oi < otherPlayers.length; oi++) {
					var opp = otherPlayers[oi];
					var oppId = opp['accountId'];
					var oppStatus = opp['status'] || 'READY';
					var oppLcd = $('#battle-lcd-' + oi);
					if (!oppLcd.length) continue;

					// 刷新对应对手的 ao5 和 ao12
					updatePlayerAvgStr($('#battle-avgstr-' + oi), oppId);

					if (oppStatus === 'SOLVING') {
						var now = Date.now();
						var elapsed = 0;
						if (liveTickMap[oppId]) {
							var delta = Math.min(3000, now - liveTickMap[oppId].recvAt);
							elapsed = liveTickMap[oppId].curTime + delta;
						} else if (playerSolvingStart[oppId]) {
							elapsed = now - playerSolvingStart[oppId];
						}
						oppLcd.html(kernel.pretty(Math.max(0, elapsed), true));
					} else if (oppStatus === 'INSPECT') {
						delete liveTickMap[oppId];
						oppLcd.html('15');
					} else if (oppStatus === 'SOLVED') {
						delete liveTickMap[oppId];
						var oppSolve = solveDict[oppId] && solveDict[oppId][curSolveId];
						var formattedOppRaw = formatSolveTime(oppSolve, true); // 大字：实际时间
						var oppRawMs = getSolveMillis(oppSolve);
						var oppMult = getPlayerMultiplier(oppId);
						var oppEffMs = (oppRawMs === -1) ? -1 : Math.round(oppRawMs * oppMult);
						var oppEffStr = (oppEffMs === -1) ? '(DNF)' : '(' + (oppEffMs / 1000).toFixed(2) + ')'; // 括号：乘以倍率之后的时间
						var oppColor = (oppId === bestAccId) ? '#008000' : '#f00'; // 第一名绿色，其余红色
						var diffHtml = '<div class="difflabel" style="color:' + oppColor + ';">' + oppEffStr + '</div>';
						oppLcd.html(formattedOppRaw + diffHtml);
					} else {
						delete liveTickMap[oppId];
						var lastSid = curSolveId - 1;
						var prevS = solveDict[oppId] && solveDict[oppId][lastSid];
						if (prevS) {
							var formattedPrev = formatSolveTime(prevS, true);
							var prevRawMs = getSolveMillis(prevS);
							var prevMult = getPlayerMultiplier(oppId);
							var prevEffMs = (prevRawMs === -1) ? -1 : Math.round(prevRawMs * prevMult);
							var prevEffStr = (prevEffMs === -1) ? '(DNF)' : '(' + (prevEffMs / 1000).toFixed(2) + ')';
							var sbWinner = (roomInfo.scoreboard && roomInfo.scoredSolveIds && roomInfo.scoredSolveIds[lastSid]) || null;
							var prevColor = (sbWinner === oppId) ? '#008000' : '#f00';
							var prevDiffHtml = '<div class="difflabel" style="color:' + prevColor + ';">' + prevEffStr + '</div>';
							oppLcd.html(formattedPrev + prevDiffHtml);
						} else {
							oppLcd.html('--:--');
						}
					}
				}
			}
		}

		function sync(info) {
			if (!info) {
				unmount();
				return;
			}
			mount();

			var tr = getTr();
			var timerTable = $('#timer');
			var players = info['players'] || [];
			var otherPlayers = [];
			for (var i = 0; i < players.length; i++) {
				if (players[i]['accountId'] !== compId) {
					otherPlayers.push(players[i]);
				}
			}

			timerTable.removeClass('players-3 players-4');

			if (otherPlayers.length <= 1) {
				// 1v1 对战
				$('td.battle-pane-multi').remove();
				if (!$('#battle-opp-container').length) {
					var oppTd = $('<td id="battle-opp-container" class="battle-pane-right battle-pane-opp">' +
						'<div id="battle-opp-score-group" class="battle-score-group">' +
						'<div class="battle-score-box small-score" id="battle-opp-small" title="小比分">0</div>' +
						'<div class="battle-score-box big-score" id="battle-opp-big" title="大比分">0</div>' +
						'</div>' +
						'<div id="battle-opp-lcd">--:--</div>' +
						'<div id="battle-opp-avgstr" class="battle-opp-avgstr"><span>ao5: -</span><br><span>ao12: -</span></div>' +
						'</td>');
					tr.append(oppTd);
				}
				if (!$('#battle-self-score-group').length) {
					$('#container').prepend('<div id="battle-self-score-group" class="battle-score-group">' +
						'<div class="battle-score-box big-score" id="battle-self-big" title="大比分">0</div>' +
						'<div class="battle-score-box small-score" id="battle-self-small" title="小比分">0</div>' +
						'</div>');
				}
				$('#battle-opp-container').show();
			} else {
				// 3人或4人多人对战：从左到右三个人，每个显示 [大比分] [小比分]
				$('#battle-opp-container').remove();
				$('td.battle-pane-multi').remove();
				var colCount = Math.min(4, players.length);
				timerTable.addClass('players-' + colCount);

				if (!$('#battle-self-score-group').length) {
					$('#container').prepend('<div id="battle-self-score-group" class="battle-score-group">' +
						'<div class="battle-score-box big-score" id="battle-self-big" title="大比分">0</div>' +
						'<div class="battle-score-box small-score" id="battle-self-small" title="小比分">0</div>' +
						'</div>');
				}

				for (var oi = 0; oi < otherPlayers.length; oi++) {
					var multiTd = $('<td class="battle-pane-right battle-pane-opp battle-pane-multi" id="battle-container-' + oi + '">' +
						'<div class="battle-score-group" id="battle-score-group-' + oi + '">' +
						'<div class="battle-score-box big-score" id="battle-big-' + oi + '" title="大比分">0</div>' +
						'<div class="battle-score-box small-score" id="battle-small-' + oi + '" title="小比分">0</div>' +
						'</div>' +
						'<div id="battle-lcd-' + oi + '">--:--</div>' +
						'<div class="battle-opp-avgstr" id="battle-avgstr-' + oi + '"><span>ao5: -</span><br><span>ao12: -</span></div>' +
						'</td>');
					tr.append(multiTd);
				}
			}

			syncTimerStyles();
			renderLiveOpponents();
		}

		return {
			mount: mount,
			unmount: unmount,
			sync: sync,
			onLiveTick: onLiveTick,
			startLocalBroadcast: startLocalBroadcast,
			stopLocalBroadcast: stopLocalBroadcast
		};
	})();

	function procSignal(signal, value) {
		if (!isInit && !roomInfo) {
			return;
		}
		if (signal == 'export') {
			updateAccountDiv();
			return;
		}
		if (signal == 'timerStatus') {
			var status = null;
			if (value > 0) {
				status = 'SOLVING';
			} else if (value < -2) {
				status = 'INSPECT';
			}
			if (status && status != lastStatus) {
				lastStatus = status;
				submitStatus(status);
				if (arena) {
					if (status === 'SOLVING') {
						arena.startLocalBroadcast();
					} else {
						arena.stopLocalBroadcast();
					}
					if (roomInfo) arena.sync(roomInfo);
				}
			} else if (value === 0) {
				lastStatus = 'READY';
				if (arena) arena.stopLocalBroadcast();
			}
			return;
		}
		value = JSON.parse(JSON.stringify(value));
		if (signal == 'timestd') {
			if (arena) arena.stopLocalBroadcast();
			submitSolve(value, false);
			if (arena && roomInfo) arena.sync(roomInfo);
		} else if (signal == 'timepnt') {
			if (arena) arena.stopLocalBroadcast();
			submitSolve(value, true);
			if (arena && roomInfo) arena.sync(roomInfo);
		}
	}

	function getScrambles() {
		if (!roomInfo) {
			return Promise.reject();
		}
		var curScr = roomInfo['cur'][1];
		if (curScr && curScr !== localLastSolve[1]) {
			// 有新打乱，立即返回
			return Promise.resolve(['$T333$' + curScr]);
		}
		// 等待房主推送新打乱
		scrResolve = null; // 清除旧的 resolve 防止重复触发
		return new Promise(function(resolve) {
			scrResolve = resolve;
		});
	}

	$(function() {
		roomTable = $('<table class="table">');
		tools.regTool('battle', TOOLS_BATTLE, execFunc);
		kernel.regListener('battle', 'timestd', procSignal);
		kernel.regListener('battle', 'timepnt', procSignal);
		kernel.regListener('battle', 'timerStatus', procSignal);
		kernel.regListener('battle', 'export', procSignal, /^account$/);
		window.addEventListener('hashchange', checkHashForOffer);
		checkHashForOffer();
	});

	return {
		getScrambles: getScrambles,
		arena: arena
	};
});
