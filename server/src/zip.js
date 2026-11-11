'use strict';

/**
 * Minimal ZIP reader for .siq game packages.
 *
 * A .siq file is a ZIP archive containing content.xml plus media files.
 * Only the features produced by SIQuester (JSZip) are supported:
 * stored and DEFLATE-compressed entries, data descriptors, ZIP64 extra
 * fields are skipped. Uses node:zlib for inflation, no npm dependencies.
 */

const zlib = require('zlib');

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

function findEndOfCentralDirectory(buffer) {
	// The EOCD record is at least 22 bytes; search backwards for its signature.
	const maxSearch = Math.min(buffer.length, 22 + 0xffff);
	const start = buffer.length - maxSearch;

	for (let i = buffer.length - 22; i >= start; i--) {
		if (buffer.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
			return i;
		}
	}

	throw new Error('Not a ZIP file (end of central directory not found)');
}

function inflateEntry(buffer, entry) {
	if (entry.method === 0) {
		return Buffer.from(buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize));
	}

	if (entry.method === 8) {
		return zlib.inflateRawSync(buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize));
	}

	throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

/**
 * Reads a ZIP archive into a Map of entry name -> Buffer.
 * Directory entries are skipped.
 */
function readZip(buffer) {
	if (!Buffer.isBuffer(buffer)) {
		buffer = Buffer.from(buffer);
	}

	const eocdOffset = findEndOfCentralDirectory(buffer);
	const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
	const totalEntries = buffer.readUInt16LE(eocdOffset + 10);

	const files = new Map();
	let offset = centralDirectoryOffset;

	for (let i = 0; i < totalEntries; i++) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
			throw new Error('Corrupt ZIP central directory');
		}

		const method = buffer.readUInt16LE(offset + 10);
		let compressedSize = buffer.readUInt32LE(offset + 20);
		let uncompressedSize = buffer.readUInt32LE(offset + 24);
		const fileNameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localHeaderOffset = buffer.readUInt32LE(offset + 42);

		const name = buffer.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');

		// ZIP64: sizes/offset of 0xffffffff live in the extra field.
		if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
			const extraStart = offset + 46 + fileNameLength;
			let extraOffset = extraStart;
			const extraEnd = extraStart + extraLength;

			while (extraOffset + 4 <= extraEnd) {
				const headerId = buffer.readUInt16LE(extraOffset);
				const dataSize = buffer.readUInt16LE(extraOffset + 2);
				extraOffset += 4;

				if (headerId === 0x0001) {
					let p = extraOffset;
					if (uncompressedSize === 0xffffffff) {
						uncompressedSize = Number(buffer.readBigUInt64LE(p));
						p += 8;
					}
					if (compressedSize === 0xffffffff) {
						compressedSize = Number(buffer.readBigUInt64LE(p));
						p += 8;
					}
					if (localHeaderOffset === 0xffffffff) {
						// Offset is not needed: the local header is located via the
						// central directory entry order in practice, but keep the
						// value for completeness.
						p += 8;
					}
				}

				extraOffset += dataSize;
			}
		}

		if (!name.endsWith('/')) {
			if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER) {
				throw new Error(`Corrupt ZIP local header for ${name}`);
			}

			const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
			const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
			const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;

			const entry = { name, method, compressedSize, dataOffset };
			files.set(name, inflateEntry(buffer, entry));
		}

		offset += 46 + fileNameLength + extraLength + commentLength;
	}

	return files;
}

module.exports = { readZip };
