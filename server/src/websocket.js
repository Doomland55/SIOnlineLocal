'use strict';

/**
 * Minimal WebSocket server (RFC 6455) built on node:http upgrade events.
 *
 * Supports text/binary frames, fragmentation, ping/pong and close frames.
 * Client-to-server frames are masked as required by the RFC; server frames
 * are sent unmasked. No permessage-deflate: browsers happily fall back to
 * uncompressed frames when the server does not offer the extension.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const MAX_FRAME_PAYLOAD = 32 * 1024 * 1024; // 32 MB, messages in this game are small

/** Frame level tracing, enabled with SIGAME_DEBUG_WS=1. */
function debugWs(...args) {
	if (process.env.SIGAME_DEBUG_WS) {
		console.log('[ws]', ...args);
	}
}

function computeAcceptKey(key) {
	return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
	const length = payload.length;
	let header;

	if (length < 126) {
		header = Buffer.alloc(2);
		header[1] = length;
	} else if (length <= 0xffff) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}

	header[0] = 0x80 | opcode; // FIN + opcode
	return Buffer.concat([header, payload]);
}

class WebSocketConnection extends EventEmitter {
	constructor(socket) {
		super();
		this.socket = socket;
		this.buffer = Buffer.alloc(0);
		this.fragments = [];
		this.fragmentOpcode = -1;
		this.closed = false;

		socket.on('data', chunk => this.onData(chunk));
		socket.on('close', () => {
			debugWs('socket close');
			this.handleClose();
		});
		socket.on('end', () => debugWs('socket end'));
		socket.on('error', err => {
			debugWs('socket error', err.message);
			this.emit('error', err);
		});
	}

	onData(chunk) {
		debugWs('raw', chunk.length, 'bytes:', chunk.toString('hex'));
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

		for (;;) {
			let frame;

			try {
				frame = this.tryParseFrame();
			} catch (error) {
				debugWs('parse error:', error.message, 'buffer:', this.buffer.toString('hex'));
				this.fail(1002, 'Bad frame');
				return;
			}

			if (!frame) {
				debugWs('incomplete frame, buffered', this.buffer.length, 'bytes');
				return;
			}

			debugWs('frame opcode=', frame.opcode, 'fin=', frame.fin, 'len=', frame.payload.length);

			this.handleFrame(frame);
			if (this.closed) {
				return;
			}
		}
	}

	tryParseFrame() {
		const buffer = this.buffer;

		if (buffer.length < 2) {
			return null;
		}

		const fin = (buffer[0] & 0x80) !== 0;
		const opcode = buffer[0] & 0x0f;
		const masked = (buffer[1] & 0x80) !== 0;
		let payloadLength = buffer[1] & 0x7f;
		let offset = 2;

		if (payloadLength === 126) {
			if (buffer.length < 4) {
				return null;
			}
			payloadLength = buffer.readUInt16BE(2);
			offset = 4;
		} else if (payloadLength === 127) {
			if (buffer.length < 10) {
				return null;
			}
			const bigLength = buffer.readBigUInt64BE(2);
			if (bigLength > BigInt(MAX_FRAME_PAYLOAD)) {
				this.fail(1009, 'Frame too large');
				return null;
			}
			payloadLength = Number(bigLength);
			offset = 10;
		}

		if (payloadLength > MAX_FRAME_PAYLOAD) {
			this.fail(1009, 'Frame too large');
			return null;
		}

		let maskKey = null;
		if (masked) {
			if (buffer.length < offset + 4) {
				return null;
			}
			maskKey = buffer.subarray(offset, offset + 4);
			offset += 4;
		}

		if (buffer.length < offset + payloadLength) {
			return null;
		}

		let payload = buffer.subarray(offset, offset + payloadLength);
		this.buffer = buffer.subarray(offset + payloadLength);

		if (maskKey) {
			const unmasked = Buffer.alloc(payloadLength);
			for (let i = 0; i < payloadLength; i++) {
				unmasked[i] = payload[i] ^ maskKey[i % 4];
			}
			payload = unmasked;
		}

		return { fin, opcode, payload: Buffer.from(payload) };
	}

	handleFrame({ fin, opcode, payload }) {
		switch (opcode) {
			case OP_CLOSE: {
				const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
				const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
				this.sendClose(code, reason);
				this.handleClose();
				return;
			}

			case OP_PING:
				this.sendFrame(OP_PONG, payload);
				return;

			case OP_PONG:
				return;

			case OP_TEXT:
			case OP_BINARY:
				if (fin) {
					this.emitMessage(opcode, payload);
				} else {
					this.fragments = [payload];
					this.fragmentOpcode = opcode;
				}
				return;

			case OP_CONTINUATION:
				this.fragments.push(payload);
				if (fin) {
					const full = Buffer.concat(this.fragments);
					const messageOpcode = this.fragmentOpcode;
					this.fragments = [];
					this.fragmentOpcode = -1;
					this.emitMessage(messageOpcode, full);
				}
				return;

			default:
				this.fail(1002, 'Unknown opcode');
		}
	}

	emitMessage(opcode, payload) {
		if (opcode === OP_TEXT) {
			this.emit('message', payload.toString('utf8'), false);
		} else {
			this.emit('message', payload, true);
		}
	}

	sendFrame(opcode, payload) {
		if (this.closed || this.socket.destroyed) {
			return;
		}

		try {
			this.socket.write(encodeFrame(opcode, payload));
		} catch {
			// Socket is going away; close handling will clean up.
		}
	}

	send(data, isBinary = true) {
		if (typeof data === 'string') {
			this.sendFrame(OP_TEXT, Buffer.from(data, 'utf8'));
		} else {
			this.sendFrame(isBinary ? OP_BINARY : OP_TEXT, Buffer.isBuffer(data) ? data : Buffer.from(data));
		}
	}

	ping() {
		this.sendFrame(OP_PING, Buffer.alloc(0));
	}

	sendClose(code = 1000, reason = '') {
		if (this.closed) {
			return;
		}

		debugWs('send close', code, reason);

		const reasonBuffer = Buffer.from(reason, 'utf8');
		const payload = Buffer.alloc(2 + reasonBuffer.length);
		payload.writeUInt16BE(code, 0);
		reasonBuffer.copy(payload, 2);
		this.sendFrame(OP_CLOSE, payload);
	}

	close(code = 1000, reason = '') {
		debugWs('server close', code, reason);
		this.sendClose(code, reason);
		this.socket.end();
		this.handleClose();
	}

	fail(code, reason) {
		debugWs('fail', code, reason);
		this.sendClose(code, reason);
		this.socket.destroy();
		this.handleClose();
	}

	handleClose() {
		if (this.closed) {
			return;
		}

		this.closed = true;
		this.emit('close');
	}
}

/**
 * Attaches WebSocket upgrade handling to an HTTP server.
 * Calls `onConnection(connection, request)` for every upgraded socket.
 */
function attachWebSocketServer(server, onConnection) {
	server.on('upgrade', (request, socket, head) => {
		const key = request.headers['sec-websocket-key'];

		if (!key || (request.headers.upgrade || '').toLowerCase() !== 'websocket') {
			socket.destroy();
			return;
		}

		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
			'Upgrade: websocket\r\n' +
			'Connection: Upgrade\r\n' +
			`Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n` +
			'\r\n'
		);

		const connection = new WebSocketConnection(socket);
		if (head && head.length > 0) {
			connection.onData(head);
		}

		onConnection(connection, request);
	});
}

module.exports = { attachWebSocketServer, WebSocketConnection, computeAcceptKey };
