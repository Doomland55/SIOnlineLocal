'use strict';

/**
 * Minimal SignalR hub server speaking the MessagePack hub protocol,
 * compatible with the browser client (@microsoft/signalr +
 * @microsoft/signalr-protocol-msgpack used by SIOnline).
 *
 * Wire format (SignalR MessagePack protocol):
 *   - HTTP POST {hub}/negotiate -> JSON with connectionId + transports
 *   - WebSocket GET {hub}/connect?connectionId=... -> binary frames
 *   - Every hub message is framed as: varint length + MessagePack payload
 *   - Message types: 1 Invocation, 2 StreamItem, 3 Completion,
 *     4 StreamInvocation, 5 CancelInvocation, 6 Ping, 7 Close
 *   - Since SignalR 7 the MessagePack protocol carries a headers map as the
 *     second array element of every message:
 *     [1, headers, invocationId, target, arguments],
 *     [3, headers, invocationId, resultKind, resultOrError],
 *     where resultKind is 1 (error), 2 (void) or 3 (non-void).
 *
 * Only the WebSockets transport is offered: it is the only transport that
 * works reliably on a LAN (no long-polling/SSE fallbacks, no CORS issues
 * when the client is served from the same origin).
 */

const crypto = require('crypto');
const { encodeValue, decodeValue } = require('./msgpack');

const MESSAGE_INVOCATION = 1;
const MESSAGE_STREAM_ITEM = 2;
const MESSAGE_COMPLETION = 3;
const MESSAGE_STREAM_INVOCATION = 4;
const MESSAGE_CANCEL_INVOCATION = 5;
const MESSAGE_PING = 6;
const MESSAGE_CLOSE = 7;

const RESULT_ERROR = 1;
const RESULT_VOID = 2;
const RESULT_VALUE = 3;

/**
 * Reads an invocation in both wire formats: with a headers map (SignalR >= 7)
 * and without it (older clients: [type, invocationId, target, args]).
 */
function readInvocation(message) {
	if (message.length > 1 && message[1] !== null && typeof message[1] === 'object' && !Array.isArray(message[1])) {
		return {
			invocationId: message[2] === undefined ? null : message[2],
			target: message[3],
			args: message[4] || [],
		};
	}

	return {
		invocationId: message[1] === undefined ? null : message[1],
		target: message[2],
		args: message[3] || [],
	};
}

const PING_INTERVAL_MS = 10000;

function encodeVarint(value) {
	const bytes = [];
	let remaining = value;

	do {
		let byte = remaining & 0x7f;
		remaining = Math.floor(remaining / 128);
		if (remaining > 0) {
			byte |= 0x80;
		}
		bytes.push(byte);
	} while (remaining > 0);

	return Buffer.from(bytes);
}

function decodeVarint(buffer, offset) {
	let result = 0;
	let shift = 0;
	let position = offset;

	for (;;) {
		if (position >= buffer.length) {
			throw new Error('Unexpected end of SignalR frame');
		}

		const byte = buffer[position++];
		result += (byte & 0x7f) * (2 ** shift);
		shift += 7;

		if ((byte & 0x80) === 0) {
			break;
		}
	}

	return { value: result, bytesRead: position - offset };
}

function frameMessage(message) {
	const payload = encodeValue(message);
	return Buffer.concat([encodeVarint(payload.length), payload]);
}

/** Splits a WebSocket binary payload into decoded hub messages. */
function parseMessages(buffer) {
	const messages = [];
	let offset = 0;

	while (offset < buffer.length) {
		const { value: length, bytesRead } = decodeVarint(buffer, offset);
		offset += bytesRead;

		if (offset + length > buffer.length) {
			throw new Error('Incomplete SignalR frame');
		}

		const { value } = decodeValue(buffer.subarray(offset, offset + length));
		offset += length;
		messages.push(value);
	}

	return messages;
}

function newConnectionId() {
	return crypto.randomBytes(16).toString('base64url');
}

/**
 * A single SignalR hub connection bound to a WebSocket.
 */
class HubConnection {
	constructor(connectionId, ws, hubName, onInvoke, onClose, request) {
		this.id = connectionId;
		this.ws = ws;
		this.hubName = hubName;
		this.onInvoke = onInvoke;
		this.onCloseCallback = onClose;
		this.request = request || { headers: {} };
		this.handshakeDone = false;
		this.hubProtocol = null;
		this.closed = false;

		ws.on('message', (data, isBinary) => this.onData(data, isBinary));
		ws.on('close', () => this.handleClose());
		ws.on('error', () => this.handleClose());

		this.pingTimer = setInterval(() => {
			if (!this.closed) {
				this.sendRaw([MESSAGE_PING]);
			}
		}, PING_INTERVAL_MS);
		this.pingTimer.unref();
	}

	onData(data, isBinary) {
		if (this.closed) {
			return;
		}

		if (process.env.SIGAME_DEBUG_WS) {
			console.log('[ws] message', isBinary ? 'binary' : 'text', data.length, 'bytes');
		}

		if (!isBinary) {
			// SignalR handshake: the client sends {"protocol":"messagepack","version":1}
			// as a text frame terminated by 0x1e and waits for an empty JSON reply.
			this.handleHandshake(data.toString('utf8'));
			return;
		}

		let messages;
		try {
			messages = parseMessages(data);
		} catch (error) {
			console.error(`Bad SignalR frame from ${this.hubName}: ${error.message}`);
			this.ws.close(1002, `Bad SignalR frame: ${error.message}`);
			return;
		}

		for (const message of messages) {
			this.handleMessage(message);
			if (this.closed) {
				return;
			}
		}
	}

	handleHandshake(text) {
		if (this.handshakeDone) {
			return;
		}

		this.handshakeDone = true;
		const payload = text.replace(/\u001e/g, '').trim();

		if (payload.length > 0) {
			try {
				const request = JSON.parse(payload);
				this.hubProtocol = request.protocol || 'messagepack';
			} catch {
				this.hubProtocol = 'unknown';
			}
		}

		// Empty JSON object + record separator: handshake accepted.
		// The binary transfer format expects the reply as a binary frame.
		this.ws.send(Buffer.from('{}\u001e', 'utf8'), true);
	}

	handleMessage(message) {
		if (!Array.isArray(message) || message.length === 0) {
			return;
		}

		const type = message[0];

		switch (type) {
			case MESSAGE_INVOCATION:
			case MESSAGE_STREAM_INVOCATION: {
				const { invocationId, target, args } = readInvocation(message);
				this.dispatchInvocation(invocationId, target, args);
				break;
			}

			case MESSAGE_PING:
				break;

			case MESSAGE_CLOSE: {
				const error = typeof message[1] === 'string' ? message[1] : '';
				this.ws.close(1000, error);
				break;
			}

			case MESSAGE_STREAM_ITEM:
			case MESSAGE_COMPLETION:
			case MESSAGE_CANCEL_INVOCATION:
				// Client-to-server streaming is not used by this client.
				break;

			default:
				break;
		}
	}

	async dispatchInvocation(invocationId, target, args) {
		try {
			const result = await this.onInvoke(this, target, args);

			if (invocationId === null || invocationId === undefined) {
				return;
			}

			if (result === undefined) {
				this.sendRaw([MESSAGE_COMPLETION, {}, invocationId, RESULT_VOID]);
			} else {
				this.sendRaw([MESSAGE_COMPLETION, {}, invocationId, RESULT_VALUE, result]);
			}
		} catch (error) {
			if (invocationId !== null && invocationId !== undefined) {
				this.sendRaw([MESSAGE_COMPLETION, {}, invocationId, RESULT_ERROR, error.message || String(error)]);
			}
		}
	}

	/** Sends a server-to-client invocation (hub event). */
	sendInvocation(target, ...args) {
		this.sendRaw([MESSAGE_INVOCATION, {}, null, target, args]);
	}

	sendRaw(message) {
		if (this.closed) {
			return;
		}

		try {
			this.ws.send(frameMessage(message), true);
		} catch {
			this.handleClose();
		}
	}

	handleClose() {
		if (this.closed) {
			return;
		}

		this.closed = true;
		clearInterval(this.pingTimer);

		if (this.onCloseCallback) {
			this.onCloseCallback(this);
		}
	}

	close() {
		this.ws.close(1000, '');
		this.handleClose();
	}
}

/**
 * Creates the SignalR plumbing for one hub.
 *
 * @param {string} hubName Hub name used in log messages.
 * @param {(connection: HubConnection, target: string, args: any[]) => Promise<any>|any} onInvoke
 *        Hub method dispatcher. Return value becomes the invocation result;
 *        return undefined for void methods.
 * @param {(connection: HubConnection) => void} [onClose] Called when a connection closes.
 * @returns {{ handleNegotiate(req, res): void, handleConnect(req, ws): void,
 *             connections: Set<HubConnection> }}
 */
function createHub(hubName, onInvoke, onClose) {
	const connections = new Set();
	const pendingById = new Map();

	function handleNegotiate(req, res) {
		const connectionId = newConnectionId();
		pendingById.set(connectionId, Date.now());

		const body = JSON.stringify({
			negotiateVersion: 1,
			connectionId,
			connectionToken: connectionId,
			availableTransports: [
				{ transport: 'WebSockets', transferFormats: ['Binary'] },
			],
		});

		res.writeHead(200, {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(body),
		});
		res.end(body);
	}

	function handleConnect(req, ws) {
		const url = new URL(req.url, 'http://localhost');
		// negotiateVersion=1 clients pass the token as ?id=, older ones as ?connectionId=.
		const connectionId = url.searchParams.get('id') || url.searchParams.get('connectionId');

		if (!connectionId || !pendingById.has(connectionId)) {
			ws.close(1008, 'Unknown connectionId');
			return;
		}

		pendingById.delete(connectionId);

		const connection = new HubConnection(connectionId, ws, hubName, onInvoke, closed => {
			connections.delete(closed);
			if (onClose) {
				onClose(closed);
			}
		}, req);

		connections.add(connection);
	}

	// Forget stale negotiate requests so the map cannot grow forever.
	const cleanupTimer = setInterval(() => {
		const now = Date.now();
		for (const [id, createdAt] of pendingById) {
			if (now - createdAt > 60000) {
				pendingById.delete(id);
			}
		}
	}, 60000);
	cleanupTimer.unref();

	return { handleNegotiate, handleConnect, connections };
}

module.exports = { createHub, HubConnection, frameMessage, parseMessages, encodeVarint, decodeVarint };
