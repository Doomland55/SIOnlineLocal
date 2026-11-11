import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { LocalServerConfig } from '../config';
import { PackageLibrary } from '../game/library';
import { Lobby } from '../game/lobby';
import { LocalContentStorage, sendFile } from './storage';
import { requestBaseUrl } from './requestContext';
import { isEmptySlotName } from '../game/session';
import {
	GameByPinResponseModel,
	GameCreationResultCode,
	HostInfoModel,
	PackageInfoModel,
	RunAutoGameRequestModel,
	RunGameRequestModel,
	RunGameResponseModel,
} from './models';

/** Maximum size of a package that could be uploaded through the REST API. */
function getPackageLimit(config: LocalServerConfig): string {
	return `${config.maxPackageSizeMb}mb`;
}

/** Reads a raw request body into a buffer (used for .siq uploads). */
async function readBody(request: Request, limitMb: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	const limit = limitMb * 1024 * 1024;

	return new Promise((resolve, reject) => {
		request.on('data', (chunk: Buffer) => {
			total += chunk.length;

			if (total > limit) {
				request.destroy();
				reject(new Error('Package is too large'));
				return;
			}

			chunks.push(chunk);
		});

		request.on('end', () => resolve(Buffer.concat(chunks)));
		request.on('error', reject);
	});
}

/** Extracts the first file from a multipart/form-data body. */
export function parseMultipartFile(body: Buffer, contentType: string): { name: string; data: Buffer } | null {
	const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);

	if (!boundaryMatch) {
		return null;
	}

	const boundary = `--${boundaryMatch[1] ?? boundaryMatch[2]}`;
	const boundaryBuffer = Buffer.from(boundary, 'utf8');
	const parts: Buffer[] = [];

	let index = body.indexOf(boundaryBuffer);

	while (index !== -1) {
		const next = body.indexOf(boundaryBuffer, index + boundaryBuffer.length);

		if (next === -1) {
			break;
		}

		parts.push(body.subarray(index + boundaryBuffer.length, next));
		index = next;
	}

	for (const part of parts) {
		const headerEnd = part.indexOf('\r\n\r\n');

		if (headerEnd === -1) {
			continue;
		}

		const headers = part.subarray(0, headerEnd).toString('utf8');

		if (!/name="file"/i.test(headers)) {
			continue;
		}

		const fileNameMatch = /filename="([^"]*)"/i.exec(headers);
		let data = part.subarray(headerEnd + 4);

		// Strip trailing CRLF that precedes the next boundary
		if (data.subarray(data.length - 2).toString('utf8') === '\r\n') {
			data = data.subarray(0, data.length - 2);
		}

		return {
			name: fileNameMatch?.[1] || 'package.siq',
			data: Buffer.from(data),
		};
	}

	return null;
}

/** Builds host info of the local server. */
export function buildHostInfo(config: LocalServerConfig, publicBaseUrl: string): HostInfoModel {
	return {
		name: config.name,
		host: publicBaseUrl.replace(/^https?:\/\//, ''),
		// A short link `?_local<gameId>` always points to the server the client is opened from
		siHosts: { local: publicBaseUrl },
		port: config.port,
		contentPublicBaseUrls: [publicBaseUrl],
		license: config.license,
		maxPackageSizeMb: config.maxPackageSizeMb,
		contentInfos: [{ serviceUri: requestBaseUrl.getStore() ?? publicBaseUrl, region: 'ru' }],
		storageInfos: [],
	};
}

/** Extracts a package file from a `PackageInfo` descriptor of a run game request. */
async function resolvePackage(
	storage: LocalContentStorage,
	library: PackageLibrary,
	packageInfo: PackageInfoModel,
	log: (message: string) => void,
): Promise<{ filePath: string } | { error: GameCreationResultCode }> {
	const { uri } = packageInfo;

	// packages/<hash>/<name> is stored by our own content service
	const apiMatch = /\/api\/v1\/content\/packages\/([^/]+)\/(.+)$/.exec(uri);

	if (apiMatch) {
		const filePath = storage.getPackagePath(apiMatch[1], decodeURIComponent(apiMatch[2]));

		if (!filePath) {
			return { error: GameCreationResultCode.NoPackage };
		}

		return { filePath };
	}

	// Local library relative uri (`/packages/<name>.siq` or a bare file name)
	const libraryName = decodeURIComponent(uri.replace(/^.*\/packages\//, ''));

	if (libraryName) {
		const candidate = library.findFileByName(libraryName);

		if (candidate) {
			try {
				await library.load(candidate);
				return { filePath: candidate };
			} catch (e) {
				log(`Не удалось прочитать пакет ${libraryName}: ${(e as Error).message}`);
			}
		}
	}

	return { error: GameCreationResultCode.NoPackage };
}

/** Name of the server-driven showman seat in games created through the REST API. */
const DEFAULT_SHOWMAN_NAME = 'Ведущий';

/** Registers REST API routes of the local server. */
export function registerRoutes(
	app: express.Express,
	config: LocalServerConfig,
	publicBaseUrl: string,
	lobby: Lobby,
	library: PackageLibrary,
	storage: LocalContentStorage,
	log: (message: string) => void,
): void {
	// Every request carries the address the client has used to reach the server.
	// Game links and media urls are built from it, so they work for localhost and for LAN ips alike.
	app.use((request, _response, next) => {
		const host = (request.headers['x-forwarded-host'] ?? request.headers.host ?? '').toString();
		const protocol = (request.headers['x-forwarded-proto'] ?? request.protocol ?? 'http').toString();
		const baseUrl = host ? `${protocol}://${host}` : publicBaseUrl;

		requestBaseUrl.run(baseUrl, next);
	});

	// Package uploads are sent as multipart/form-data: read them as raw bytes
	app.use([
		'/api/v1/content/packages',
		'/api/v1/content/avatars',
	], express.raw({ type: 'multipart/form-data', limit: getPackageLimit(config) }));

	app.use(express.json({ limit: '10mb' }));

	// ---------- Content service ----------

	app.get('/api/v1/content/packages/:hash/:name', (request, response) => {
		const filePath = storage.getPackagePath(request.params.hash, request.params.name);

		if (!filePath) {
			response.status(404).json({ errorCode: 'PackageNotFound' });
			return;
		}

		sendFile(response, filePath);
	});

	app.head('/api/v1/content/packages/:hash/:name', (request, response) => {
		const filePath = storage.getPackagePath(request.params.hash, request.params.name);
		response.status(filePath ? 200 : 404).end();
	});

	app.post('/api/v1/content/packages', async (request, response) => {
		try {
			const body = Buffer.isBuffer(request.body)
				? request.body
				: await readBody(request, config.maxPackageSizeMb);

			const file = parseMultipartFile(body, request.headers['content-type'] ?? '');

			if (!file) {
				response.status(400).json({ errorCode: 'BadPackageFile' });
				return;
			}

			const hash = request.headers['content-md5']?.toString();
			const uri = storage.savePackage(file.data, file.name, hash);
			log(`[content] сохранён пакет ${file.name} (${(file.data.length / 1024).toFixed(0)} КБ)`);
			response.type('text/plain').send(uri);
		} catch (e) {
			log(`[content] ошибка загрузки пакета: ${(e as Error).message}`);
			response.status(400).json({ errorCode: 'BadPackageFile' });
		}
	});

	app.get('/api/v1/content/avatars/:hash/:name', (request, response) => {
		const filePath = storage.getAvatarPath(request.params.hash, request.params.name);

		if (!filePath) {
			response.status(404).json({ errorCode: 'FileNotFound' });
			return;
		}

		sendFile(response, filePath);
	});

	app.post('/api/v1/content/avatars', async (request, response) => {
		try {
			const body = Buffer.isBuffer(request.body) ? request.body : await readBody(request, 10);
			const file = parseMultipartFile(body, request.headers['content-type'] ?? '');

			if (!file) {
				response.status(400).json({ errorCode: 'BadFile' });
				return;
			}

			response.type('text/plain').send(storage.saveAvatar(file.data, file.name));
		} catch (e) {
			response.status(400).json({ errorCode: 'BadFile' });
		}
	});

	// ---------- Server info ----------

	app.get('/api/v1/info/host', (_request, response) => {
		response.json(buildHostInfo(config, requestBaseUrl.getStore() ?? publicBaseUrl));
	});

	app.get('/api/v1/info/bots', (_request, response) => {
		response.json(config.botNames);
	});

	app.get('/api/v1/info/storage-filter/:storageId', (_request, response) => {
		response.json({ packages: {}, tags: [] });
	});

	// ---------- Package library ----------

	app.get('/api/v1/packages', async (_request, response) => {
		const packages = await library.loadAll();

		response.json(packages.map(pack => ({
			id: pack.id,
			name: pack.package.name,
			fileName: pack.fileName,
			uri: `/packages/${encodeURIComponent(pack.fileName)}`,
			rounds: pack.package.rounds.length,
			questions: pack.package.rounds.reduce(
				(total, round) => total + round.themes.reduce((sum, theme) => sum + theme.questions.length, 0),
				0,
			),
		})));
	});

	// ---------- Games ----------

	app.post('/api/v1/games', async (request, response) => {
		const body = request.body as RunGameRequestModel | undefined;

		if (!body?.gameSettings || !body.packageInfo) {
			response.json({
				isSuccess: false,
				hostUri: requestBaseUrl.getStore() ?? publicBaseUrl,
				gameId: -1,
				isHost: false,
				errorType: GameCreationResultCode.WrongGameSettings,
			} satisfies RunGameResponseModel);
			return;
		}

		try {
			const resolved = await resolvePackage(storage, library, body.packageInfo, log);

			if ('error' in resolved) {
				response.json({
					isSuccess: false,
					hostUri: requestBaseUrl.getStore() ?? publicBaseUrl,
					gameId: -1,
					isHost: false,
					errorType: resolved.error,
				} satisfies RunGameResponseModel);
				return;
			}

			const loaded = await library.load(resolved.filePath);
			const settings = body.gameSettings;
			// An empty showman name means "the server acts as the showman": then any player could take the seat
			const showmanIsHuman = settings.showman?.isHuman === true && Boolean(settings.showman?.name?.trim());
			const showmanName = settings.showman?.name?.trim() || DEFAULT_SHOWMAN_NAME;
			const playerNames = (settings.players ?? [])
				.filter(player => player?.name?.trim() && player.isHuman !== false)
				.map(player => player.name);

			// The client sends human player slots as `Constants.ANY_NAME` (a single space);
			// every such placeholder becomes a free seat that other players could take
			const freeSlots = (settings.players ?? [])
				.filter(player => player?.isHuman !== false && !player?.name?.trim())
				.length;

			const game = lobby.createGame(
				loaded,
				settings.networkGameName,
				showmanName,
				playerNames,
				false,
				freeSlots,
			);

			game.session.showman.isHuman = showmanIsHuman;
			game.session.showman.isBot = !showmanIsHuman;
			game.session.showman.isMale = settings.showman?.isMale !== false;
			game.setTimeSettings(settings.appSettings?.timeSettings as Record<string, number> | undefined);

			// Computer accounts from the game settings fill the remaining seats as bots
			(settings.players ?? [])
				.filter(player => player?.name?.trim() && player.isHuman === false)
				.forEach(player => {
					const bot = game.session.players.find(slot => isEmptySlotName(slot.name));

					if (!bot) {
						return;
					}

					bot.name = player.name;
					bot.isHuman = false;
					bot.isBot = true;
					bot.isMale = player.isMale !== false;
					bot.isReady = true;
				});

			log(`[api] игра ${game.id} создана через REST API: «${game.session.name}»`);

			response.json({
				isSuccess: true,
				hostUri: requestBaseUrl.getStore() ?? publicBaseUrl,
				gameId: game.id,
				isHost: false,
				errorType: GameCreationResultCode.Ok,
			} satisfies RunGameResponseModel);
		} catch (e) {
			log(`[api] не удалось создать игру: ${(e as Error).message}`);
			response.json({
				isSuccess: false,
				hostUri: requestBaseUrl.getStore() ?? publicBaseUrl,
				gameId: -1,
				isHost: false,
				errorType: GameCreationResultCode.BadPackage,
			} satisfies RunGameResponseModel);
		}
	});

	app.post('/api/v1/games/auto', async (request, response) => {
		const body = request.body as RunAutoGameRequestModel | undefined;
		void body;

		const playerName = request.query.player?.toString() || 'Игрок';
		const result = await lobby.createAutomaticGame(playerName);
		response.json(result);
	});

	app.get('/api/v1/games', (request, response) => {
		const pin = Number(request.query.pin);

		if (!Number.isFinite(pin)) {
			response.status(404).json(null);
			return;
		}

		const game = lobby.getGameByPin(pin);

		if (!game) {
			response.status(404).json(null);
			return;
		}

		response.json({
			hostUri: requestBaseUrl.getStore() ?? publicBaseUrl,
			gameId: game.id,
		} satisfies GameByPinResponseModel);
	});

	app.get('/api/v1/games/list', (_request, response) => {
		response.json(lobby.getGames().map(game => ({ gameId: game.id, name: game.session.name })));
	});

	// ---------- Statistics (local server has no statistics service: answer with empty data) ----------

	app.get('/api/v1/games/results', (_request, response) => {
		response.json({ games: [], totalCount: 0 });
	});

	app.get('/api/v1/games/packages', (_request, response) => {
		response.json({ packages: [], totalCount: 0 });
	});

	app.get('/api/v1/games/stats', (_request, response) => {
		response.json({ stats: [] });
	});

	app.get('/api/v1/games/packages/stats', (_request, response) => {
		response.json({ packagesStats: [] });
	});
}

/** Registers static file serving for packages media and the web client. */
export function registerStatic(
	app: express.Express,
	config: LocalServerConfig,
	storage: LocalContentStorage,
	log: (message: string) => void,
): void {
	app.get(/^\/package\/([^/]+)\/(.+)$/, (request, response) => {
		const requestPath = decodeURIComponent(request.path);
		const match = /^\/package\/([^/]+)\/(.+)$/.exec(requestPath);

		if (!match) {
			response.status(404).end();
			return;
		}

		const filePath = storage.getMediaPath(match[1], match[2]);

		if (!filePath) {
			response.status(404).end();
			return;
		}

		sendFile(response, filePath);
	});

	// Local server has no avatar library: avatars are not displayed
	app.get(['/defaultAvatars/:name', '/avatars/:name'], (_request, response) => {
		response.status(404).end();
	});

	// Health check used by scripts and players to verify that the server is reachable
	app.get('/health', (_request, response) => {
		response.json({ ok: true, name: config.name, protocol: 'si-local/1' });
	});

	// Web client
	app.use(express.static(config.clientDir, { index: ['index.html'], fallthrough: true }));

	app.get(/.*/, (request, response, next) => {
		if (request.path.startsWith('/api') || request.path.startsWith('/package')) {
			next();
			return;
		}

		const indexFile = path.join(config.clientDir, 'index.html');

		if (!fs.existsSync(indexFile)) {
			response.status(404).type('text/plain').send(
				'Web client is not built. Run `npm run build-dev` or `npm run serve-dev` to build it.',
			);
			return;
		}

		sendFile(response, indexFile);
	});

	void log;
}

export default registerRoutes;
