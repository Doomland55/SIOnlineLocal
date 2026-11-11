#!/usr/bin/env node
'use strict';

/**
 * SIGame local server command line interface.
 *
 * Usage:
 *   node server/cli.js [--port 8080] [--host 0.0.0.0] [--client dist] [--data data] [--open]
 *
 * The server has no npm dependencies, so it can be started on any machine with
 * Node.js 18+ installed, even without internet access.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { LocalGameServer } = require('./src/server');

const REPO_ROOT = path.resolve(__dirname, '..');

function parseArguments(argv) {
	const options = {
		port: 8080,
		host: '0.0.0.0',
		clientDir: null,
		dataDir: path.join(__dirname, 'data'),
		open: false,
	};

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];

		switch (argument) {
			case '--port':
			case '-p':
				options.port = Number(argv[++index]);
				break;

			case '--host':
				options.host = argv[++index];
				break;

			case '--client':
			case '--client-dir':
				options.clientDir = path.resolve(process.cwd(), argv[++index]);
				break;

			case '--data':
			case '--data-dir':
				options.dataDir = path.resolve(process.cwd(), argv[++index]);
				break;

			case '--open':
				options.open = true;
				break;

			case '--help':
			case '-h':
				options.help = true;
				break;

			default:
				if (argument.startsWith('-')) {
					console.error(`Unknown option: ${argument}`);
					options.help = true;
				}
				break;
		}
	}

	return options;
}

function printHelp() {
	console.log(`SIGame — локальный сервер

Использование:
  node server/cli.js [опции]

Опции:
  --port <число>     Порт (по умолчанию 8080)
  --host <адрес>     Интерфейс прослушивания (по умолчанию 0.0.0.0 — вся сеть)
  --client <путь>    Каталог с собранным веб-клиентом (по умолчанию dist)
  --data <путь>      Каталог для пакетов и аватаров (по умолчанию server/data)
  --open             Открыть браузер после запуска
  -h, --help         Показать эту справку

Перед первым запуском соберите клиент:
  npm install
  npm run build-prod
  node server/cli.js
`);
}

function findClientDir(explicitDir) {
	const candidates = explicitDir
		? [explicitDir]
		: [path.join(REPO_ROOT, 'dist'), path.join(__dirname, '..', 'wwwroot')];

	for (const candidate of candidates) {
		if (candidate && fs.existsSync(path.join(candidate, 'index.html'))) {
			return candidate;
		}
	}

	return explicitDir || null;
}

function getLocalAddresses() {
	const result = [];

	for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
		for (const address of addresses || []) {
			if (address.family === 'IPv4' && !address.internal) {
				result.push({ name, address: address.address });
			}
		}
	}

	return result;
}

function openBrowser(url) {
	const platform = process.platform;
	const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
	const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];

	try {
		const child = spawn(command, args, { detached: true, stdio: 'ignore' });
		child.on('error', () => console.log(`Не удалось открыть браузер. Откройте ${url} вручную.`));
		child.unref();
	} catch {
		console.log(`Откройте ${url} в браузере`);
	}
}

async function main() {
	const options = parseArguments(process.argv.slice(2));

	if (options.help) {
		printHelp();
		return;
	}

	const clientDir = findClientDir(options.clientDir);

	if (!clientDir) {
		console.log('Внимание: собранный веб-клиент не найден (нет dist/index.html).');
		console.log('Игроки не смогут открыть игру в браузере, пока клиент не собран.');
		console.log('Соберите клиент командой: npm run build-prod');
		console.log('');
	}

	const server = new LocalGameServer({
		port: options.port,
		host: options.host,
		clientDir,
		dataDir: options.dataDir,
		license: [
			'Локальный сервер SIGame (игра в одной сети).',
			'',
			'Пакеты вопросов и медиафайлы хранятся только на этом компьютере.',
			'Продолжая, вы подтверждаете, что имеете права на используемые пакеты вопросов.',
		].join('\n'),
		log: message => console.log(`[${new Date().toLocaleTimeString('ru-RU')}] ${message}`),
	});

	const port = await server.start();
	const localUrl = `http://localhost:${port}/`;
	const addresses = getLocalAddresses();

	console.log('');
	console.log('══════════════════════════════════════════════════════════');
	console.log('  Локальный сервер SIGame запущен');
	console.log('══════════════════════════════════════════════════════════');
	console.log(`  На этом компьютере:  ${localUrl}`);

	if (addresses.length === 0) {
		console.log('  В локальной сети:    адрес не найден (нет сетевых интерфейсов)');
	} else {
		for (const address of addresses) {
			console.log(`  В локальной сети:    http://${address.address}:${port}/  (${address.name})`);
		}
	}

	console.log('');
	console.log(`  Пакеты вопросов:     ${path.join(options.dataDir, 'packages')}`);
	console.log('  Остановка:           Ctrl+C');
	console.log('══════════════════════════════════════════════════════════');
	console.log('');

	if (options.open) {
		openBrowser(localUrl);
	}

	const shutdown = async () => {
		console.log('\nОстановка сервера…');
		await server.stop();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch(error => {
	console.error('Не удалось запустить сервер:', error);
	process.exit(1);
});
