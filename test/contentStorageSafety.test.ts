import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { LocalContentStorage, isSafeHashSegment, resolveInside, sendFile } from '../server/src/api/storage';
import { isImageFileName, parseMultipartFile, registerRoutes } from '../server/src/api/routes';
import { LocalServerConfig } from '../server/src/config';
import { Lobby } from '../server/src/game/lobby';

import { PackageLibrary } from '../server/src/game/library';

const noop = () => { };

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'si-storage-safety-'));
}

function listen(app: express.Express): Promise<{ server: http.Server; base: string }> {
	return new Promise(resolve => {
		const server = app.listen(0, '127.0.0.1', () => {
			resolve({ server, base: `http://127.0.0.1:${(server.address() as any).port}` });
		});
	});
}

function close(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

describe('Content storage path safety', () => {
	let dir: string;
	let storage: LocalContentStorage;

	beforeEach(() => {
		dir = createTempDir();
		storage = new LocalContentStorage(
			path.join(dir, 'package'),
			path.join(dir, 'media'),
			path.join(dir, 'avatars'),
		);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('isSafeHashSegment', () => {
		it('accepts hashes that the content client produces', () => {
			expect(isSafeHashSegment(LocalContentStorage.hash(Buffer.from('data')))).toBe(true);
			expect(isSafeHashSegment('abcDEF012_-')).toBe(true);
		});

		it('rejects traversal, separators, encoding and empty values', () => {
			expect(isSafeHashSegment('..')).toBe(false);
			expect(isSafeHashSegment('.')).toBe(false);
			expect(isSafeHashSegment('../../etc')).toBe(false);
			expect(isSafeHashSegment('..\\..\\windows')).toBe(false);
			expect(isSafeHashSegment('%2e%2e%2fetc')).toBe(false);
			expect(isSafeHashSegment('/etc')).toBe(false);
			expect(isSafeHashSegment('a/b')).toBe(false);
			expect(isSafeHashSegment('')).toBe(false);
			expect(isSafeHashSegment(null)).toBe(false);
			expect(isSafeHashSegment(undefined)).toBe(false);
		});
	});

	describe('resolveInside', () => {
		it('returns an existing file inside the root and nothing outside of it', () => {
			const root = path.join(dir, 'root');
			fs.mkdirSync(root, { recursive: true });
			fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
			fs.writeFileSync(path.join(dir, 'outside.txt'), 'secret');

			expect(resolveInside(root, 'ok.txt')).toBe(path.join(root, 'ok.txt'));
			expect(resolveInside(root, '../outside.txt')).toBeNull();
			expect(resolveInside(root, path.join('..', 'outside.txt'))).toBeNull();
			expect(resolveInside(root, path.join(dir, 'outside.txt'))).toBeNull();
			expect(resolveInside(root, '.')).toBeNull();
			expect(resolveInside(root, 'missing.txt')).toBeNull();
		});
	});

	describe('saving and reading packages', () => {
		it('does not let a client supplied Content-MD5 escape the data directory', () => {
			const data = Buffer.from('package-bytes');
			const uri = storage.savePackage(data, 'game.siq', '../../../../escaped');

			// The unsafe hash is ignored and the content hash is used instead
			expect(uri).toMatch(/^\/api\/v1\/content\/packages\/[A-Za-z0-9_-]+\/game\.siq$/);
			expect(fs.existsSync(path.join(dir, 'escaped'))).toBe(false);
			expect(fs.existsSync(path.join(dir, 'package', 'escaped'))).toBe(false);
			expect(fs.existsSync(path.join(dir, 'package', LocalContentStorage.hash(data), 'game.siq'))).toBe(true);
		});

		it('stores a valid client hash as a single directory', () => {
			const uri = storage.savePackage(Buffer.from('x'), 'game.siq', 'clientHash_-1');
			expect(uri).toBe('/api/v1/content/packages/clientHash_-1/game.siq');
			expect(fs.existsSync(path.join(dir, 'package', 'clientHash_-1', 'game.siq'))).toBe(true);
		});

		it('rejects traversal in the hash and in the name of a package request', () => {
			fs.writeFileSync(path.join(dir, 'secret.siq'), 'secret');

			expect(storage.getPackagePath('../../../', 'secret.siq')).toBeNull();
			expect(storage.getPackagePath('..', 'secret.siq')).toBeNull();
			expect(storage.getPackagePath('%2e%2e%2f%2e%2e', 'secret.siq')).toBeNull();

			const valid = storage.savePackage(Buffer.from('data'), 'game.siq');
			const hash = valid.split('/')[5];
			expect(storage.getPackagePath(hash, '../../../../secret.siq')).toBeNull();
			expect(storage.getPackagePath(hash, '..\\..\\secret.siq')).toBeNull();
			expect(storage.getPackagePath(hash, 'game.siq')).toBe(path.join(dir, 'package', hash, 'game.siq'));
		});

		it('rejects traversal in avatars and media', () => {
			fs.writeFileSync(path.join(dir, 'secret.png'), 'secret');

			expect(storage.getAvatarPath('../../../', 'secret.png')).toBeNull();
			expect(storage.getMediaPath('..%2f..%2f..', '../../../secret.png')).toBeNull();
			// Media ids are content hashes of the package
			expect(storage.getMediaPath('0123456789abcdef', '../../../secret.png')).toBeNull();
			expect(storage.getMediaPath('0123456789abcdef', '../../secret.png')).toBeNull();
		});
	});

	describe('isImageFileName', () => {
		it('allows images only', () => {
			expect(isImageFileName('avatar.png')).toBe(true);
			expect(isImageFileName('AVATAR.JPG')).toBe(true);
			expect(isImageFileName('a.webp')).toBe(true);
			expect(isImageFileName('evil.html')).toBe(false);
			expect(isImageFileName('evil.svg')).toBe(false);
			expect(isImageFileName('evil.js')).toBe(false);
			expect(isImageFileName('noext')).toBe(false);
		});
	});
});

describe('Content service HTTP surface', () => {
	let dir: string;
	let server: http.Server;
	let base: string;
	let storage: LocalContentStorage;

	beforeAll(async () => {
		dir = createTempDir();
		storage = new LocalContentStorage(
			path.join(dir, 'package'),
			path.join(dir, 'media'),
			path.join(dir, 'avatars'),
		);

		const config = {
			port: 0,
			host: '127.0.0.1',
			publicBaseUrl: null,
			name: 'test',
			packagesDir: path.join(dir, 'packages'),
			dataDir: dir,
			clientDir: path.join(dir, 'dist'),
			maxPackageSizeMb: 8,
			timeSettings: {},
			botNames: [],
			startupGames: false,
			license: '',
		} as unknown as LocalServerConfig;

		const library = new PackageLibrary(path.join(dir, 'packages'), path.join(dir, 'media'), noop);
		const lobby = new Lobby(library, {
			publicBaseUrl: 'http://127.0.0.1',
			serverName: 'test',
			defaultShowmanName: 'showman',
			language: 'ru-RU',
			botNames: [],
			log: noop,
		}, path.join(dir, 'uploads'));

		const app = express();
		registerRoutes(app, config, 'http://127.0.0.1', lobby, library, storage, noop);

		({ server, base } = await listen(app));

		fs.writeFileSync(path.join(dir, 'secret.txt'), 'top-secret');
		fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'dist', 'index.html'), 'index');
	});

	afterAll(async () => {
		await close(server);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function multipart(fileName: string, content: string, contentType = 'application/octet-stream') {
		const boundary = 'X';
		const body = Buffer.concat([
			Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
				`Content-Type: ${contentType}\r\n\r\n`, 'utf8'),
			Buffer.from(content, 'utf8'),
			Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
		]);

		return { body, contentType: `multipart/form-data; boundary=${boundary}` };
	}

	it('refuses a package upload whose Content-MD5 is a path', async () => {
		const { body, contentType } = multipart('game.siq', 'package-bytes');
		const response = await fetch(`${base}/api/v1/content/packages`, {
			method: 'POST',
			headers: { 'Content-Type': contentType, 'Content-MD5': '../../../../../../tmp/si-escaped' },
			body,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ errorCode: 'BadPackageFile' });
		expect(fs.existsSync(path.join(dir, '..', 'si-escaped'))).toBe(false);
		expect(fs.existsSync(path.join(os.tmpdir(), 'si-escaped'))).toBe(false);
	});

	it('accepts a package upload with a valid Content-MD5', async () => {
		const { body, contentType } = multipart('game.siq', 'package-bytes');
		const response = await fetch(`${base}/api/v1/content/packages`, {
			method: 'POST',
			headers: { 'Content-Type': contentType, 'Content-MD5': 'clientHash_-1' },
			body,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('/api/v1/content/packages/clientHash_-1/game.siq');
	});

	it('does not read files outside the storage through the package route', async () => {
		for (const hash of ['..%2F..%2F..%2F..%2F..%2F..%2Fetc', '..%2f..%2f..', '%2e%2e%2f%2e%2e']) {
			const response = await fetch(`${base}/api/v1/content/packages/${hash}/secret.txt`);
			expect(response.status).toBe(404);
		}
	});

	it('does not read files outside the storage through the avatar route', async () => {
		const response = await fetch(`${base}/api/v1/content/avatars/..%2F..%2F..%2F..%2F..%2Fsecret.txt`);
		expect(response.status).toBe(404);
	});

	it('refuses active content as an avatar', async () => {
		const { body, contentType } = multipart('evil.html', '<script>alert(1)</script>', 'text/html');
		const response = await fetch(`${base}/api/v1/content/avatars`, {
			method: 'POST',
			headers: { 'Content-Type': contentType },
			body,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ errorCode: 'BadFile' });
	});

	it('accepts an image avatar and serves it with hardening headers', async () => {
		const { body, contentType } = multipart('avatar.png', 'png-bytes', 'image/png');
		const upload = await fetch(`${base}/api/v1/content/avatars`, {
			method: 'POST',
			headers: { 'Content-Type': contentType },
			body,
		});

		expect(upload.status).toBe(200);
		const uri = await upload.text();
		expect(uri).toMatch(/^\/api\/v1\/content\/avatars\/[A-Za-z0-9_-]+\/avatar\.png$/);

		const image = await fetch(base + uri);
		expect(image.status).toBe(200);
		expect(image.headers.get('x-content-type-options')).toBe('nosniff');
	});
});

describe('sendFile content disposition', () => {
	let dir: string;
	let server: http.Server;
	let base: string;

	beforeAll(async () => {
		dir = createTempDir();
		fs.writeFileSync(path.join(dir, 'question.html'), '<html><body>question</body></html>');
		fs.writeFileSync(path.join(dir, 'picture.png'), 'png');

		const app = express();
		app.get('/download/:name', (request, response) => sendFile(response, path.join(dir, request.params.name)));
		app.get('/inline/:name', (request, response) => sendFile(
			response,
			path.join(dir, request.params.name),
			{ inlineActiveContent: true },
		));

		({ server, base } = await listen(app));
	});

	afterAll(async () => {
		await close(server);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('sends active content of uploads as a download', async () => {
		const response = await fetch(`${base}/download/question.html`);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-disposition')).toContain('attachment');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
	});

	it('keeps package media inline, with nosniff', async () => {
		const response = await fetch(`${base}/inline/question.html`);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-disposition')).toBeNull();
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await response.text()).toContain('question');
	});

	it('does not add a download disposition to binary media', async () => {
		const response = await fetch(`${base}/download/picture.png`);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-disposition')).toBeNull();
	});
});

describe('parseMultipartFile', () => {
	it('returns the uploaded file', () => {
		const boundary = 'b';
		const body = Buffer.from('--b\r\nContent-Disposition: form-data; name="file"; filename="a.siq"\r\n\r\nDATA\r\n--b--\r\n');
		expect(parseMultipartFile(body, `multipart/form-data; boundary=${boundary}`)).toEqual({
			name: 'a.siq',
			data: Buffer.from('DATA'),
		});
	});

	it('returns null without a boundary or a file part', () => {
		expect(parseMultipartFile(Buffer.from('data'), 'text/plain')).toBeNull();
		expect(parseMultipartFile(
			Buffer.from('--b\r\nContent-Disposition: form-data; name="other"\r\n\r\nx\r\n--b--\r\n'),
			'multipart/form-data; boundary=b',
		)).toBeNull();
	});
});

describe('Automatic game player name', () => {
	let dir: string;
	let lobby: Lobby;
	let server: http.Server;
	let base: string;
	let createAutomaticGame: jest.SpyInstance;

	beforeAll(async () => {
		dir = createTempDir();
		const packagesDir = path.join(dir, 'packages');
		fs.mkdirSync(packagesDir, { recursive: true });

		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const JSZip = require('jszip');
		const zip = new JSZip();
		zip.file('content.xml', '<?xml version="1.0" encoding="utf-8"?><package name="Тест" version="5"><rounds>'
			+ '<round name="Раунд"><themes><theme name="Тема"><questions><question price="100">'
			+ '<params><param name="question" type="content"><item type="text">Вопрос</item></param></params>'
			+ '<right><answer>Ответ</answer></right></question></questions></theme></themes></round></rounds></package>');
		fs.writeFileSync(path.join(packagesDir, 'auto.siq'), await zip.generateAsync({ type: 'nodebuffer' }));

		const library = new PackageLibrary(packagesDir, path.join(dir, 'media'), noop);
		lobby = new Lobby(library, {
			publicBaseUrl: 'http://127.0.0.1',
			serverName: 'test',
			defaultShowmanName: 'Ведущий',
			language: 'ru-RU',
			botNames: ['Иннокентий', 'Александра'],
			log: noop,
		}, path.join(dir, 'uploads'));

		// The lobby call is observed instead of inspected: the game itself is removed
		// from the lobby when the test connection is gone, so only what the route passes matters here
		createAutomaticGame = jest.spyOn(lobby, 'createAutomaticGame').mockImplementation(
			async playerName => ({ isSuccess: true, hostUri: 'http://127.0.0.1', gameId: 1, isHost: false, errorType: 0 }),
		);

		const config = {
			port: 0,
			host: '127.0.0.1',
			publicBaseUrl: null,
			name: 'test',
			packagesDir,
			dataDir: dir,
			clientDir: path.join(dir, 'dist'),
			maxPackageSizeMb: 8,
			timeSettings: {},
			botNames: [],
			startupGames: false,
			license: '',
		} as unknown as LocalServerConfig;

		const app = express();
		registerRoutes(app, config, 'http://127.0.0.1', lobby, library, new LocalContentStorage(
			path.join(dir, 'package'), path.join(dir, 'media'), path.join(dir, 'avatars'),
		), noop);

		({ server, base } = await listen(app));
	});

	afterEach(() => createAutomaticGame.mockClear());

	afterAll(async () => {
		await close(server);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const post = (body: unknown, query = '') => fetch(`${base}/api/v1/games/auto${query}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	}).then(response => response.json());

	it('passes the player name from the request body to the lobby', async () => {
		await post({ culture: 'ru-RU', playerName: 'Алиса' });
		expect(createAutomaticGame).toHaveBeenCalledWith('Алиса');
	});

	it('trims the name and ignores an empty one', async () => {
		await post({ culture: 'ru-RU', playerName: '  Алиса  ' });
		expect(createAutomaticGame).toHaveBeenLastCalledWith('Алиса');

		await post({ culture: 'ru-RU', playerName: '   ' });
		expect(createAutomaticGame).toHaveBeenLastCalledWith('Игрок');
	});

	it('keeps the query parameter for older clients and prefers the body', async () => {
		await post({ culture: 'ru-RU' }, '?player=Old');
		expect(createAutomaticGame).toHaveBeenLastCalledWith('Old');

		await post({ culture: 'ru-RU', playerName: 'Body' }, '?player=Old');
		expect(createAutomaticGame).toHaveBeenLastCalledWith('Body');
	});

	it('falls back to a default name when neither the body nor the query has it', async () => {
		await post({ culture: 'ru-RU' });
		expect(createAutomaticGame).toHaveBeenLastCalledWith('Игрок');
	});
});
