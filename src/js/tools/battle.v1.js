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

	// ==================== WebRTC Configuration & Utilities ====================
	var RTC_SERVERS = {
		iceServers: [
			{ urls: 'stun:stun.l.google.com:19302' },
			{ urls: 'stun:stun1.l.google.com:19302' },
			{ urls: 'stun:stun.cloudflare.com:3478' }
		]
	};

	function createPeerConnection() {
		var RTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
		if (!RTCPC) {
			alert('当前浏览器不支持 WebRTC，无法进行 P2P 直连对战！');
			return null;
		}
		return new RTCPC(RTC_SERVERS);
	}

	function waitIceGathering(pc, timeoutMs) {
		timeoutMs = timeoutMs || 1000;
		return new Promise(function(resolve) {
			if (pc.iceGatheringState === 'complete') {
				resolve();
				return;
			}
			var timer = null;
			function done() {
				if (timer) {
					clearTimeout(timer);
					timer = null;
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
				}
			};
			pc.addEventListener('icegatheringstatechange', onStateChange);
			timer = setTimeout(done, timeoutMs);
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

	// ==================== Official WebSocket Connection ====================
	var wsConn = (function() {
		var socket;
		var isOpen = false;
		var idseq = 1;
		var waitList = {};
		var TIMEOUT = 5000;
		var callback = null;
		var toResolves = [];

		function connect() {
			if (isOpen) {
				return Promise.resolve();
			}
			return new Promise(function(resolve) {
				toResolves.push(resolve);
				socket = new WebSocket('wss://cstimer.net/ws20230409');
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
				socket.onerror = function() {
					isOpen = false;
					callback && callback('error');
				};
				socket.onmessage = function(e) {
					var msg = JSON.parse(e.data);
					var msgid = msg['msgid'];
					if (msgid in waitList) {
						var res = waitList[msgid];
						delete waitList[msgid];
						res(msg);
					} else {
						callback && callback('msg', msg);
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
			players: {},    // accountId -> { accountId, elo, status, isHost }
			solves: [],     // [ { accountId, solveId, time, soltime } ]
			clients: [],    // [ { id, pc, dc, accountId } ]
			autoNext: true,
			nextTimer: null
		};

		function init(rId, hostAccId) {
			state.roomId = rId;
			state.curSolveId = 1;
			state.curScramble = (window.scramble_333 ? scramble_333.getRandomScramble().trim() : "R U R' U'");
			state.lastScramble = '';
			state.players = {};
			state.solves = [];
			closeAllClients();
			state.clients = [];
			state.players[hostAccId] = {
				accountId: hostAccId,
				elo: 1500,
				status: 'READY',
				isHost: true
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
				solves: state.solves.slice()
			};
			for (var key in state.players) {
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
			var action = msg['action'];
			var accId = msg['accountId'];
			if (action === 'joinRoom') {
				state.players[accId] = {
					accountId: accId,
					elo: 1500,
					status: 'READY',
					isHost: false
				};
				clientObj.accountId = accId;
				if (msg.msgid) {
					clientObj.dc.send(JSON.stringify({ msgid: msg.msgid, ret: 0 }));
				}
				broadcast();
			} else if (action === 'updateStatus') {
				if (state.players[accId]) {
					state.players[accId].status = msg.status;
				}
				if (msg.msgid) {
					clientObj.dc.send(JSON.stringify({ msgid: msg.msgid, ret: 0 }));
				}
				broadcast();
			} else if (action === 'uploadSolve') {
				if (state.players[accId]) {
					state.players[accId].status = 'SOLVED';
					var soltime = msg.time[0][1];
					state.solves.push({
						accountId: accId,
						solveId: msg.solveId,
						time: msg.time,
						soltime: soltime
					});
				}
				if (msg.msgid) {
					clientObj.dc.send(JSON.stringify({ msgid: msg.msgid, ret: 0 }));
				}
				broadcast();
				checkAutoAdvance();
			} else if (action === 'leaveRoom') {
				if (state.players[accId]) {
					state.players[accId].status = 'LOSS';
				}
				if (msg.msgid) {
					clientObj.dc.send(JSON.stringify({ msgid: msg.msgid, ret: 0 }));
				}
				broadcast();
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

		function hostUpdateStatus(accId, status) {
			if (state.players[accId]) {
				state.players[accId].status = status;
				broadcast();
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

		function checkAutoAdvance() {
			if (!state.autoNext) return;
			var allSolved = true;
			var count = 0;
			for (var key in state.players) {
				count++;
				if (state.players[key].status !== 'SOLVED') {
					allSolved = false;
					break;
				}
			}
			if (allSolved && count > 0) {
				if (state.nextTimer) clearTimeout(state.nextTimer);
				state.nextTimer = setTimeout(function() {
					advanceRound();
				}, 2000);
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
			updateScore();
			state.curSolveId++;
			state.lastScramble = state.curScramble;
			state.curScramble = (window.scramble_333 ? scramble_333.getRandomScramble().trim() : "R U R' U'");
			for (var key in state.players) {
				if (state.players[key].status !== 'LOSS') {
					state.players[key].status = 'READY';
				}
			}
			broadcast();
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
			setAutoNext: function(val) { state.autoNext = !!val; },
			getAutoNext: function() { return state.autoNext; },
			getClientsCount: function() { return state.clients.length; }
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
			dc.onopen = function() {
				isOpen = true;
				logohint.push('P2P直连已打通！');
				connReady();
			};
			dc.onclose = function() {
				isOpen = false;
				callback && callback('close');
			};
			dc.onerror = function() {
				isOpen = false;
				callback && callback('error');
			};
			dc.onmessage = function(e) {
				var msg = JSON.parse(e.data);
				var msgid = msg['msgid'];
				if (msgid in waitList) {
					var res = waitList[msgid];
					delete waitList[msgid];
					res(msg);
				} else {
					callback && callback('msg', msg);
				}
			};
		}

		function connReady() {
			remoteCall({
				'action': 'joinRoom',
				'roomId': roomId,
				'accountId': compId,
				'scramble': scramble_333.getRandomScramble().trim()
			}).then(function(ret) {
				DEBUG && console.log('[battle client] joinRoom ret=', ret);
				kernel.hideDialog();
			});
		}

		function remoteCall(msg) {
			return new Promise(function(resolve, reject) {
				if (!isOpen || !dc) {
					reject(-1);
					return;
				}
				msg['msgid'] = idseq;
				waitList[idseq] = resolve;
				idseq++;
				dc.send(JSON.stringify(msg));
				setTimeout(function(rej) {
					rej(-2);
				}.bind(null, reject), TIMEOUT);
			});
		}

		function pushMsg(msg) {
			if (!isOpen || !dc) return -1;
			dc.send(JSON.stringify(msg));
			return 0;
		}

		function close() {
			if (dc) dc.close();
			if (pc) pc.close();
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
		answerSec.append(answerInput, btnAccept);

		modalDiv.append(
			'<div style="color: #4a90e2; font-weight: bold; margin-bottom: 8px;">👑 房主主机模式 (设备对设备直连)</div>',
			row1,
			'<div><b>步骤 1：复制邀请码或链接发给对手</b></div>',
			offerArea,
			$('<div></div>').append(btnCopyOffer, btnCopyLink),
			qrCanvas,
			answerSec
		);

		var currentHostPC = null;
		var currentHostDC = null;

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

				var pc = createPeerConnection();
				if (!pc) {
					offerArea.val('创建失败：当前浏览器不支持 WebRTC');
					return;
				}
				currentHostPC = pc;
				var dc = pc.createDataChannel('cstimer_battle', { ordered: true });
				currentHostDC = dc;

				offerArea.val('正在生成设备连接信息，请稍候...');
				var clientObj = { pc: pc, dc: dc, accountId: null };

				dc.onopen = function() {
					logohint.push('选手已成功接入！');
					kernel.hideDialog();
				};
				dc.onmessage = function(e) {
					try {
						var msg = JSON.parse(e.data);
						hostEngine.handleClientMessage(clientObj, msg);
					} catch (err) {}
				};
				dc.onclose = function() {
					hostEngine.handleClientDisconnect(clientObj);
				};

				hostEngine.addClient(clientObj);

				pc.createOffer().then(function(offer) {
					return pc.setLocalDescription(offer);
				}).then(function() {
					return waitIceGathering(pc, 1000);
				}).then(function() {
					var token = encodeToken({
						type: 'offer',
						sdp: pc.localDescription.sdp,
						roomId: roomId
					});
					offerArea.val(token);
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
				});
			} catch (err) {
				console.error('[Host generate error]', err);
				offerArea.val('生成异常: ' + err);
			}
		}

		btnGen.click(generateHostOffer);

		btnAccept.click(function() {
			if (!currentHostPC) {
				alert('请先生成邀请码！');
				return;
			}
			var ansToken = answerInput.val().trim();
			var ansObj = decodeToken(ansToken);
			if (!ansObj || ansObj.type !== 'answer') {
				alert('确认码无效，请确保选手已正确生成并发送确认码！');
				return;
			}
			currentHostPC.setRemoteDescription(new RTCSessionDescription({
				type: 'answer',
				sdp: ansObj.sdp
			})).then(function() {
				logohint.push('已提交确认，正在打通直连通道...');
			}).catch(function(err) {
				alert('连接建立失败: ' + err);
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
		var tipWait = $('<div style="color: #f80; margin-top: 6px;">等待房主在主机端点击【接纳】后即可秒连对战...</div>');
		answerSec.append(answerArea, btnCopyAnswer, qrCanvas, tipWait);

		modalDiv.append(
			'<div style="color: #2e7d32; font-weight: bold; margin-bottom: 8px;">🎮 选手加入模式 (直连房主)</div>',
			'<div><b>步骤 1：粘贴房主的邀请码</b></div>',
			offerInput,
			btnGenAnswer,
			answerSec
		);

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

				var pc = createPeerConnection();
				if (!pc) {
					alert('当前浏览器不支持 WebRTC');
					return;
				}

				var receivedDC = null;
				pc.ondatachannel = function(e) {
					receivedDC = e.channel;
					clientConn.setup(pc, receivedDC);
				};

				btnGenAnswer.val('正在处理...');
				pc.setRemoteDescription(new RTCSessionDescription({
					type: 'offer',
					sdp: offerObj.sdp
				})).then(function() {
					return pc.createAnswer();
				}).then(function(answer) {
					return pc.setLocalDescription(answer);
				}).then(function() {
					return waitIceGathering(pc, 1000);
				}).then(function() {
					var token = encodeToken({
						type: 'answer',
						sdp: pc.localDescription.sdp
					});
					answerArea.val(token);
					answerSec.show();
					btnGenAnswer.val('生成确认码');

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

		kernel.showDialog([modalDiv, null, function() {
			// cancel
		}, function() {
			// close
		}], 'battleClient', '加入对战房间 (选手)', applyClientDialogLayout);
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
			'scramble': scramble_333.getRandomScramble().trim()
		}).then(function(ret) {
			DEBUG && console.log('[server battle] joinRoom ret=', ret);
		});
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
		compId = getMyAccountId();
		return compId;
	}

	function submitStatus(status) {
		if (!checkConnState(true) || !roomId) {
			return;
		}
		if (battleMode === 'p2p_host') {
			hostEngine.hostUpdateStatus(compId, status);
		} else {
			conn.remoteCall({
				'action': 'updateStatus',
				'roomId': roomId,
				'accountId': compId,
				'status': status
			});
		}
	}

	function submitSolve(time, isLast) {
		if (!checkConnState(true) || !roomId || !roomInfo) {
			return;
		}
		var solvScr = time[1];
		if (solvScr != roomInfo['cur'][1] && solvScr != roomInfo['last'][1]) {
			return;
		}
		if (localLastSolve && localLastSolve[1] == time[1] && (!isLast || time[0][1] != localLastSolve[0][1])) {
			return;
		}
		localLastSolve = time;
		var solveId = (solvScr == roomInfo['cur'][1]) ? roomInfo['cur'][0] : roomInfo['last'][0];

		if (battleMode === 'p2p_host') {
			hostEngine.hostUploadSolve(compId, solveId, time);
		} else {
			conn.remoteCall({
				'action': 'uploadSolve',
				'roomId': roomId,
				'accountId': compId,
				'solveId': solveId,
				'time': time,
				'scramble': scramble_333.getRandomScramble().trim()
			});
		}
	}

	function onNotify(event, obj) {
		if (event == 'msg') {
			if ('roomInfo' in obj) {
				roomInfo = obj['roomInfo'];
				onRoomInfo();
			}
		} else {
			roomInfo = null;
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
			}
			if (scrResolve) {
				scrResolve(['$T333$' + newScr]);
				scrResolve = null;
			} else {
				// 已有新打乱但 scrResolve 为空（scrType 还没切回 remoteBattle 时）
				// 强制推送新打乱让计时器刷新
				kernel.pushSignal('ctrl', ['scramble', 'next']);
			}
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
		var titles = TOOLS_BATTLE_TITLE.split('|').slice(0, 3);
		titles.splice(1, 0, '身份');

		if (!roomInfo) {
			// 未加入房间时的操作界面
			var headerTr = $('<tr>').append($('<td colspan=5 style="padding: 8px 4px; text-align: center;"></td>'));
			var btnHost = $('<input type="button" class="buttonOK" value="👑 创建房间 (作为主机)" style="font-weight: bold; margin-right: 8px; padding: 4px 10px;">');
			var btnClient = $('<input type="button" class="buttonOK" value="🎮 加入房间 (客户机)" style="font-weight: bold; margin-right: 8px; padding: 4px 10px;">');
			var btnServer = $('<span class="click" style="font-size: 0.85em; color: #888; text-decoration: underline;">[官方服务器模式]</span>');

			btnHost.click(showHostModal);
			btnClient.click(function() { showClientModal(); });
			btnServer.click(joinServerRoom);

			headerTr.find('td').append(btnHost, btnClient, $('<div style="margin-top: 6px;"></div>').append(btnServer));
			roomTable.append(headerTr);

			var infoText = '<b>设备对设备 P2P 直连</b>：房主作为主机掌控打乱与战局，选手直接与房主连接。<br>100% 离线免服务器，局域网极速 0 延迟！';
			roomTable.append('<tr><td colspan=5 style="width:0; padding: 10px 4px; color: #666; font-size: 0.85em; text-align: center;">' + infoText + '</td></tr>');
		} else {
			// 已在房间中的对战界面
			var isHost = (battleMode === 'p2p_host');
			var hostBadge = isHost ? '<span style="color:#f80;font-weight:bold;">[房主主机]</span> ' : (battleMode === 'server' ? '<span style="color:#4a90e2;">[服务器]</span> ' : '<span style="color:#2e7d32;">[客户机]</span> ');
			var headRow = $('<tr>').append($('<td colspan=5 style="padding: 6px 4px;"></td>'));
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

				hostCtrl.append(btnNextScr, btnInviteMore, chkAuto);
				headRow.find('td').append(hostCtrl);
			}

			roomTable.append(headRow);
			roomTable.append('<tr><td colspan=2>' + titles.join('</td><td>') + '</td></tr>');

			var players = roomInfo['players'] || [];
			var solves = roomInfo['solves'] || [];
			var solveDict = {};
			var hasSolved = false;
			var statusMap = ('???|' + TOOLS_BATTLE_STATUS).split('|');

			for (var i = 0; i < solves.length; i++) {
				var solveObj = solves[i];
				var accountId = solveObj['accountId'];
				solveDict[accountId] = solveDict[accountId] || {};
				solveDict[accountId][solveObj['solveId']] = [solveObj['time'], solveObj['soltime']];
				if (solveObj['solveId'] == roomInfo['cur'][0]) {
					hasSolved = true;
				}
			}

			var curSolveId = roomInfo['cur'][0];
			for (var i = 0; i < players.length; i++) {
				var player = players[i];
				var rawAccId = player['accountId'] || '';
				var account = rawAccId || '匿名';
				var roleText = player['isHost'] ? '<span style="color:#f80;">房主</span>' : '选手';
				if (typeof account === 'string') {
					if (account.indexOf('|') != -1) {
						account = '<b>' + account.split('|')[1] + '</b>';
					} else if (account.length > 10) {
						account = account.slice(0, 4) + '...' + account.slice(account.length - 3);
					}
				}
				var playerSolves = solveDict[rawAccId] || {};
				var isSolved = player['status'] === 'SOLVED';
				// 优先显示当前轮成绩（已完成），否则向前找最近一把历史成绩
				var displayTime = null;
				if (isSolved && playerSolves[curSolveId]) {
					displayTime = playerSolves[curSolveId];
				} else {
					for (var sid = curSolveId - 1; sid >= 1; sid--) {
						if (playerSolves[sid]) {
							displayTime = playerSolves[sid];
							break;
						}
					}
				}
				var lastTimeStr = displayTime ? stats.pretty(displayTime[0][0], true) : 'N/A';
				if (hasSolved && !isSolved) {
					lastTimeStr = '<span style="color:#888">' + lastTimeStr + '</span>';
				}
				roomTable.append('<tr><td>' + (i + 1) + '</td><td>' + account +
					'</td><td>' + roleText +
					'</td><td>' + statusMap[['READY', 'INSPECT', 'SOLVING', 'SOLVED', 'LOSS'].indexOf(player['status']) + 1] +
					'</td><td>' + lastTimeStr + '</td></tr>');
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
			var token = hash.split('=')[1];
			if (token) {
				showClientModal(token);
			}
		}
	}

	function procSignal(signal, value) {
		if (!isInit) {
			return;
		}
		if (signal == 'export') {
			updateAccountDiv();
			return;
		}
		if (signal == 'timerStatus') {
			var status = 'READY';
			if (value > 0) {
				status = 'SOLVING';
			} else if (value < -2) {
				status = 'INSPECT';
			}
			if (status != lastStatus) {
				lastStatus = status;
				submitStatus(status);
			}
			return;
		}
		value = JSON.parse(JSON.stringify(value));
		if (signal == 'timestd') {
			submitSolve(value, false);
		} else if (signal == 'timepnt') {
			submitSolve(value, true);
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
	});

	return {
		getScrambles: getScrambles
	};
});
