import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { LocalContentStorage } from '../server/src/api/storage';
import { registerStatic } from '../server/src/api/routes';
import { LocalServerConfig } from '../server/src/config';
import { Game } from '../server/src/game/game';
import { getMediaUrl, loadPackage, LoadedPackage, resolveMediaPath } from '../server/src/game/package';
import { PersonRole } from '../server/src/game/session';
import { PackageLibrary } from '../server/src/game/library';

const xml = `<?xml version="1.0" encoding="utf-8"?>
<package name="Media" version="5" logo="@Logo #1.png"><rounds><round name="R"><themes><theme name="T"><questions>
<question price="100"><params><param name="question" type="content">
<item type="image" isRef="true">Images/my%20photo%23one.png</item>
<item type="audio" isRef="true">TRACK 1.MP3</item>
</param></params><right><answer>yes</answer></right></question>
</questions></theme></themes></round></rounds></package>`;

describe('Local media resolution and HTTP delivery', () => {
	let dir: string;
	let loaded: LoadedPackage;
	let storage: LocalContentStorage;
	let server: http.Server;
	let base: string;

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-media-'));
		const zip = new JSZip();
		zip.file('content.xml', xml);
		zip.file('images/my photo#one.png', 'image-bytes');
		zip.file('Audio/track%201.mp3', 'audio-bytes');
		zip.file('Images/Logo #1.png', 'logo-bytes');
		zip.file('Images/photo..png', 'dots');
		zip.file('Images/AMBIG.png', 'upper');
		zip.file('Images/ambig.PNG', 'lower');
		const filePath = path.join(dir, 'media.siq');
		fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
		loaded = await loadPackage(filePath, 'media.siq', path.join(dir, 'media'));
		storage = new LocalContentStorage(path.join(dir, 'packages'), path.join(dir, 'media'), path.join(dir, 'avatars'));
		const app = express();
		registerStatic(app, { clientDir: dir, name: 'test' } as LocalServerConfig, storage, () => {});
		server = await new Promise<http.Server>(resolve => {
			const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
		});
		base = `http://127.0.0.1:${(server.address() as any).port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('resolves encoded, mixed-case and double-dot filenames and the @ logo reference', () => {
		const item = (value: string, type = 'image') => ({ type, value, isRef: true } as any);
		expect(resolveMediaPath(loaded, item('Images/my%20photo%23one.png'))).toBe('images/my photo#one.png');
		expect(resolveMediaPath(loaded, item('TRACK 1.MP3', 'audio'))).toBe('Audio/track%201.mp3');
		expect(loaded.package.rounds[0].themes[0].questions[0].params.question?.items[1].placement).toBe('background');
		expect(resolveMediaPath(loaded, item('@Logo #1.png'))).toBe('Images/Logo #1.png');
		expect(resolveMediaPath(loaded, item('photo..png'))).toBe('Images/photo..png');
		expect(resolveMediaPath(loaded, item('Ambig.png'))).toBeNull();
		expect(resolveMediaPath(loaded, item('../content.xml'))).toBeNull();
		expect(resolveMediaPath(loaded, item('%2e%2e/content.xml'))).toBeNull();
	});

	it('reloads a replaced package or missing extracted media instead of using stale cache', async () => {
		const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'si-library-'));
		try {
			const library = new PackageLibrary(dir2, path.join(dir2, 'media'), () => {});
			const file = path.join(dir2, 'game.siq');
			const write = async (name: string) => {
				const archive = new JSZip();
				archive.file('content.xml', xml.replace('name="Media"', `name="${name}"`));
				archive.file('Images/Logo #1.png', name);
				fs.writeFileSync(file, await archive.generateAsync({ type: 'nodebuffer' }));
			};
			await write('First');
			const first = await library.load(file);
			await write('Second with a different length');
			const second = await library.load(file);
			expect(second.id).not.toBe(first.id);
			expect(second.package.name).toBe('Second with a different length');
			fs.rmSync(second.rootDir, { recursive: true });
			await library.load(file);
			expect(fs.existsSync(path.join(second.rootDir, 'Images/Logo #1.png'))).toBe(true);
		} finally {
			fs.rmSync(dir2, { recursive: true, force: true });
		}
	});

	it('loads legacy version 4 media references', async () => {
		const archive = new JSZip();
		archive.file('content.xml', `<package name="Legacy" version="4"><rounds><round name="R"><themes><theme name="T"><questions>
			<question price="100"><scenario><atom type="image">@old photo.png</atom></scenario><right><answer>yes</answer></right></question>
			</questions></theme></themes></round></rounds></package>`);
		archive.file('Images/old photo.png', 'legacy');
		const file = path.join(dir, 'legacy.siq');
		fs.writeFileSync(file, await archive.generateAsync({ type: 'nodebuffer' }));
		const legacy = await loadPackage(file, 'legacy.siq', path.join(dir, 'media'));
		const item = legacy.package.rounds[0].themes[0].questions[0].params.question?.items[0];
		expect(item?.isRef).toBe(true);
		expect(resolveMediaPath(legacy, item!)).toBe('Images/old photo.png');
	});

	it('serves encoded files with correct bytes, HEAD and range requests', async () => {
		const image = getMediaUrl(loaded, 'images/my photo#one.png');
		expect(image).toContain('my%20photo%23one.png');
		const response = await fetch(base + image);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('image-bytes');
		const head = await fetch(base + image, { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(head.headers.get('content-length')).toBe('11');
		const audio = getMediaUrl(loaded, 'Audio/track%201.mp3');
		expect(audio).toContain('track%25201.mp3');
		const partial = await fetch(base + audio, { headers: { Range: 'bytes=0-4' } });
		expect(partial.status).toBe(206);
		expect(await partial.text()).toBe('audio');
		expect((await fetch(`${base}/package/not-an-id/anything`)).status).toBe(404);
	});

	it('gives each client its own origin for preloaded media, question media and package logo', () => {
		jest.useFakeTimers({ doNotFake: ['performance'] } as any);
		const game = new Game(1, 'test', loaded, false, 'host', { onGameChanged: () => {}, log: () => {} }, 'http://fallback');
		const alice: string[] = [];
		const bob: string[] = [];
		try {
			for (const name of ['Alice', 'Bob']) {
				game.session.players.push({ name, role: PersonRole.Player, isMale: false, isHuman: true, isConnected: true,
					isBot: false, isReady: true, sum: 0, stake: 0, state: 'None', answer: '' });
			}
			game.attachConnection('Alice', { send: (_target, message: any) => alice.push(message.Text), sendClose: () => {} }, 'http://192.168.1.62:8080');
			game.attachConnection('Bob', { send: (_target, message: any) => bob.push(message.Text), sendClose: () => {} }, 'http://localhost:8080');
			game.sendMetadata('Alice');
			game.sendMetadata('Bob');
			game.startRound(0);
			jest.advanceTimersByTime(1000);
			game.handleClientMessage('Alice', 'CHOICE\n0\n0');
			jest.advanceTimersByTime(5500);
			for (const [list, origin] of [[alice, 'http://192.168.1.62:8080'], [bob, 'http://localhost:8080']] as [string[], string][]) {
				expect(list.some(message => message.startsWith('PACKAGE\n') && message.includes(`${origin}/package/`))).toBe(true);
				expect(list.some(message => message.startsWith('ROUNDCONTENT\n') && message.includes(`${origin}/package/`))).toBe(true);
				expect(list.some(message => message.startsWith('CONTENT2\nscreen') && message.includes(`${origin}/package/`))).toBe(true);
				expect(list.some(message => message.startsWith('CONTENT2\nbackground') && message.includes(`${origin}/package/`))).toBe(true);
				expect(list.some(message => message.includes('Не найден файл'))).toBe(false);
			}
		} finally {
			game.dispose();
			jest.useRealTimers();
		}
	});
});
