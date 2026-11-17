import fs from 'fs';
import path from 'path';

/**
 * Random access to a media file.
 *
 * Videos could be hundreds of megabytes, so a duration is read from the container headers
 * (`moov` of an mp4 could be at the end of the file) instead of loading the whole file.
 */
interface FileAccess {
	readonly size: number;
	read: (offset: number, length: number) => Buffer;
}

function openFile(filePath: string): FileAccess | null {
	let descriptor: number;

	try {
		descriptor = fs.openSync(filePath, 'r');
	} catch {
		return null;
	}

	const { size } = fs.statSync(filePath);

	const access: FileAccess = {
		size,
		read: (offset, length) => {
			const start = Math.max(0, Math.min(offset, size));
			const end = Math.max(start, Math.min(start + length, size));
			const buffer = Buffer.alloc(end - start);

			try {
				fs.readSync(descriptor, buffer, 0, buffer.length, start);
			} catch {
				return Buffer.alloc(0);
			}

			return buffer;
		},
	};

	// The descriptor is closed by the caller through `closeFile`
	(access as unknown as { descriptor: number }).descriptor = descriptor;
	return access;
}

function closeFile(access: FileAccess | null): void {
	const descriptor = (access as unknown as { descriptor?: number } | null)?.descriptor;

	if (typeof descriptor === 'number') {
		try {
			fs.closeSync(descriptor);
		} catch {
			// Already closed
		}
	}
}

/** Mp4/M4A sample rates are not needed: `mvhd` carries both a timescale and a duration. */
function parseMp4Duration(access: FileAccess): number | null {
	let offset = 0;

	// Top level boxes: ftyp, free, mdat, moov (could be the last one)
	while (offset + 8 <= access.size) {
		const header = access.read(offset, 16);

		if (header.length < 8) {
			return null;
		}

		let size = header.readUInt32BE(0);
		const type = header.toString('latin1', 4, 8);

		if (size === 1) {
			if (header.length < 16) {
				return null;
			}

			size = Number(header.readBigUInt64BE(8));
		} else if (size === 0) {
			size = access.size - offset;
		}

		if (type === 'moov') {
			return parseMovieHeader(access.read(offset, Math.min(size, 1024 * 1024)));
		}

		if (!Number.isFinite(size) || size < 8) {
			return null;
		}

		offset += size;
	}

	return null;
}

/** Reads `mvhd` (movie header) inside the `moov` box. */
function parseMovieHeader(moov: Buffer): number | null {
	let offset = 8; // size + type of the `moov` box itself

	while (offset + 8 <= moov.length) {
		const size = moov.readUInt32BE(offset);
		const type = moov.toString('latin1', offset + 4, offset + 8);

		if (type === 'mvhd') {
			const version = moov[offset + 8];
			const body = offset + 12; // version + flags

			if (version === 1) {
				if (body + 28 > moov.length) {
					return null;
				}

				const timescale = moov.readUInt32BE(body + 16);
				const duration = Number(moov.readBigUInt64BE(body + 20));

				return timescale > 0 && duration > 0 ? duration / timescale : null;
			}

			if (body + 16 > moov.length) {
				return null;
			}

			const timescale = moov.readUInt32BE(body + 8);
			const duration = moov.readUInt32BE(body + 12);

			return timescale > 0 && duration > 0 ? duration / timescale : null;
		}

		if (size < 8) {
			return null;
		}

		offset += size;
	}

	return null;
}

/** Mp3 bitrates (kbps) of the MPEG 1 layer III frames. */
const MP3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_SAMPLE_RATES = [44100, 48000, 32000];

function parseMp3Duration(access: FileAccess): number | null {
	const head = access.read(0, 10);
	let offset = 0;

	// ID3v2 tag in front of the audio frames
	if (head.length >= 10 && head.toString('latin1', 0, 3) === 'ID3') {
		offset = 10 +
			((head[6] & 0x7f) << 21) +
			((head[7] & 0x7f) << 14) +
			((head[8] & 0x7f) << 7) +
			(head[9] & 0x7f);
	}

	const chunk = access.read(offset, 8192);

	for (let i = 0; i + 4 <= chunk.length; i += 1) {
		if (chunk[i] !== 0xff || (chunk[i + 1] & 0xe0) !== 0xe0) {
			continue;
		}

		const versionBits = (chunk[i + 1] >> 3) & 0x03;
		const layerBits = (chunk[i + 1] >> 1) & 0x03;

		if (versionBits !== 3 || layerBits !== 1) {
			continue;
		}

		const bitrateIndex = (chunk[i + 2] >> 4) & 0x0f;
		const rateIndex = (chunk[i + 2] >> 2) & 0x03;
		const padding = (chunk[i + 2] >> 1) & 0x01;

		if (bitrateIndex === 0 || bitrateIndex === 0x0f || rateIndex === 3) {
			continue;
		}

		const bitrate = MP3_BITRATES[bitrateIndex] * 1000;
		const sampleRate = MP3_SAMPLE_RATES[rateIndex];
		const sideInfo = (chunk[i + 3] & 0xc0) === 0xc0 ? 17 : 32;
		const frameLength = Math.floor((144 * bitrate) / sampleRate) + padding;

		// Xing/Info header carries the exact frame count, otherwise the size is enough
		const xing = offset + i + 4 + sideInfo;
		const tag = access.read(xing, 12);

		if (tag.length >= 12 && (tag.toString('latin1', 0, 4) === 'Xing' || tag.toString('latin1', 0, 4) === 'Info')) {
			const flags = tag.readUInt32BE(4);

			if ((flags & 0x0001) !== 0) {
				const frames = tag.readUInt32BE(8);
				// Layer III of MPEG 1 always has 1152 samples per frame
				return frames > 0 ? (frames * 1152) / sampleRate : null;
			}
		}

		if (frameLength <= 0) {
			return null;
		}

		const bytes = Math.max(0, access.size - offset - i);
		return bytes > 0 ? (bytes * 8) / bitrate : null;
	}

	return null;
}

function parseWavDuration(access: FileAccess): number | null {
	const head = access.read(0, 12);

	if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
		return null;
	}

	let offset = 12;
	let byteRate = 0;

	while (offset + 8 <= access.size) {
		const chunk = access.read(offset, 8);

		if (chunk.length < 8) {
			return null;
		}

		const id = chunk.toString('latin1', 0, 4);
		const size = chunk.readUInt32LE(4);

		if (id === 'fmt ') {
			const format = access.read(offset + 8, 16);

			if (format.length >= 12) {
				byteRate = format.readUInt32LE(8);
			}
		} else if (id === 'data') {
			if (byteRate <= 0) {
				return null;
			}

			// Some writers leave the size unknown (`0xFFFFFFFF`); the actual bytes are used then
			const dataSize = size > 0 && size !== 0xffffffff ? size : access.size - offset - 8;
			return dataSize / byteRate;
		}

		if (size < 0) {
			return null;
		}

		offset += 8 + size + (size % 2);
	}

	return null;
}

function parseOggDuration(access: FileAccess): number | null {
	const head = access.read(0, 4096);

	if (head.length < 28 || head.toString('latin1', 0, 4) !== 'OggS') {
		return null;
	}

	const segmentCount = head[26];
	const packetStart = 27 + segmentCount;

	if (packetStart + 16 > head.length) {
		return null;
	}

	const codec = head.toString('latin1', packetStart + 1, packetStart + 7);
	let sampleRate: number;

	if (codec === 'vorbis') {
		sampleRate = head.readUInt32LE(packetStart + 12);
	} else if (head.toString('latin1', packetStart, packetStart + 8) === 'OpusHead') {
		sampleRate = 48000; // Opus always counts granules at 48 kHz
	} else {
		return null;
	}

	// The duration is the granule of the last page
	const tailStart = Math.max(0, access.size - 65536);
	const tail = access.read(tailStart, 65536);
	let pageOffset = -1;

	for (let i = tail.length - 4; i >= 0; i -= 1) {
		if (tail[i] === 0x4f && tail[i + 1] === 0x67 && tail[i + 2] === 0x67 && tail[i + 3] === 0x53) {
			pageOffset = i;
			break;
		}
	}

	if (pageOffset < 0 || pageOffset + 14 > tail.length || sampleRate <= 0) {
		return null;
	}

	const granule = Number(tail.readBigUInt64LE(pageOffset + 6));

	return granule > 0 ? granule / sampleRate : null;
}

/** Extensions that are parsed from the file headers. */
const MP4_EXTENSIONS = ['.mp4', '.m4a', '.m4v', '.mov'];

/**
 * Reads the real duration of an audio or a video file (seconds).
 *
 * Returns null when the format is not supported or the file is broken: the caller then falls back
 * to a fixed duration, so a question never hangs because of a damaged media file.
 */
export function readMediaDuration(filePath: string): number | null {
	const access = openFile(filePath);

	if (!access) {
		return null;
	}

	try {
		const extension = path.extname(filePath).toLowerCase();
		let duration: number | null;

		if (MP4_EXTENSIONS.includes(extension)) {
			duration = parseMp4Duration(access);
		} else if (extension === '.mp3') {
			duration = parseMp3Duration(access);
		} else if (extension === '.wav') {
			duration = parseWavDuration(access);
		} else if (extension === '.ogg' || extension === '.opus') {
			duration = parseOggDuration(access);
		} else {
			duration = null;
		}

		return duration && Number.isFinite(duration) && duration > 0 ? duration : null;
	} catch {
		return null;
	} finally {
		closeFile(access);
	}
}

export default readMediaDuration;
