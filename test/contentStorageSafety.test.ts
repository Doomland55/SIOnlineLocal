import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import {
	isAcceptableHash,
	LocalContentStorage,
	normalizeHashSegment,
	resolveInside,
	sendFile,
} from '../server/src/api/storage';
import {
	isImageFileName,
	parseMultipartFile,
	registerErrorHandling,
	registerRoutes,
	registerStatic,
} from '../server/src/api/routes';
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

	describe('hash normalization', () => {
		/** Hash exactly as `sicontent-client` puts it into the `Content-MD5` header. */
		const clientHeaderHash = (value: string) => crypto
			.createHash('sha1')
			.update(Buffer.from(value))
			.digest('base64');

		it('accepts the padded base64 form that the web client sends', () => {
			// This value has '+', '/' and trailing '=', so it covers the whole alphabet of the header
			const header = 'w0mcJylzCn+AfvuGdqkty2+KP48=';

			expect(clientHeaderHash('example')).toBe(header);
			expect(isAcceptableHash(header)).toBe(true);
			expect(normalizeHashSegment(header)).toBe('w0mcJylzCn-AfvuGdqkty2-KP48');
		});

		it('normalizes every accepted form to the same folder name', () => {
			const expected = 'w0mcJylzCn-AfvuGdqkty2-KP48';

			expect(normalizeHashSegment('w0mcJylzCn+AfvuGdqkty2+KP48=')).toBe(expected);
			expect(normalizeHashSegment('w0mcJylzCn-AfvuGdqkty2-KP48')).toBe(expected);
			expect(normalizeHashSegment('w0mcJylzCn+AfvuGdqkty2+KP48')).toBe(expected);
		});

		it('accepts hashes without padding and decimal hashes', () => {
			expect(isAcceptableHash('qvTGHdzF6KLavt4PO0gs2a6pQ00')).toBe(true);
			expect(isAcceptableHash('12345678901234567890')).toBe(true);
		});

		it('rejects values that are not a hash', () => {
			for (const value of ['..', '.', '../../etc', '..\\..\\windows', '%2e%2e%2fetc', '/etc', 'a/b', '', 'C:\\temp']) {
				expect(isAcceptableHash(value)).toBe(false);
				expect(normalizeHashSegment(value)).toBeNull();
			}

			expect(isAcceptableHash(null)).toBe(false);
			expect(isAcceptableHash(undefined)).toBe(false);
			expect(normalizeHashSegment(undefined)).toBeNull();
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

		it('stores a valid client hash as a single directory, normalized like the client url', () => {
			const uri = storage.savePackage(Buffer.from('x'), 'game.siq', 'w0mcJylzCn+AfvuGdqkty2+KP48=');
			expect(uri).toBe('/api/v1/content/packages/w0mcJylzCn-AfvuGdqkty2-KP48/game.siq');
			expect(fs.existsSync(path.join(dir, 'package', 'w0mcJylzCn-AfvuGdqkty2-KP48', 'game.siq'))).toBe(true);

			// The same file is reachable through the hashes the client could ask for
			expect(storage.getPackagePath('w0mcJylzCn-AfvuGdqkty2-KP48', 'game.siq')).not.toBeNull();
			expect(storage.getPackagePath('w0mcJylzCn+AfvuGdqkty2+KP48=', 'game.siq')).not.toBeNull();
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
		// The uri the content service reports (`/packages/...`, `/avatars/...`) is served by the static part
		registerStatic(app, config, storage, noop);
		// Same order as in the server entry point: the json error handler must be the very last
		registerErrorHandling(app, noop);

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

	it('accepts a package upload with the hash format the web client sends', async () => {
		const { body, contentType } = multipart('game.siq', 'package-bytes');
		// Real header value: raw base64 with `+`, `/` and `=` (see sicontent-client)
		const response = await fetch(`${base}/api/v1/content/packages`, {
			method: 'POST',
			headers: { 'Content-Type': contentType, 'Content-MD5': 'w0mcJylzCn+AfvuGdqkty2+KP48=' },
			body,
		});

		expect(response.status).toBe(200);
		// The stored folder uses the base64url form, which is what the client requests afterwards
		expect(await response.text()).toBe('/api/v1/content/packages/w0mcJylzCn-AfvuGdqkty2-KP48/game.siq');
	});

	// The content service answers a package request with the uri of the stored file, not with the file:
	// `sicontent-client` calls it to check whether a package is already uploaded and puts the body into
	// `PackageInfo.uri`. Returning the bytes there makes the next game creation send the whole package
	// inside the JSON run-game request, which the JSON parser rejects.
	it('answers a stored package with its uri, as the content service does', async () => {
		const { body, contentType } = multipart('game.siq', 'package-bytes');
		const upload = await fetch(`${base}/api/v1/content/packages`, {
			method: 'POST',
			headers: { 'Content-Type': contentType, 'Content-MD5': 'w0mcJylzCn+AfvuGdqkty2+KP48=' },
			body,
		});
		expect(upload.status).toBe(200);

		const response = await fetch(`${base}/api/v1/content/packages/w0mcJylzCn-AfvuGdqkty2-KP48/game.siq`);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/plain');

		const reportedUri = await response.text();
		expect(reportedUri).toBe('/packages/w0mcJylzCn-AfvuGdqkty2-KP48/game.siq');

		// The reported uri must be the thing the game is created with, so it has to download the package
		const download = await fetch(`${base}${reportedUri}`);
		expect(download.status).toBe(200);
		expect(await download.text()).toBe('package-bytes');
	});

	it('keeps answering with a short uri when the package is requested again', async () => {
		const { body, contentType } = multipart('again.siq', 'package-bytes-2');
		const upload = await fetch(`${base}/api/v1/content/packages`, {
			method: 'POST',
			headers: { 'Content-Type': contentType, 'Content-MD5': 'w0mcJylzCn+AfvuGdqkty2+KP48=' },
			body,
		});
		const uploadUri = await upload.text();
		const hash = /packages\/([^/]+)\//.exec(uploadUri)![1];

		// Several room creations in a row use the same package: every lookup must stay a uri
		for (let attempt = 0; attempt < 3; attempt += 1) {
			// eslint-disable-next-line no-await-in-loop
			const response = await fetch(`${base}/api/v1/content/packages/${hash}/again.siq`);
			// eslint-disable-next-line no-await-in-loop
			const uri = await response.text();

			expect(response.status).toBe(200);
			expect(uri.length).toBeLessThan(200);
			expect(uri).toBe(`/packages/${hash}/again.siq`);
		}

		// And a run-game request with that uri still creates a game
		const runGame = await fetch(`${base}/api/v1/games`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				gameSettings: { networkGameName: 'Комната', players: [], showman: { name: 'Ведущий' } },
				packageInfo: {
					type: 0,
					uri: `/packages/${hash}/again.siq`,
					contentServiceUri: null,
					secret: null,
					source: null,
				},
				computerAccounts: [],
			}),
		});

		// The uploaded bytes are not a package, so the server reports a package problem - but in JSON,
		// which is what the client parses. What matters here is that the uri resolves to a file.
		const answer = await runGame.json() as { isSuccess: boolean; errorType: number; };

		expect(runGame.status).toBe(200);
		expect(answer.isSuccess).toBe(false);
		expect(answer.errorType).toBe(4); // BadPackage: the uri was found, the content is not a real .siq
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

		// The uploaded uri is the lookup key: the image itself is served from the uri the service reports
		const lookup = await fetch(base + uri);
		const reportedUri = await lookup.text();

		const image = await fetch(base + reportedUri);
		expect(image.status).toBe(200);
		expect(image.headers.get('x-content-type-options')).toBe('nosniff');
	});

	// `GameServerClient` always calls `response.json()`, so a parser error must not answer with HTML:
	// the client would report "Unexpected token '<', \"<!DOCTYPE ...\" is not valid JSON"
	it('serves the library uri reported by the package list and nothing outside of it', async () => {
		fs.mkdirSync(path.join(dir, 'packages'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'packages', 'library.siq'), 'library-bytes');

		// `/api/v1/packages` advertises `/packages/<fileName>`, so this exact uri must download the file
		const response = await fetch(`${base}/packages/library.siq`);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('library-bytes');

		// Only a plain file name inside the packages directory: no traversal, no other files
		for (const requestPath of ['/packages/..%2Fsecret.txt', '/packages/..%2f..%2fsecret.txt', '/packages/secret.txt']) {
			// eslint-disable-next-line no-await-in-loop
			expect((await fetch(`${base}${requestPath}`)).status).toBe(404);
		}
	});

	it('answers an oversized JSON request with a JSON error instead of an HTML page', async () => {
		const response = await fetch(`${base}/api/v1/games`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ packageInfo: { uri: 'x'.repeat(11 * 1024 * 1024) } }),
		});

		expect(response.status).toBe(413);
		expect(response.headers.get('content-type')).toContain('application/json');

		const body = await response.json() as { errorCode: string; maxSizeMb: number; };

		expect(body.errorCode).toBe('RequestEntityTooLarge');
		expect(body.maxSizeMb).toBe(10);
	});

	it('answers a stored avatar with an image uri', async () => {
		const { body, contentType } = multipart('face.png', 'png-bytes', 'image/png');
		const upload = await fetch(`${base}/api/v1/content/avatars`, {
			method: 'POST',
			headers: { 'Content-Type': contentType },
			body,
		});
		const hash = /avatars\/([^/]+)\//.exec(await upload.text())![1];

		const response = await fetch(`${base}/api/v1/content/avatars/${hash}/face.png`);
		expect(response.status).toBe(200);

		const reportedUri = await response.text();
		expect(reportedUri).toBe(`/avatars/${hash}/face.png`);

		const image = await fetch(`${base}${reportedUri}`);
		expect(image.status).toBe(200);
		expect(image.headers.get('content-type')).toContain('image/png');
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
