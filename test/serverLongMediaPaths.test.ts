import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { registerStatic } from '../server/src/api/routes';
import { LocalContentStorage } from '../server/src/api/storage';
import { LocalServerConfig } from '../server/src/config';
import { loadPackage, loadPackageFromBuffer, resolveMediaPath, getMediaUrl } from '../server/src/game/package';
import { Game } from '../server/src/game/game';
import { PersonRole } from '../server/src/game/session';

const filename = encodeURIComponent('Український ГОПАК - Восьме чудо світу Ансамбль Військового [get-save.com] 00_07_03-00_07_24.mp4');
const longAscii = `${'long-file-'.repeat(38)}.mp4`;
const xml = `<package name="Long paths" version="5"><rounds><round name="R"><themes><theme name="T"><questions>
<question price="100"><params><param name="question" type="content">
<item type="video" isRef="true">${filename}</item><item type="video" isRef="true">${longAscii}</item>
</param></params><right><answer>yes</answer></right></question></questions></theme></themes></round></rounds></package>`;

test('extracts and serves long encoded and long literal filenames without changing package references', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-long-'));
	let server: http.Server | undefined;
	try {
		expect(filename.length).toBeGreaterThan(255);
		const zip = new JSZip();
		zip.file('content.xml', xml);
		zip.file(`Video/${filename}`, 'encoded-video');
		zip.file(`Video/${longAscii}`, 'long-video');
		// A real file in the default alias namespace and two similarly named archive entries must not collide.
		zip.file('_si', 'reserved-name');
		zip.file('collision', 'file');
		zip.file('collision/child.png', 'child');
		zip.file('shared.png', 'flat');
		zip.file('Images/shared.png', 'folder');
		const buffer = await zip.generateAsync({ type: 'nodebuffer' });
		const filePath = path.join(dir, 'test.siq');
		fs.writeFileSync(filePath, buffer);
		const mediaDir = path.join(dir, 'media');
		const loaded = await loadPackage(filePath, 'test.siq', mediaDir);
		const fromBuffer = await loadPackageFromBuffer(buffer, 'test.siq', mediaDir);
		const items = loaded.package.rounds[0].themes[0].questions[0].params.question!.items;
		expect(items[0].value).toBe(filename);
		const videoPath = resolveMediaPath(loaded, items[0]);
		const otherPath = resolveMediaPath(loaded, items[1]);
		expect(videoPath).toBeTruthy();
		expect(otherPath).toBeTruthy();
		expect(otherPath).not.toBe(videoPath);
		expect(otherPath).toMatch(/^_si1\//);
		const collisionFile = loaded.mediaPaths!.get('collision')!;
		const collisionChild = loaded.mediaPaths!.get('collision/child.png')!;
		expect(fs.readFileSync(path.join(loaded.rootDir, collisionFile), 'utf8')).toBe('file');
		expect(fs.readFileSync(path.join(loaded.rootDir, collisionChild), 'utf8')).toBe('child');
		const flat = resolveMediaPath(loaded, { type: 'image', value: 'shared.png', isRef: true } as any);
		const folder = resolveMediaPath(loaded, { type: 'image', value: 'Images/shared.png', isRef: true } as any);
		expect(flat).not.toBe(folder);
		expect(fs.readFileSync(path.join(loaded.rootDir, flat!), 'utf8')).toBe('flat');
		expect(fs.readFileSync(path.join(loaded.rootDir, folder!), 'utf8')).toBe('folder');
		expect(Buffer.byteLength(path.basename(videoPath!), 'utf8')).toBeLessThanOrEqual(240);
		expect(Buffer.byteLength(path.basename(otherPath!), 'utf8')).toBeLessThanOrEqual(240);
		expect(resolveMediaPath(fromBuffer.loaded, items[0])).toBe(videoPath);
		expect(fs.readFileSync(path.join(loaded.rootDir, videoPath!), 'utf8')).toBe('encoded-video');
		expect(fs.readFileSync(path.join(loaded.rootDir, otherPath!), 'utf8')).toBe('long-video');

		const storage = new LocalContentStorage(path.join(dir, 'packages'), mediaDir, path.join(dir, 'avatars'));
		const app = express();
		registerStatic(app, { clientDir: dir, name: 'test' } as LocalServerConfig, storage, () => {});
		server = await new Promise<http.Server>(resolve => {
			const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
		});
		const base = `http://127.0.0.1:${(server.address() as any).port}`;
		const response = await fetch(base + getMediaUrl(loaded, videoPath!), { headers: { Range: 'bytes=0-6' } });
		expect(response.status).toBe(206);
		expect(await response.text()).toBe('encoded');

		jest.useFakeTimers({ doNotFake: ['performance'] } as any);
		const messages: string[] = [];
		const game = new Game(1, 'test', loaded, false, 'host', { onGameChanged: () => {}, log: () => {} }, base);
		try {
			game.session.players.push({ name: 'Alice', role: PersonRole.Player, isMale: false, isHuman: true, isConnected: true,
				isBot: false, isReady: true, sum: 0, stake: 0, state: 'None', answer: '' });
			game.attachConnection('Alice', { send: (_target, message: any) => messages.push(message.Text), sendClose: () => {} }, base);
			game.startRound(0);
			jest.advanceTimersByTime(1000);
			game.handleClientMessage('Alice', 'CHOICE\n0\n0');
			jest.advanceTimersByTime(2000);
			expect(messages.some(message => message.startsWith('CONTENT2\nscreen') && message.includes(getMediaUrl(loaded, videoPath!)))).toBe(true);
			expect(messages.some(message => message.includes('Не найден файл'))).toBe(false);
		} finally {
			game.dispose();
			jest.useRealTimers();
		}
	} finally {
		if (server) {
			await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
