/* eslint-disable no-console */
/**
 * Runs the server scripts (SignalR/API scenarios) against a temporary local server.
 *
 * The scripts expect a running server, so the runner starts one on a free port, waits for its health
 * endpoint and shuts it down afterwards. Sequence is preserved and a failing script stops the run;
 * the exit code reflects the first failure.
 *
 * Usage:
 *   node server/scripts/run-all.js                 # start a server, run every script
 *   node server/scripts/run-all.js --base http://localhost:8080   # use an already running server
 *   node server/scripts/run-all.js smoke-test      # run selected scripts only
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const scriptsDir = __dirname;
const repoRoot = path.resolve(scriptsDir, '..', '..');

/** Scripts in the order they are executed. */
const ALL_SCRIPTS = [
	'seats-test.js',
	'smoke-test.js',
	'signalr-client-test.js',
	'answer-options-test.js',
	'host-rights-test.js',
	'midgame-rules-test.js',
	'validation-factors-test.js',
	'access-test.js',
];

/** Maximum time a single script may run, ms. */
const SCRIPT_TIMEOUT = 180 * 1000;

/** Returns a free TCP port. */
function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

/** Waits until the server answers its health endpoint. */
async function waitForServer(baseUrl, timeoutMs) {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });

			if (response.ok) {
				return;
			}
		} catch {
			// The server is still starting
		}

		await new Promise(resolve => setTimeout(resolve, 250));
	}

	throw new Error(`Сервер не ответил по адресу ${baseUrl} за ${timeoutMs} мс`);
}

/** Starts the local server through ts-node and resolves when it is ready. */
async function startServer(port) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-server-run-'));
	const child = spawn(
		process.execPath,
		[
			path.join(repoRoot, 'node_modules', 'ts-node', 'dist', 'bin.js'),
			'--transpile-only',
			'--project',
			path.join(repoRoot, 'server', 'tsconfig.json'),
			path.join(repoRoot, 'server', 'src', 'index.ts'),
		],
		{
			cwd: repoRoot,
			env: {
				...process.env,
				SI_PORT: String(port),
				SI_HOST: '127.0.0.1',
				SI_DATA_DIR: dataDir,
				SI_PUBLIC_URL: `http://127.0.0.1:${port}`,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);

	const output = [];
	child.stdout.on('data', chunk => output.push(chunk.toString()));
	child.stderr.on('data', chunk => output.push(chunk.toString()));

	const exited = new Promise(resolve => child.once('exit', resolve));
	const baseUrl = `http://127.0.0.1:${port}`;

	try {
		await waitForServer(baseUrl, 60 * 1000);
	} catch (error) {
		child.kill('SIGKILL');
		await exited;
		fs.rmSync(dataDir, { recursive: true, force: true });
		console.error(output.join(''));
		throw error;
	}

	return {
		baseUrl,
		stop: async () => {
			child.kill('SIGTERM');
			const forced = setTimeout(() => child.kill('SIGKILL'), 5000);
			forced.unref();
			await exited;
			clearTimeout(forced);
			fs.rmSync(dataDir, { recursive: true, force: true });
		},
		output,
	};
}

/** Runs a single script and returns its exit code. */
function runScript(name, baseUrl) {
	return new Promise(resolve => {
		const child = spawn(process.execPath, [path.join(scriptsDir, name), baseUrl], {
			cwd: repoRoot,
			env: { ...process.env, SI_BASE_URL: baseUrl },
			stdio: ['ignore', 'inherit', 'inherit'],
		});

		const timeout = setTimeout(() => {
			console.error(`\n${name}: превышено время выполнения, процесс остановлен`);
			child.kill('SIGKILL');
		}, SCRIPT_TIMEOUT);
		timeout.unref();

		child.once('exit', code => {
			clearTimeout(timeout);
			resolve(code ?? 1);
		});
	});
}

async function main() {
	const args = process.argv.slice(2);
	const baseIndex = args.indexOf('--base');
	const explicitBase = baseIndex >= 0 ? args[baseIndex + 1] : null;
	const selected = args.filter((value, index) => !value.startsWith('--') && index !== baseIndex + 1);
	const scripts = selected.length > 0
		? selected.map(name => (name.endsWith('.js') ? name : `${name}.js`))
		: ALL_SCRIPTS;

	for (const name of scripts) {
		if (!fs.existsSync(path.join(scriptsDir, name))) {
			console.error(`Неизвестный сценарий: ${name}`);
			process.exitCode = 1;
			return;
		}
	}

	let server = null;
	let baseUrl = explicitBase;

	try {
		if (!baseUrl) {
			const port = await getFreePort();
			console.log(`Запуск локального сервера на порту ${port}…`);
			server = await startServer(port);
			baseUrl = server.baseUrl;
		} else {
			baseUrl = baseUrl.replace(/\/+$/, '');
			await waitForServer(baseUrl, 10 * 1000);
		}

		for (const name of scripts) {
			console.log(`\n=== ${name} ===`);
			// eslint-disable-next-line no-await-in-loop
			const code = await runScript(name, baseUrl);

			if (code !== 0) {
				console.error(`\nСценарий ${name} завершился с кодом ${code}`);
				process.exitCode = code;
				return;
			}
		}

		console.log(`\nВсе сценарии пройдены (${scripts.length}).`);
	} finally {
		if (server) {
			await server.stop();
		}
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
