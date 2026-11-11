import express from 'express';
import http from 'http';
import path from 'path';
import { loadConfig, resolvePublicBaseUrl } from './config';
import { HubHost } from './signalr/hubHost';
import { Game } from './game/game';
import { PackageLibrary } from './game/library';
import { Lobby } from './game/lobby';
import { LocalContentStorage } from './api/storage';
import { registerRoutes, registerStatic } from './api/routes';
import { SIHostHub } from './hubs/siHostHub';
import { SIOnlineHub } from './hubs/sionlineHub';

/** Prints a message to the console with a timestamp. */
function log(message: string): void {
	const time = new Date().toLocaleTimeString('ru-RU');
	console.log(`[${time}] ${message}`);
}

async function main() {
	const configPath = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : null;
	const config = loadConfig(configPath);

	const dataDir = config.dataDir;
	const storage = new LocalContentStorage(
		path.join(dataDir, 'package'),
		path.join(dataDir, 'media'),
		path.join(dataDir, 'avatars'),
	);

	const library = new PackageLibrary(
		config.packagesDir,
		path.join(dataDir, 'media'),
		log,
	);

	const app = express();
	const server = http.createServer(app);

	let publicBaseUrl = resolvePublicBaseUrl(config, config.port);

	const lobby = new Lobby(
		library,
		{
			publicBaseUrl,
			serverName: config.name,
			defaultShowmanName: 'Ведущий',
			language: 'ru-RU',
			botNames: config.botNames,
			timeSettings: config.timeSettings as unknown as Record<string, number>,
			log,
		},
		path.join(dataDir, 'uploads'),
	);

	const siHostHub = new SIHostHub(lobby, log);
	const siOnlineHub = new SIOnlineHub(lobby);

	const hubHost = new HubHost({ log }, (hubName, connection) => {
		if (hubName === 'sihost') {
			siHostHub.onClosed(connection);
		} else if (hubName === 'sionline') {
			siOnlineHub.onClosed(connection);
		}
	});

	// Handler wrappers: game hub needs access to the connection (person) of the caller
	hubHost.registerHub('sihost', siHostHub.methods);
	hubHost.registerHub('sionline', siOnlineHub.methods);

	// SignalR negotiation endpoints
	for (const hubName of ['sihost', 'sionline']) {
		app.post(`/${hubName}/negotiate`, (request, response) => {
			const result = hubHost.negotiate(hubName);

			if (!result) {
				response.status(404).end();
				return;
			}

			response.json({
				negotiateVersion: 1,
				connectionId: result.connectionId,
				connectionToken: result.connectionToken,
				availableTransports: [
					{
						transport: 'WebSockets',
						transferFormats: ['Binary'],
					},
				],
			});
		});

		app.post(`/${hubName}`, (request, response) => {
			// Long polling is not supported: the client falls back to WebSockets
			response.status(404).end();
		});
	}

	registerRoutes(app, config, publicBaseUrl, lobby, library, storage, log);
	registerStatic(app, config, storage, log);

	// Uploading packages uses a raw body parser, so it must be registered before the JSON one
	server.on('upgrade', (request, socket, head) => {
		hubHost.handleUpgrade(request, socket, head);
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(config.port, config.host, () => resolve());
	});

	const address = server.address();
	const actualPort = typeof address === 'object' && address ? address.port : config.port;
	publicBaseUrl = resolvePublicBaseUrl(config, actualPort);

	// Re-create the lobby with the actual public url (port could be 0 in the config)
	updatePublicBaseUrl(lobby, publicBaseUrl);

	const packages = await library.loadAll();

	log(`Локальный сервер SIGame запущен: ${publicBaseUrl}`);
	log(`Слушает ${config.host}:${actualPort}`);
	log(`Пакетов в библиотеке: ${packages.length} (${config.packagesDir})`);
	log(`Каталог данных: ${dataDir}`);
	log(`Веб-клиент: ${config.clientDir}`);

	if (packages.length === 0) {
		log('Пакеты не найдены. Положите файлы .siq в каталог packages или загрузите пакет через веб-клиент.');
	} else if (config.startupGames) {
		// Optional: create a game for every package so that players can join right after the server start.
		// Games created from the client are the usual way, so this is disabled in the default config
		for (const pack of packages) {
			lobby.createGame(pack, pack.package.name, 'Ведущий', []);
		}

		log(`Создано игр: ${lobby.getGames().length}. Пин-код игры: /api/v1/games/list`);
	}

	log(`Откройте ${publicBaseUrl} в браузере, чтобы играть.`);
	log('Игры:');
	for (const game of lobby.getGames()) {
		log(`  #${game.id} «${game.session.name}» — ${publicBaseUrl} (пакет ${game.session.packageInfo.fileName})`);
	}

	const shutdown = () => {
		log('Остановка сервера…');
		hubHost.dispose();

		for (const game of lobby.getGames() as Game[]) {
			game.dispose();
		}

		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 2000).unref();
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	void siHostHub;
}

/** Replaces the public base url in the lobby options. */
function updatePublicBaseUrl(lobby: Lobby, publicBaseUrl: string): void {
	const options = (lobby as unknown as { options: { publicBaseUrl: string } }).options;

	if (options) {
		options.publicBaseUrl = publicBaseUrl;
	}
}

main().catch(error => {
	log(`Не удалось запустить сервер: ${(error as Error).stack ?? error}`);
	process.exit(1);
});
