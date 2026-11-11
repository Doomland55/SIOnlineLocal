import { Encoder, decode, decodeMulti } from '@msgpack/msgpack';

/** SignalR hub message types. */
export const enum HubMessageType {
	Invocation = 1,
	StreamItem = 2,
	Completion = 3,
	StreamInvocation = 4,
	CancelInvocation = 5,
	Ping = 6,
	Close = 7,
	Ack = 8,
	Sequence = 9,
}

/** Completion result kinds. */
export const enum CompletionResult {
	Error = 1,
	Void = 2,
	NonVoid = 3,
}

const encoder = new Encoder();

const RECORD_SEPARATOR = 0x1e;

function writeVarInt(size: number): number[] {
	const bytes: number[] = [];
	let rest = size;

	do {
		let sizePart = rest & 0x7f;
		rest = rest >> 7;

		if (rest > 0) {
			sizePart |= 0x80;
		}

		bytes.push(sizePart);
	} while (rest > 0);

	return bytes;
}

/** Encodes a msgpack payload into a length prefixed SignalR binary frame. */
export function writeFrame(payload: Uint8Array): Buffer {
	const prefix = writeVarInt(payload.byteLength);
	return Buffer.concat([Buffer.from(prefix), Buffer.from(payload)]);
}

/** Splits an incoming byte buffer into complete length prefixed frames. */
export class FrameReader {
	private buffer: Buffer = Buffer.alloc(0);

	/** Appends incoming data and returns all complete payloads found. */
	push(chunk: Buffer): Uint8Array[] {
		this.buffer = Buffer.concat([this.buffer, chunk]);

		const payloads: Uint8Array[] = [];
		let offset = 0;

		while (offset < this.buffer.length) {
			let size = 0;
			let shift = 0;
			let index = offset;
			let byte = 0;
			let complete = false;

			// eslint-disable-next-line no-constant-condition
			while (true) {
				if (index >= this.buffer.length) {
					break;
				}

				byte = this.buffer[index];
				size |= (byte & 0x7f) << shift;
				index += 1;
				shift += 7;

				if ((byte & 0x80) === 0) {
					complete = true;
					break;
				}

				if (shift > 35) {
					throw new Error('Invalid frame length prefix');
				}
			}

			if (!complete || index + size > this.buffer.length) {
				break;
			}

			payloads.push(new Uint8Array(this.buffer.subarray(index, index + size)));
			offset = index + size;
		}

		this.buffer = this.buffer.subarray(offset);
		return payloads;
	}
}

/** Decodes a msgpack payload into a hub message array. */
export function decodePayload(payload: Uint8Array): unknown[] {
	const value = decode(payload);

	return Array.isArray(value) ? value : [];
}

/** Builds a server to client invocation frame. */
export function createInvocation(target: string, args: unknown[]): Buffer {
	const payload = encoder.encode([HubMessageType.Invocation, {}, null, target, args]);
	return writeFrame(payload);
}

/** Builds a completion frame for a client invocation. */
export function createCompletion(invocationId: string, result?: unknown, error?: string): Buffer {
	if (error !== undefined) {
		return writeFrame(encoder.encode([HubMessageType.Completion, {}, invocationId, CompletionResult.Error, error]));
	}

	if (result === undefined) {
		return writeFrame(encoder.encode([HubMessageType.Completion, {}, invocationId, CompletionResult.Void]));
	}

	return writeFrame(encoder.encode([HubMessageType.Completion, {}, invocationId, CompletionResult.NonVoid, result]));
}

/** Builds a ping frame (both sides use it as a keep-alive message). */
export function createPing(): Buffer {
	return writeFrame(encoder.encode([HubMessageType.Ping, {}]));
}

/** Builds a close frame. */
export function createClose(error?: string, allowReconnect = false): Buffer {
	return writeFrame(encoder.encode(error === undefined
		? [HubMessageType.Close, null]
		: [HubMessageType.Close, error, allowReconnect]));
}

/** Builds the handshake response frame (a JSON record followed by the record separator). */
export function createHandshakeResponse(error?: string): Buffer {
	const body = error === undefined ? '{}' : JSON.stringify({ error });
	return Buffer.concat([Buffer.from(body, 'utf8'), Buffer.from([RECORD_SEPARATOR])]);
}

/** Returns true when the buffer starts with a JSON handshake request. */
export function tryReadHandshake(data: Buffer): { request: { protocol?: string; version?: number }, rest: Buffer } | null {
	const separatorIndex = data.indexOf(RECORD_SEPARATOR);

	if (separatorIndex === -1) {
		return null;
	}

	const text = data.subarray(0, separatorIndex).toString('utf8');

	if (!text.trim().startsWith('{')) {
		return null;
	}

	return {
		request: JSON.parse(text) as { protocol?: string; version?: number },
		rest: data.subarray(separatorIndex + 1),
	};
}

export { decodeMulti };
