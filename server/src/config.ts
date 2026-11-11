import fs from 'fs';
import os from 'os';
import path from 'path';

/** Player-facing configuration of a locally running SIGame server. */
export interface LocalServerConfig {
	/** TCP port to listen on. Set to 0 to pick a free port automatically. */
	port: number;

	/** Network interface to bind. 0.0.0.0 exposes the server to the local network. */
	host: string;

	/**
	 * Public base url that players use to reach this server (for example `http://192.168.1.10:8080`).
	 * When omitted the server builds it from `host` and the first non-loopback IPv4 address of the machine.
	 */
	publicBaseUrl: string | null;

	/** Public name of the server (shown in the lobby). */
	name: string;

	/** Directory that contains .siq packages available in the local library. */
	packagesDir: string;

	/** Directory for uploaded packages and extracted media. */
	dataDir: string;

	/** Directory with the built web client (index.html). Served as the site root when present. */
	clientDir: string;

	/** Maximum allowed .siq file size, MB. */
	maxPackageSizeMb: number;

	/** Default game time settings (seconds). */
	timeSettings: {
		timeForChoosingQuestion: number;
		timeForThinkingOnQuestion: number;
		timeForPrintingAnswer: number;
		timeForGivingACat: number;
		timeForMakingStake: number;
		timeForThinkingOnSpecial: number;
		timeOfRound: number;
		timeForChoosingFinalTheme: number;
		timeForFinalThinking: number;
		timeForShowmanDecisions: number;
		timeForRightAnswer: number;
		timeForMediaDelay: number;
		timeForBlockingButton: number;
		partialImageTime: number;
		imageTime: number;
		buttonsAccepting: number;
	};

	/** Bot accounts that can fill empty player slots. */
	botNames: string[];

	/** License text that players accept before joining. */
	license: string;
}

const DEFAULT_TIME_SETTINGS: LocalServerConfig['timeSettings'] = {
	timeForChoosingQuestion: 60,
	timeForThinkingOnQuestion: 30,
	timeForPrintingAnswer: 60,
	timeForGivingACat: 40,
	timeForMakingStake: 30,
	timeForThinkingOnSpecial: 40,
	timeOfRound: 180,
	timeForChoosingFinalTheme: 30,
	timeForFinalThinking: 60,
	timeForShowmanDecisions: 120,
	timeForRightAnswer: 10,
	timeForMediaDelay: 0,
	timeForBlockingButton: 5,
	partialImageTime: 3,
	imageTime: 5,
	buttonsAccepting: 300,
};

const DEFAULT_BOTS = [
	'Иннокентий',
	'Александра',
	'Борис',
	'Василиса',
	'Григорий',
	'Дарья',
	'Евгений',
	'Зоя',
];

function repoRoot(): string {
	const candidates = [path.resolve(__dirname, '..', '..'), path.resolve(__dirname, '..'), process.cwd()];

	for (const candidate of candidates) {
		if (fs.existsSync(path.join(candidate, 'package.json'))) {
			return candidate;
		}
	}

	return process.cwd();
}

function readConfigFile(explicitPath: string | null): Partial<LocalServerConfig> {
	const root = repoRoot();
	const candidates = explicitPath
		? [path.resolve(explicitPath)]
		: [path.join(root, 'server', 'config.json'), path.join(root, 'server.config.json')];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			const text = fs.readFileSync(candidate, 'utf8');

			if (text.trim().length === 0) {
				return {};
			}

			return JSON.parse(text) as Partial<LocalServerConfig>;
		}

		if (explicitPath) {
			throw new Error(`Config file not found: ${candidate}`);
		}
	}

	return {};
}

function getLocalAddress(): string {
	const interfaces = os.networkInterfaces();
	const candidates: string[] = [];

	for (const infos of Object.values(interfaces)) {
		for (const info of infos ?? []) {
			if (info.family !== 'IPv4' || info.internal) {
				continue;
			}

			candidates.push(info.address);
		}
	}

	// Link-local (169.254.x.x, e.g. E2B sandbox) and container-only addresses are not reachable from other machines
	const usable = candidates.filter(address => !address.startsWith('169.254.'));

	const preferred = usable.find(address => address.startsWith('192.168.'))
		?? usable.find(address => address.startsWith('10.'))
		?? usable.find(address => /^172\.(1[6-9]|2\d|3[01])\./.test(address))
		?? usable[0];

	return preferred ?? '127.0.0.1';
}

/** Turns a value into a number, falling back to the default one. */
function numberOr(value: unknown, fallback: number): number {
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/** Loads server configuration from a JSON file and environment variables. */
export function loadConfig(configPath: string | null = null): LocalServerConfig {
	const fileConfig = readConfigFile(configPath);
	const root = repoRoot();

	const port = numberOr(process.env.SI_PORT ?? fileConfig.port, 8080);
	const host = process.env.SI_HOST ?? fileConfig.host ?? '0.0.0.0';

	const publicBaseUrl = (process.env.SI_PUBLIC_URL ?? fileConfig.publicBaseUrl ?? null)?.replace(/\/+$/, '') ?? null;

	return {
		port,
		host,
		publicBaseUrl,
		name: fileConfig.name ?? 'SIGame local server',
		packagesDir: path.resolve(root, process.env.SI_PACKAGES_DIR ?? fileConfig.packagesDir ?? 'server/packages'),
		dataDir: path.resolve(root, process.env.SI_DATA_DIR ?? fileConfig.dataDir ?? 'server/data'),
		clientDir: path.resolve(root, process.env.SI_CLIENT_DIR ?? fileConfig.clientDir ?? 'dist'),
		maxPackageSizeMb: numberOr(fileConfig.maxPackageSizeMb, 512),
		timeSettings: { ...DEFAULT_TIME_SETTINGS, ...(fileConfig.timeSettings ?? {}) },
		botNames: fileConfig.botNames ?? DEFAULT_BOTS,
		license: fileConfig.license ?? 'This game is played for fun. Be kind to each other.',
	};
}

/** Builds the public base url of the server (without a trailing slash). */
export function resolvePublicBaseUrl(config: LocalServerConfig, actualPort: number): string {
	if (config.publicBaseUrl) {
		return config.publicBaseUrl;
	}

	const address = config.host === '0.0.0.0' || config.host === '::' ? getLocalAddress() : config.host;
	return `http://${address}:${actualPort}`;
}

export default loadConfig;
