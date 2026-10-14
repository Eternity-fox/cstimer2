/**
 * Lightweight QRCode Generator for csTimer P2P Battle
 * Supports 8-bit byte mode, Error Correction Level L/M, Versions 1-14.
 */
var QRCode = (function() {
	"use strict";

	var PAD0 = 0xEC;
	var PAD1 = 0x11;

	var EXP_TABLE = new Array(256);
	var LOG_TABLE = new Array(256);
	for (var i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
	for (var i = 8; i < 256; i++) EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
	for (var i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;

	function glog(n) {
		if (n < 1) throw new Error("glog(" + n + ")");
		return LOG_TABLE[n];
	}
	function gexp(n) {
		while (n < 0) n += 255;
		while (n >= 255) n -= 255;
		return EXP_TABLE[n];
	}

	function Polynomial(num, shift) {
		var offset = 0;
		while (offset < num.length && num[offset] == 0) offset++;
		this.num = new Array(num.length - offset + shift);
		for (var i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
		for (var i = num.length - offset; i < this.num.length; i++) this.num[i] = 0;
	}
	Polynomial.prototype = {
		get: function(index) { return this.num[index]; },
		getLength: function() { return this.num.length; },
		multiply: function(e) {
			var num = new Array(this.getLength() + e.getLength() - 1);
			for (var i = 0; i < num.length; i++) num[i] = 0;
			for (var i = 0; i < this.getLength(); i++) {
				for (var j = 0; j < e.getLength(); j++) {
					num[i + j] ^= gexp(glog(this.get(i)) + glog(e.get(j)));
				}
			}
			return new Polynomial(num, 0);
		},
		mod: function(e) {
			if (this.getLength() - e.getLength() < 0) return this;
			var ratio = glog(this.get(0)) - glog(e.get(0));
			var num = new Array(this.getLength());
			for (var i = 0; i < this.getLength(); i++) num[i] = this.get(i);
			for (var i = 0; i < e.getLength(); i++) {
				num[i] ^= gexp(glog(e.get(i)) + ratio);
			}
			return new Polynomial(num, 0).mod(e);
		}
	};

	var RS_BLOCK_TABLE = [
		// [L: count, totalWords, dataWords]
		[1, 26, 19], [1, 44, 34], [1, 70, 55], [1, 100, 80],
		[1, 134, 108], [2, 86, 68], [2, 98, 78], [2, 121, 97],
		[2, 146, 116], [2, 86, 68, 2, 87, 69], [4, 101, 81], [2, 116, 92, 2, 117, 93],
		[4, 133, 107], [3, 145, 115, 1, 146, 116], [5, 109, 87, 1, 110, 88], [5, 122, 98, 1, 123, 99],
		[1, 135, 107, 5, 136, 108], [5, 150, 120, 1, 151, 121], [3, 141, 113, 4, 142, 114], [3, 135, 107, 5, 136, 108]
	];

	var PATTERN_POSITION_TABLE = [
		[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
		[6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
		[6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74],
		[6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]
	];

	function getRSBlocks(version) {
		var list = RS_BLOCK_TABLE[version - 1];
		var blocks = [];
		for (var i = 0; i < list.length; i += 3) {
			var count = list[i], total = list[i + 1], data = list[i + 2];
			for (var j = 0; j < count; j++) {
				blocks.push({ totalCount: total, dataCount: data });
			}
		}
		return blocks;
	}

	function BitBuffer() {
		this.buffer = [];
		this.length = 0;
	}
	BitBuffer.prototype = {
		get: function(index) {
			var bufIndex = Math.floor(index / 8);
			return ((this.buffer[bufIndex] >>> (7 - index % 8)) & 1) == 1;
		},
		put: function(num, length) {
			for (var i = 0; i < length; i++) {
				this.putBit(((num >>> (length - i - 1)) & 1) == 1);
			}
		},
		putBit: function(bit) {
			var bufIndex = Math.floor(this.length / 8);
			if (this.buffer.length <= bufIndex) this.buffer.push(0);
			if (bit) this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
			this.length++;
		}
	};

	function createData(version, dataStr) {
		var rsBlocks = getRSBlocks(version);
		var buffer = new BitBuffer();
		buffer.put(4, 4); // 8-bit byte mode
		var bytes = [];
		for (var i = 0; i < dataStr.length; i++) {
			var c = dataStr.charCodeAt(i);
			if (c < 128) bytes.push(c);
			else if (c < 2048) { bytes.push((c >> 6) | 192); bytes.push((c & 63) | 128); }
			else { bytes.push((c >> 12) | 224); bytes.push(((c >> 6) & 63) | 128); bytes.push((c & 63) | 128); }
		}
		buffer.put(bytes.length, version < 10 ? 8 : 16);
		for (var i = 0; i < bytes.length; i++) buffer.put(bytes[i], 8);

		var totalDataCount = 0;
		for (var i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount;
		if (buffer.length + 4 <= totalDataCount * 8) buffer.put(0, 4);
		while (buffer.length % 8 != 0) buffer.putBit(false);
		while (buffer.length < totalDataCount * 8) {
			buffer.put(PAD0, 8);
			if (buffer.length >= totalDataCount * 8) break;
			buffer.put(PAD1, 8);
		}

		var offset = 0;
		var dcdata = [];
		var ecdata = [];
		for (var r = 0; r < rsBlocks.length; r++) {
			var dcCount = rsBlocks[r].dataCount;
			var ecCount = rsBlocks[r].totalCount - dcCount;
			var raw = [];
			for (var i = 0; i < dcCount; i++) raw.push(buffer.buffer[offset + i]);
			offset += dcCount;

			// RS error correction
			var rsPoly = new Polynomial([1], 0);
			for (var i = 0; i < ecCount; i++) {
				rsPoly = rsPoly.multiply(new Polynomial([1, gexp(i)], 0));
			}
			var modPoly = new Polynomial(raw, ecCount).mod(rsPoly);
			var ec = new Array(ecCount);
			for (var i = 0; i < ecCount; i++) {
				var modIndex = i + modPoly.getLength() - ecCount;
				ec[i] = (modIndex >= 0) ? modPoly.get(modIndex) : 0;
			}
			dcdata.push(raw);
			ecdata.push(ec);
		}

		var finalData = [];
		var maxDc = 0, maxEc = 0;
		for (var r = 0; r < rsBlocks.length; r++) {
			maxDc = Math.max(maxDc, dcdata[r].length);
			maxEc = Math.max(maxEc, ecdata[r].length);
		}
		for (var i = 0; i < maxDc; i++) {
			for (var r = 0; r < rsBlocks.length; r++) {
				if (i < dcdata[r].length) finalData.push(dcdata[r][i]);
			}
		}
		for (var i = 0; i < maxEc; i++) {
			for (var r = 0; r < rsBlocks.length; r++) {
				if (i < ecdata[r].length) finalData.push(ecdata[r][i]);
			}
		}
		return finalData;
	}

	function QRCodeModel(version) {
		this.version = version;
		this.moduleCount = version * 4 + 17;
		this.modules = null;
	}
	QRCodeModel.prototype = {
		isDark: function(row, col) { return this.modules[row][col]; },
		make: function(dataStr) {
			this.modules = new Array(this.moduleCount);
			for (var r = 0; r < this.moduleCount; r++) {
				this.modules[r] = new Array(this.moduleCount);
				for (var c = 0; c < this.moduleCount; c++) this.modules[r][c] = null;
			}
			this.setupPositionProbePattern(0, 0);
			this.setupPositionProbePattern(this.moduleCount - 7, 0);
			this.setupPositionProbePattern(0, this.moduleCount - 7);
			this.setupTimingPattern();
			this.setupPositionAdjustPattern();
			var data = createData(this.version, dataStr);
			this.mapData(data, 0);
		},
		setupPositionProbePattern: function(row, col) {
			for (var r = -1; r <= 7; r++) {
				if (row + r < 0 || this.moduleCount <= row + r) continue;
				for (var c = -1; c <= 7; c++) {
					if (col + c < 0 || this.moduleCount <= col + c) continue;
					if ((0 <= r && r <= 6 && (c == 0 || c == 6)) ||
						(0 <= c && c <= 6 && (r == 0 || r == 6)) ||
						(2 <= r && r <= 4 && 2 <= c && c <= 4)) {
						this.modules[row + r][col + c] = true;
					} else {
						this.modules[row + r][col + c] = false;
					}
				}
			}
		},
		setupTimingPattern: function() {
			for (var r = 8; r < this.moduleCount - 8; r++) {
				if (this.modules[r][6] != null) continue;
				this.modules[r][6] = (r % 2 == 0);
			}
			for (var c = 8; c < this.moduleCount - 8; c++) {
				if (this.modules[6][c] != null) continue;
				this.modules[6][c] = (c % 2 == 0);
			}
		},
		setupPositionAdjustPattern: function() {
			var pos = PATTERN_POSITION_TABLE[this.version - 1];
			for (var i = 0; i < pos.length; i++) {
				for (var j = 0; j < pos.length; j++) {
					var row = pos[i], col = pos[j];
					if (this.modules[row][col] != null) continue;
					for (var r = -2; r <= 2; r++) {
						for (var c = -2; c <= 2; c++) {
							if (r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0)) {
								this.modules[row + r][col + c] = true;
							} else {
								this.modules[row + r][col + c] = false;
							}
						}
					}
				}
			}
		},
		mapData: function(data, maskPattern) {
			var inc = -1, row = this.moduleCount - 1, bitIndex = 7, byteIndex = 0;
			for (var col = this.moduleCount - 1; col > 0; col -= 2) {
				if (col == 6) col--;
				while (true) {
					for (var c = 0; c < 2; c++) {
						if (this.modules[row][col - c] == null) {
							var dark = false;
							if (byteIndex < data.length) {
								dark = (((data[byteIndex] >>> bitIndex) & 1) == 1);
							}
							var mask = ((row + col - c) % 2 == 0);
							this.modules[row][col - c] = mask ? !dark : dark;
							bitIndex--;
							if (bitIndex == -1) { byteIndex++; bitIndex = 7; }
						}
					}
					row += inc;
					if (row < 0 || this.moduleCount <= row) {
						row -= inc;
						inc = -inc;
						break;
					}
				}
			}
		}
	};

	function drawToCanvas(canvas, text, size) {
		size = size || 200;
		// Determine minimum version
		var bytesLen = 0;
		for (var i = 0; i < text.length; i++) {
			var code = text.charCodeAt(i);
			bytesLen += (code < 128) ? 1 : (code < 2048 ? 2 : 3);
		}
		var version = 1;
		for (var v = 1; v <= 20; v++) {
			var rs = getRSBlocks(v);
			var cap = 0;
			for (var i = 0; i < rs.length; i++) cap += rs[i].dataCount;
			if (cap >= bytesLen + (v < 10 ? 2 : 3)) {
				version = v;
				break;
			}
		}
		var qr = new QRCodeModel(version);
		qr.make(text);
		canvas.width = size;
		canvas.height = size;
		var ctx = canvas.getContext('2d');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, size, size);
		ctx.fillStyle = '#000000';
		var count = qr.moduleCount;
		var cellSize = size / count;
		for (var r = 0; r < count; r++) {
			for (var c = 0; c < count; c++) {
				if (qr.isDark(r, c)) {
					ctx.fillRect(c * cellSize, r * cellSize, Math.ceil(cellSize), Math.ceil(cellSize));
				}
			}
		}
	}

	return {
		draw: drawToCanvas
	};
})();
