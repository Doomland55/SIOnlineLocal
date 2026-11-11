'use strict';

/**
 * Local SIGame server: HTTP + SignalR hubs + game registry.
 *
 * Endpoints implemented (the same contract the web client talks to):
 *   GET  /api/si/servers                     server discovery
 *   GET  /api/v1/info/host                   host info (content services, license)
 *   GET  /api/v1/info/bots                   computer accounts (none)
 *   GET  /api/v1/info/storage-filter/:id     package storages (none)
 *   POST /api/v1/games                       create a game from an uploaded package
 *   GET  /api/v1/games?pin=...               find a game by PIN
 *   *    /api/v1/content/*                   SIContent-compatible content service
 *   GET  /media/:packageHash/:fileName       media files from packages
 *   ws   /sionline  (signalr, MessagePack)   lobby: game list
 *   ws   /sihost    (signalr, MessagePack)   game: join + in-game messages
 *
 * Everything is served from a single origin, so the web client works from a
 * plain http://<lan-ip>:<port>/ address without CORS or mixed-content issues.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { ContentService, computeContentHash, readRequestBody } = require('./content');
const { parseSiq } = require('./package');
const { Game } = require('./game');
const { createHub } = require('./signalr');
const { attachWebSocketServer } = require('./websocket');

const MIME_BY_EXTENSION = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.siq': 'application/zip',
	'.zip': 'application/zip',
	'.manifest': 'text/cache-manifest',
	'.webmanifest': 'application/manifest+json',
};

const DEFAULT_LICENSE = [
	'Локальный сервер SIGame для игры в одной сети.',
	'',
	'Все данные (пакеты вопросов и медиафайлы) хранятся только на этом компьютере.',
	'Игра распространяется на условиях лицензии MIT.',
	'Используя сервер, вы подтверждаете, что имеете права на используемые пакеты вопросов.',
].join('\n');

function getMimeType(filePath) {
	return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function readJson(req, limitBytes = 8 * 1024 * 1024) {
	return readRequestBody(req, limitBytes).then(buffer => {
		if (buffer.length === 0) {
			return {};
		}

		return JSON.parse(buffer.toString('utf8'));
	});
}

function getOrigin(req) {
	const forwardedProto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
	const protocol = forwardedProto || (req.socket && req.socket.encrypted ? 'https' : 'http');
	const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';

	return `${protocol}://${host}`;
}

class LocalGameServer {
	/**
	 * @param {object} options
	 * @param {number} [options.port]
	 * @param {string} [options.host] Interface to bind.
	 * @param {string} options.dataDir Directory for uploaded packages and avatars.
	 * @param {string} [options.clientDir] Directory with the built web client.
	 * @param {string} [options.license] License text shown by the client.
	 * @param {(message: string) => void} [options.log]
	 */
	constructor(options) {
		this.port = options.port || 8080;
		this.host = options.host || '0.0.0.0';
		this.dataDir = options.dataDir;
		this.clientDir = options.clientDir || null;
		this.license = options.license || DEFAULT_LICENSE;
		this.log = options.log || (message => console.log(`[server] ${message}`));

		this.games = new Map();
		this.gamesByPin = new Map();
		this.nextGameId = 1;

		this.contentService = new ContentService({ dataDir: this.dataDir, log: this.log });

		/** SignalR connection id -> { connection, gameId } */
		this.sihostClients = new Map();

		this.sionlineHub = createHub(
			'sionline',
			(connection, target, args) => this.handleLobbyInvoke(connection, target, args)
		);
		this.sihostHub = createHub(
			'sihost',
			(connection, target, args) => this.handleHostInvoke(connection, target, args),
			connection => this.handleHostDisconnect(connection)
		);

		this.server = http.createServer((req, res) => {
			this.handleHttpRequest(req, res).catch(error => {
				this.log(`Request failed: ${error.stack || error}`);
				if (!res.headersSent) {
					res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
				}
				res.end('Internal server error');
			});
		});

		// Track sockets so the server can be stopped quickly even when clients
		// keep long-lived WebSocket connections open.
		this.sockets = new Set();
		this.server.on('connection', socket => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});

		attachWebSocketServer(this.server, (ws, req) => this.handleUpgrade(ws, req));
	}

	// ------------------------------------------------------------------ start

	start() {
		return new Promise((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(this.port, this.host, () => {
				this.server.off('error', reject);
				this.port = this.server.address().port;
				this.log(`Listening on http://${this.host}:${this.port}`);
				resolve(this.port);
			});
		});
	}

	stop() {
		for (const game of this.games.values()) {
			game.dispose();
		}

		this.games.clear();
		this.gamesByPin.clear();

		for (const socket of this.sockets) {
			socket.destroy();
		}

		this.sockets.clear();

		return new Promise(resolve => {
			this.server.close(() => resolve());
		});
	}

	// -------------------------------------------------------------- HTTP glue

	handleUpgrade(ws, req) {
		// Collapse duplicated slashes: some clients concatenate an uri that already
		// ends with a slash with an absolute path, producing '//api/v1/...'.
		const url = new URL(req.url.replace(/\/{2,}/g, '/'), 'http://localhost');
		// SignalR clients append the connection token as a query string, while
		// some transports use an additional '/connect' path segment.
		const hubName = url.pathname.replace(/^\//, '').replace(/\/connect$/, '').replace(/\/$/, '');

		if (hubName === 'sionline') {
			this.sionlineHub.handleConnect(req, ws);
			return;
		}

		if (hubName === 'sihost') {
			this.sihostHub.handleConnect(req, ws);
			return;
		}

		ws.close(1008, `Unknown hub ${url.pathname}`);
	}

	async handleHttpRequest(req, res) {
		if (process.env.SIGAME_DEBUG_HTTP) {
			this.log(`${req.method} ${req.url}`);
		}

		// Collapse duplicated slashes: some clients concatenate an uri that already
		// ends with a slash with an absolute path, producing '//api/v1/...'.
		const url = new URL(req.url.replace(/\/{2,}/g, '/'), 'http://localhost');
		const pathname = decodeURIComponent(url.pathname);

		// Same-origin usage is the normal case; CORS support keeps the dev
		// server (webpack-dev-server on another port) usable as well.
		if (req.headers.origin) {
			res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
			res.setHeader('Access-Control-Allow-Credentials', 'true');
			res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag');
		}

		if (req.method === 'OPTIONS') {
			res.writeHead(204, {
				'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
				'Access-Control-Allow-Headers': (req.headers['access-control-request-headers'] || 'Content-Type, Content-MD5, Accept').toString(),
				'Access-Control-Max-Age': '86400',
			});
			res.end();
			return;
		}

		// SignalR (MessagePack) endpoints.
		if (pathname === '/sionline/negotiate' || pathname === '/sihost/negotiate') {
			const hub = pathname.startsWith('/sionline') ? this.sionlineHub : this.sihostHub;
			hub.handleNegotiate(req, res);
			return;
		}

		if (pathname === '/health') {
			this.sendJson(res, 200, { ok: true, games: this.games.size, version: 1 });
			return;
		}

		// Server discovery: the address is derived from the request, so the
		// client keeps using the same host/ip it has opened the page from.
		if (pathname === '/api/si/servers' || pathname === '/api/si/servers/') {
			const origin = getOrigin(req);
			this.sendJson(res, 200, [{
				uri: `${origin}/`,
				proxyUri: null,
				protocolVersion: 13,
			}]);
			return;
		}

		if (pathname === '/api/v1/info/host') {
			const origin = getOrigin(req);
			this.sendJson(res, 200, {
				name: 'Локальный сервер SIGame',
				host: req.headers.host || 'localhost',
				siHosts: {},
				port: Number(req.socket.localPort) || this.port,
				// null makes the client resolve <SERVERHOST> to the server address
				// it has discovered, which keeps media working over any LAN ip.
				contentPublicBaseUrls: null,
				license: this.license,
				maxPackageSizeMb: 256,
				contentInfos: [{ serviceUri: origin, region: 'ru' }],
				storageInfos: [],
			});
			return;
		}

		if (pathname === '/api/v1/info/bots') {
			this.sendJson(res, 200, []);
			return;
		}

		if (pathname.startsWith('/api/v1/info/storage-filter/')) {
			this.sendJson(res, 200, { packages: {}, tags: [] });
			return;
		}

		if (pathname === '/api/v1/games' && req.method === 'POST') {
			await this.handleCreateGame(req, res);
			return;
		}

		if (pathname === '/api/v1/games' && req.method === 'GET') {
			const pin = Number(url.searchParams.get('pin'));
			const game = this.gamesByPin.get(pin);

			if (!game) {
				this.sendJson(res, 404, { message: 'Game not found' });
				return;
			}

			this.sendJson(res, 200, { hostUri: `${getOrigin(req)}/`, gameId: game.id });
			return;
		}

		if (pathname === '/api/v1/games/auto' && req.method === 'POST') {
			// Random games require an external package storage, which a local
			// server does not have. The client shows a friendly error.
			this.sendJson(res, 200, {
				isSuccess: false,
				hostUri: '',
				gameId: 0,
				isHost: false,
				errorType: 1,
			});
			return;
		}

		if (pathname === '/api/v1/games/stats') {
			this.sendJson(res, 200, {});
			return;
		}

		if (await this.contentService.handleRequest(req, res)) {
			return;
		}

		if (pathname === '/config.js') {
			this.serveConfigScript(req, res);
			return;
		}

		if (this.clientDir) {
			const served = this.serveStaticFile(req, res, pathname);
			if (served) {
				return;
			}
		}

		this.sendNotFound(res);
	}

	sendJson(res, status, value) {
		const body = JSON.stringify(value);
		res.writeHead(status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': Buffer.byteLength(body),
			'Cache-Control': 'no-store',
		});
		res.end(body);
	}

	sendNotFound(res) {
		res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('Not found');
	}

	// --------------------------------------------------------------- client

	serveConfigScript(req, res) {
		const body = `config = {
	serverDiscoveryUri: '/api/si/servers',
	rootUri: '/',
	ads: '<b></b>',
	rewriteUrl: true,
	forceHttps: false,
	registerServiceWorker: false,
	enableNoSleep: false,
	askForConsent: false,
	siStatisticsServiceUri: '',
	appRegistryServiceUri: '',
	clearUrls: false
};

firebaseConfig = null;

onLoad = function () {
	console.log('SIGame: подключение к локальному серверу');
};
`;

		res.writeHead(200, {
			'Content-Type': 'text/javascript; charset=utf-8',
			'Content-Length': Buffer.byteLength(body),
			'Cache-Control': 'no-store',
		});
		res.end(body);
	}

	/**
	 * Serves the built web client. Unknown paths fall back to index.html so
	 * deep links like /?gameId=5&host=... keep working.
	 * @returns {boolean} true if the request was handled.
	 */
	serveStaticFile(req, res, pathname) {
		const rootDir = path.resolve(this.clientDir);
		let relativePath = pathname.replace(/^\/+/, '');

		if (relativePath === '' || relativePath.endsWith('/')) {
			relativePath += 'index.html';
		}

		let filePath = path.resolve(rootDir, relativePath);

		if (!filePath.startsWith(rootDir + path.sep) && filePath !== rootDir) {
			return false;
		}

		if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
			// SPA fallback.
			filePath = path.join(rootDir, 'index.html');

			if (!fs.existsSync(filePath)) {
				return false;
			}
		}

		const stat = fs.statSync(filePath);
		const isIndex = path.basename(filePath) === 'index.html';

		res.writeHead(200, {
			'Content-Type': getMimeType(filePath),
			'Content-Length': stat.size,
			'Cache-Control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
			'Service-Worker-Allowed': '/',
		});

		if (req.method === 'HEAD') {
			res.end();
			return true;
		}

		fs.createReadStream(filePath).pipe(res);
		return true;
	}

	// ------------------------------------------------------------ game create

	async handleCreateGame(req, res) {
		let request;

		try {
			request = await readJson(req);
		} catch (error) {
			this.log(`Cannot read game request: ${error.message}`);
			this.sendJson(res, 400, { isSuccess: false, hostUri: '', gameId: 0, isHost: false, errorType: 6 });
			return;
		}

		const packageInfo = request.packageInfo || {};
		const origin = getOrigin(req);

		let buffer = null;

		try {
			buffer = await this.loadPackageBuffer(packageInfo, origin);
		} catch (error) {
			this.log(`Cannot load package: ${error.message}`);
		}

		if (!buffer) {
			this.sendJson(res, 200, { isSuccess: false, hostUri: '', gameId: 0, isHost: false, errorType: 1 });
			return;
		}

		const fileName = String(packageInfo.uri || 'package.siq').split('/').pop() || 'package.siq';
		const hash = computeContentHash(buffer);

		let parsedPackage;

		try {
			parsedPackage = parseSiq(buffer, { hash, fileName });
		} catch (error) {
			this.log(`Bad package: ${error.message}`);
			this.sendJson(res, 200, { isSuccess: false, hostUri: '', gameId: 0, isHost: false, errorType: 4 });
			return;
		}

		this.contentService.registerPackage(parsedPackage);

		const gameId = this.nextGameId++;
		const game = new Game({
			id: gameId,
			settings: request.gameSettings || {},
			parsedPackage,
			packageInfo,
			send: (clientId, text) => this.sendToClient(clientId, text),
			baseUrl: () => origin,
			contentService: this.contentService,
			onChanged: changedGame => this.notifyGameChanged(changedGame),
			log: this.log,
		});

		game.lastOrigin = origin;
		this.games.set(gameId, game);
		this.gamesByPin.set(game.pin, game);

		this.log(`Game ${gameId} created: "${game.name}" (package "${parsedPackage.name}", ${parsedPackage.totalQuestions} questions)`);

		this.broadcastLobby('GameCreated', game.getGameInfo(`${origin}/`));

		this.sendJson(res, 200, {
			isSuccess: true,
			hostUri: `${origin}/`,
			gameId,
			isHost: true,
			errorType: 0,
		});
	}

	/**
	 * Reads the package from the local content service or downloads it.
	 * @returns {Promise<Buffer|null>}
	 */
	async loadPackageBuffer(packageInfo, origin) {
		const uri = String(packageInfo.uri || '');

		if (!uri) {
			return null;
		}

		const storedMatch = /(?:^|\/)content\/packages\/([^/]+)\/([^/?#]+)/.exec(uri);

		if (storedMatch) {
			const buffer = this.contentService.readStoredPackage(
				decodeURIComponent(storedMatch[1]),
				decodeURIComponent(storedMatch[2])
			);

			if (buffer) {
				return buffer;
			}
		}

		const contentServiceUri = packageInfo.contentServiceUri || `${origin}/`;
		const absoluteUri = new URL(uri, contentServiceUri.endsWith('/') ? contentServiceUri : `${contentServiceUri}/`).toString();
		const response = await fetch(absoluteUri);

		if (!response.ok) {
			throw new Error(`Package download failed: ${response.status} ${response.statusText}`);
		}

		return Buffer.from(await response.arrayBuffer());
	}

	// ------------------------------------------------------------------ hubs

	handleLobbyInvoke(connection, target, args) {
		if (target === 'GetGamesSlice') {
			const fromId = Number(args[0]) || 0;
			const data = [...this.games.values()]
				.filter(game => game.id >= fromId)
				.map(game => game.getGameInfo(`${this.getConnectionOrigin(connection)}/`));

			return { Data: data, IsLastSlice: true };
		}

		return undefined;
	}

	/** Origin (protocol + host) the given connection was opened through. */
	getConnectionOrigin(connection) {
		const headers = (connection && connection.request && connection.request.headers) || {};
		const host = headers.host || `localhost:${this.port}`;
		const forwardedProto = (headers['x-forwarded-proto'] || '').split(',')[0].trim();

		return `${forwardedProto || 'http'}://${host}`;
	}

	handleHostInvoke(connection, target, args) {
		switch (target) {
			case 'JoinGame2':
				return this.joinGame(connection, args[0] || {});

			case 'TryGetGameInfo': {
				const game = this.games.get(Number(args[0]));
				return game ? game.getGameInfo(`${this.getConnectionOrigin(connection)}/`) : null;
			}

			case 'SendMessage':
				this.handleClientMessage(connection, args[0] || {});
				return true;

			case 'Ping':
				return undefined;

			default:
				this.log(`Unknown host method ${target}`);
				return undefined;
		}
	}

	joinGame(connection, request) {
		const gameId = Number(request.GameId);
		const game = this.games.get(gameId);

		if (!game) {
			return 'GameNotFound';
		}

		// Leave the previous game if the connection is reused.
		const previous = this.sihostClients.get(connection.id);
		if (previous && previous.gameId !== gameId) {
			const previousGame = this.games.get(previous.gameId);
			if (previousGame) {
				previousGame.removeClient(connection.id);
			}
		}

		// Register the connection before adding the client: the game sends the
		// initial state snapshot right away, and it must reach this connection.
		this.sihostClients.set(connection.id, { connection, gameId });
		const result = game.addClient({ id: connection.id }, request);

		if (result === 'Success') {
			game.lastOrigin = this.getConnectionOrigin(connection);
			this.log(`Client "${request.UserName}" joined game ${gameId} as ${request.Role}`);
		} else {
			this.sihostClients.delete(connection.id);
			this.log(`Client "${request.UserName}" failed to join game ${gameId}: ${result}`);
		}

		return result;
	}

	handleClientMessage(connection, message) {
		const mapping = this.sihostClients.get(connection.id);

		if (!mapping) {
			return;
		}

		const game = this.games.get(mapping.gameId);

		if (!game) {
			return;
		}

		if (message.IsSystem) {
			if (message.Receiver && message.Receiver !== '@' && message.Receiver !== '*') {
				// Direct message to another client: forward it as-is.
				const target = [...game.clients.values()].find(client => client.name === message.Receiver);

				if (target) {
					this.sendToClient(target.clientId, `REPLIC\n${message.Sender}\n${message.Text}`);
				}

				return;
			}

			game.handleSystemMessage(connection.id, message.Text || '');
			return;
		}

		// Chat message: broadcast to everyone in the game.
		this.broadcastToGame(mapping.gameId, {
			IsSystem: false,
			Sender: message.Sender || '',
			Text: message.Text || '',
		});
	}

	sendToClient(clientId, text) {
		const mapping = this.sihostClients.get(clientId);

		if (!mapping) {
			return;
		}

		mapping.connection.sendInvocation('Receive', {
			IsSystem: true,
			Sender: '@',
			Text: text,
		});
	}

	broadcastToGame(gameId, message) {
		for (const mapping of this.sihostClients.values()) {
			if (mapping.gameId === gameId) {
				mapping.connection.sendInvocation('Receive', message);
			}
		}
	}

	broadcastLobby(eventName, payload) {
		for (const connection of this.sionlineHub.connections) {
			connection.sendInvocation(eventName, payload);
		}
	}

	notifyGameChanged(game) {
		const info = game.getGameInfo(`${game.lastOrigin || `http://localhost:${this.port}`}/`);

		for (const connection of this.sionlineHub.connections) {
			connection.sendInvocation('GameChanged', info);
		}

		const persons = game.getPersons();
		for (const connection of this.sihostHub.connections) {
			connection.sendInvocation('GamePersonsChanged', game.id, persons);
		}
	}

	/** Removes a finished game and notifies the lobby. */
	deleteGame(gameId) {
		const game = this.games.get(gameId);

		if (!game) {
			return;
		}

		game.dispose();
		this.games.delete(gameId);
		this.gamesByPin.delete(game.pin);
		this.broadcastLobby('GameDeleted', gameId);
	}

	/** Called when a sihost connection is closed. */
	handleHostDisconnect(connection) {
		const mapping = this.sihostClients.get(connection.id);

		if (!mapping) {
			return;
		}

		this.sihostClients.delete(connection.id);

		const game = this.games.get(mapping.gameId);
		if (game) {
			game.removeClient(connection.id);
		}
	}
}

module.exports = { LocalGameServer, getOrigin, DEFAULT_LICENSE };
