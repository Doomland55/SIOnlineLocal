import fs from 'fs';
import os from 'os';
import path from 'path';
import { readMediaDuration } from '../server/src/game/mediaDuration';

/** Builds an ISO base media file (mp4/m4a) with a movie header of the given duration. */
function buildMp4(timescale: number, duration: number, mvhdVersion = 0): Buffer {
	const box = (type: string, payload: Buffer) => {
		const header = Buffer.alloc(8);
		header.writeUInt32BE(8 + payload.length, 0);
		header.write(type, 4, 'latin1');
		return Buffer.concat([header, payload]);
	};

	const body = mvhdVersion === 1
		? Buffer.concat([
			Buffer.from([1, 0, 0, 0]),
			Buffer.alloc(16),
			(() => { const b = Buffer.alloc(4); b.writeUInt32BE(timescale); return b; })(),
			(() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(duration)); return b; })(),
			Buffer.alloc(80),
		])
		: Buffer.concat([
			Buffer.from([0, 0, 0, 0]),
			Buffer.alloc(8),
			(() => { const b = Buffer.alloc(4); b.writeUInt32BE(timescale); return b; })(),
			(() => { const b = Buffer.alloc(4); b.writeUInt32BE(duration); return b; })(),
			Buffer.alloc(80),
		]);

	const ftyp = box('ftyp', Buffer.from('isomisom', 'latin1'));
	const mdat = box('mdat', Buffer.alloc(64));
	const moov = box('moov', box('mvhd', body));

	// `moov` after `mdat` is the usual layout of a streamed mp4
	return Buffer.concat([ftyp, mdat, moov]);
}

/** Builds a WAV file of the given duration. */
function buildWav(duration: number, sampleRate = 8000): Buffer {
	const samples = Math.round(sampleRate * duration);
	const data = Buffer.alloc(samples * 2);

	const header = Buffer.alloc(44);
	header.write('RIFF', 0, 'latin1');
	header.writeUInt32LE(36 + data.length, 4);
	header.write('WAVE', 8, 'latin1');
	header.write('fmt ', 12, 'latin1');
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36, 'latin1');
	header.writeUInt32LE(data.length, 40);

	return Buffer.concat([header, data]);
}

/** Builds an mp3 file of constant bitrate frames (no Xing header). */
function buildMp3(frameCount: number): Buffer {
	const frame = Buffer.alloc(417);
	frame[0] = 0xff;
	frame[1] = 0xfb; // MPEG 1 layer III
	frame[2] = 0x90; // 128 kbps, 44100 Hz
	frame[3] = 0x64;
	return Buffer.concat(Array.from({ length: frameCount }, () => frame));
}

describe('Media duration reader', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-media-duration-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const write = (name: string, data: Buffer) => {
		const filePath = path.join(dir, name);
		fs.writeFileSync(filePath, data);
		return filePath;
	};

	it('reads an mp4 duration from the movie header at the end of the file', () => {
		const filePath = write('video.mp4', buildMp4(1000, 7250));
		expect(readMediaDuration(filePath)).toBeCloseTo(7.25, 3);
	});

	it('reads a 64-bit mp4 duration', () => {
		const filePath = write('long.m4a', buildMp4(44100, 44100 * 30, 1));
		expect(readMediaDuration(filePath)).toBeCloseTo(30, 3);
	});

	it('reads WAV and MP3 durations', () => {
		expect(readMediaDuration(write('sound.wav', buildWav(2.5)))).toBeCloseTo(2.5, 2);
		// 100 frames of 128 kbps at 44.1 kHz: the size-based estimate is slightly shorter than the frame count
		expect(readMediaDuration(write('sound.mp3', buildMp3(100)))).toBeCloseTo((100 * 1152) / 44100, 1);
	});

	it('skips an ID3 tag in front of the audio', () => {
		const id3 = Buffer.concat([
			Buffer.from('ID3', 'latin1'),
			Buffer.from([4, 0, 0]),
			Buffer.from([0, 0, 0, 20]), // synchsafe size of the tag body
		]);
		const filePath = write('tagged.mp3', Buffer.concat([id3, Buffer.alloc(20), buildMp3(50)]));
		expect(readMediaDuration(filePath)).toBeCloseTo((50 * 1152) / 44100, 1);
	});

	it('returns null for an unknown, broken or missing file', () => {
		expect(readMediaDuration(write('notes.txt', Buffer.from('hello')))).toBeNull();
		expect(readMediaDuration(write('broken.mp4', Buffer.from('not a video at all')))).toBeNull();
		expect(readMediaDuration(path.join(dir, 'missing.mp4'))).toBeNull();
	});
});
