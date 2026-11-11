'use strict';

/**
 * Minimal MessagePack codec.
 *
 * Implements the subset of the MessagePack specification that the SignalR
 * MessagePack hub protocol needs for this project: nil, bool, integers,
 * floats, strings, binary, arrays, maps and extensions (decoded as
 * { __extType, data } objects, except the timestamp extension which is
 * decoded to a Date, mirroring @msgpack/msgpack defaults).
 *
 * The server intentionally has zero npm dependencies so it can run on a
 * LAN machine with nothing but Node.js installed.
 */

const MAX_DECODE_DEPTH = 100;

function encode(value, chunks) {
	switch (typeof value) {
		case 'undefined':
		case 'object':
			if (value === null || value === undefined) {
				chunks.push(Buffer.from([0xc0]));
				return;
			}
			if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
				encodeBinary(Buffer.from(value), chunks);
				return;
			}
			if (value instanceof Date) {
				encodeTimestamp(value, chunks);
				return;
			}
			if (Array.isArray(value)) {
				encodeArrayHeader(value.length, chunks);
				for (const item of value) {
					encode(item, chunks);
				}
				return;
			}
			encodeMap(value, chunks);
			return;

		case 'boolean':
			chunks.push(Buffer.from([value ? 0xc3 : 0xc2]));
			return;

		case 'number':
			encodeNumber(value, chunks);
			return;

		case 'string':
			encodeString(value, chunks);
			return;

		default:
			throw new TypeError(`Cannot encode value of type ${typeof value} to MessagePack`);
	}
}

function encodeNumber(value, chunks) {
	if (Number.isInteger(value)) {
		if (value >= 0) {
			if (value < 0x80) {
				chunks.push(Buffer.from([value]));
			} else if (value <= 0xff) {
				const b = Buffer.alloc(2);
				b[0] = 0xcc;
				b[1] = value;
				chunks.push(b);
			} else if (value <= 0xffff) {
				const b = Buffer.alloc(3);
				b[0] = 0xcd;
				b.writeUInt16BE(value, 1);
				chunks.push(b);
			} else if (value <= 0xffffffff) {
				const b = Buffer.alloc(5);
				b[0] = 0xce;
				b.writeUInt32BE(value, 1);
				chunks.push(b);
			} else if (value <= Number.MAX_SAFE_INTEGER) {
				const b = Buffer.alloc(9);
				b[0] = 0xcf;
				b.writeBigUInt64BE(BigInt(value), 1);
				chunks.push(b);
			} else {
				encodeFloat(value, chunks);
			}
		} else if (value >= -32) {
			chunks.push(Buffer.from([value & 0xff]));
		} else if (value >= -128) {
			const b = Buffer.alloc(2);
			b[0] = 0xd0;
			b.writeInt8(value, 1);
			chunks.push(b);
		} else if (value >= -32768) {
			const b = Buffer.alloc(3);
			b[0] = 0xd1;
			b.writeInt16BE(value, 1);
			chunks.push(b);
		} else if (value >= -2147483648) {
			const b = Buffer.alloc(5);
			b[0] = 0xd2;
			b.writeInt32BE(value, 1);
			chunks.push(b);
		} else if (value >= Number.MIN_SAFE_INTEGER) {
			const b = Buffer.alloc(9);
			b[0] = 0xd3;
			b.writeBigInt64BE(BigInt(value), 1);
			chunks.push(b);
		} else {
			encodeFloat(value, chunks);
		}
		return;
	}

	encodeFloat(value, chunks);
}

function encodeFloat(value, chunks) {
	const b = Buffer.alloc(9);
	b[0] = 0xcb;
	b.writeDoubleBE(value, 1);
	chunks.push(b);
}

function encodeString(value, chunks) {
	const data = Buffer.from(value, 'utf8');
	const length = data.length;

	if (length < 32) {
		chunks.push(Buffer.from([0xa0 | length]));
	} else if (length <= 0xff) {
		chunks.push(Buffer.from([0xd9, length]));
	} else if (length <= 0xffff) {
		const b = Buffer.alloc(3);
		b[0] = 0xda;
		b.writeUInt16BE(length, 1);
		chunks.push(b);
	} else {
		const b = Buffer.alloc(5);
		b[0] = 0xdb;
		b.writeUInt32BE(length, 1);
		chunks.push(b);
	}

	chunks.push(data);
}

function encodeBinary(data, chunks) {
	const length = data.length;

	if (length <= 0xff) {
		chunks.push(Buffer.from([0xc4, length]));
	} else if (length <= 0xffff) {
		const b = Buffer.alloc(3);
		b[0] = 0xc5;
		b.writeUInt16BE(length, 1);
		chunks.push(b);
	} else {
		const b = Buffer.alloc(5);
		b[0] = 0xc6;
		b.writeUInt32BE(length, 1);
		chunks.push(b);
	}

	chunks.push(data);
}

function encodeArrayHeader(length, chunks) {
	if (length < 16) {
		chunks.push(Buffer.from([0x90 | length]));
	} else if (length <= 0xffff) {
		const b = Buffer.alloc(3);
		b[0] = 0xdc;
		b.writeUInt16BE(length, 1);
		chunks.push(b);
	} else {
		const b = Buffer.alloc(5);
		b[0] = 0xdd;
		b.writeUInt32BE(length, 1);
		chunks.push(b);
	}
}

function encodeMap(value, chunks) {
	const keys = Object.keys(value);

	if (keys.length < 16) {
		chunks.push(Buffer.from([0x80 | keys.length]));
	} else if (keys.length <= 0xffff) {
		const b = Buffer.alloc(3);
		b[0] = 0xde;
		b.writeUInt16BE(keys.length, 1);
		chunks.push(b);
	} else {
		const b = Buffer.alloc(5);
		b[0] = 0xdf;
		b.writeUInt32BE(keys.length, 1);
		chunks.push(b);
	}

	for (const key of keys) {
		encodeString(key, chunks);
		encode(value[key], chunks);
	}
}

function encodeTimestamp(date, chunks) {
	// Timestamp extension (type -1), 64-bit form: nanoseconds in low 34 bits
	// of the first word, seconds in the remaining 30 bits.
	const seconds = Math.floor(date.getTime() / 1000);
	const nanos = (date.getTime() % 1000) * 1e6;
	const value = (BigInt(nanos) << 34n) | BigInt(seconds);
	const b = Buffer.alloc(12);
	b[0] = 0xd7; // fixext8
	b.writeBigUInt64BE(value, 1);
	b.writeInt8(-1, 9);
	chunks.push(b);
}

/** Encodes a value to a MessagePack Buffer. */
function encodeValue(value) {
	const chunks = [];
	encode(value, chunks);
	return Buffer.concat(chunks);
}

class Reader {
	constructor(buffer) {
		this.buffer = buffer;
		this.offset = 0;
	}

	readByte() {
		if (this.offset >= this.buffer.length) {
			throw new Error('Unexpected end of MessagePack data');
		}
		return this.buffer[this.offset++];
	}

	readBytes(count) {
		if (this.offset + count > this.buffer.length) {
			throw new Error('Unexpected end of MessagePack data');
		}
		const result = this.buffer.subarray(this.offset, this.offset + count);
		this.offset += count;
		return result;
	}

	readUInt16() {
		return this.readBytes(2).readUInt16BE(0);
	}

	readUInt32() {
		return this.readBytes(4).readUInt32BE(0);
	}

	readUInt64() {
		const value = this.readBytes(8).readBigUInt64BE(0);
		return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
	}

	readInt8() {
		return this.readBytes(1).readInt8(0);
	}

	readInt16() {
		return this.readBytes(2).readInt16BE(0);
	}

	readInt32() {
		return this.readBytes(4).readInt32BE(0);
	}

	readInt64() {
		const value = this.readBytes(8).readBigInt64BE(0);
		return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(value)
			: value;
	}

	readFloat32() {
		return this.readBytes(4).readFloatBE(0);
	}

	readFloat64() {
		return this.readBytes(8).readDoubleBE(0);
	}

	readString(length) {
		return this.readBytes(length).toString('utf8');
	}

	decode(depth) {
		if (depth > MAX_DECODE_DEPTH) {
			throw new Error('MessagePack data is nested too deeply');
		}

		const marker = this.readByte();

		if (marker <= 0x7f) {
			return marker; // positive fixint
		}
		if (marker >= 0xe0) {
			return marker - 0x100; // negative fixint
		}
		if (marker >= 0xa0 && marker <= 0xbf) {
			return this.readString(marker & 0x1f); // fixstr
		}
		if (marker >= 0x90 && marker <= 0x9f) {
			return this.readArray(marker & 0x0f, depth); // fixarray
		}
		if (marker >= 0x80 && marker <= 0x8f) {
			return this.readMap(marker & 0x0f, depth); // fixmap
		}

		switch (marker) {
			case 0xc0:
				return null;
			case 0xc2:
				return false;
			case 0xc3:
				return true;
			case 0xca:
				return this.readFloat32();
			case 0xcb:
				return this.readFloat64();
			case 0xcc:
				return this.readByte();
			case 0xcd:
				return this.readUInt16();
			case 0xce:
				return this.readUInt32();
			case 0xcf:
				return this.readUInt64();
			case 0xd0:
				return this.readInt8();
			case 0xd1:
				return this.readInt16();
			case 0xd2:
				return this.readInt32();
			case 0xd3:
				return this.readInt64();
			case 0xd9:
				return this.readString(this.readByte());
			case 0xda:
				return this.readString(this.readUInt16());
			case 0xdb:
				return this.readString(this.readUInt32());
			case 0xc4:
				return this.readBytes(this.readByte());
			case 0xc5:
				return this.readBytes(this.readUInt16());
			case 0xc6:
				return this.readBytes(this.readUInt32());
			case 0xdc:
				return this.readArray(this.readUInt16(), depth);
			case 0xdd:
				return this.readArray(this.readUInt32(), depth);
			case 0xde:
				return this.readMap(this.readUInt16(), depth);
			case 0xdf:
				return this.readMap(this.readUInt32(), depth);
			case 0xd4:
				return this.readExt(1, depth);
			case 0xd5:
				return this.readExt(2, depth);
			case 0xd6:
				return this.readExt(4, depth);
			case 0xd7:
				return this.readExt(8, depth);
			case 0xd8:
				return this.readExt(16, depth);
			case 0xc7:
				return this.readExt(this.readByte(), depth);
			case 0xc8:
				return this.readExt(this.readUInt16(), depth);
			case 0xc9:
				return this.readExt(this.readUInt32(), depth);
			default:
				throw new Error(`Unsupported MessagePack marker 0x${marker.toString(16)}`);
		}
	}

	readArray(length, depth) {
		const result = new Array(length);
		for (let i = 0; i < length; i++) {
			result[i] = this.decode(depth + 1);
		}
		return result;
	}

	readMap(length, depth) {
		const result = {};
		for (let i = 0; i < length; i++) {
			const key = this.decode(depth + 1);
			result[key] = this.decode(depth + 1);
		}
		return result;
	}

	readExt(length, depth) {
		const data = this.readBytes(length);
		const type = this.readInt8();

		if (type === -1 && length === 8) {
			// Timestamp extension, 64-bit form.
			const value = data.readBigUInt64BE(0);
			const seconds = Number(value >> 34n);
			const nanos = Number(value & ((1n << 34n) - 1n));
			return new Date(seconds * 1000 + Math.floor(nanos / 1e6));
		}

		return { __extType: type, data: Buffer.from(data) };
	}
}

/** Decodes a single MessagePack value from the start of the buffer. */
function decodeValue(buffer) {
	const reader = new Reader(buffer);
	const value = reader.decode(0);
	return { value, bytesRead: reader.offset };
}

module.exports = { encodeValue, decodeValue };
