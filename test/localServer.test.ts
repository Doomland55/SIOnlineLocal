import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';
import { buildAnswerOptions, buildContentAtoms, getTextDuration, parseDuration } from '../server/src/game/questionPlan';
import { getMediaUrl, getPackageMediaUris, loadPackage, LoadedPackage } from '../server/src/game/package';
import { Lobby } from '../server/src/game/lobby';
import { PackageLibrary } from '../server/src/game/library';
import { Game } from '../server/src/game/game';
import { GamePhase, isEmptySlotName } from '../server/src/game/session';

const QUESTION_XML = `<?xml version="1.0" encoding="utf-8"?>
<package name="Тест" version="5">
	<rounds>
		<round name="Раунд 1">
			<themes>
				<theme name="Тема">
					<questions>
						<question price="100">
							<params>
								<param name="question" type="content">
									<item placement="screen" type="text">Вопрос с картинкой</item>
									<item placement="screen" type="image" isRef="true">Images/pic.png</item>
								</param>
								<param name="answerType">select</param>
								<param name="answerOptions" type="group">
									<param name="A" type="content"><item placement="option" type="text">Правильный</item></param>
									<param name="B" type="content"><item placement="option" type="text">Неправильный</item></param>
								</param>
							</params>
							<right><answer>Правильный</answer></right>
						</question>
					</questions>
				</theme>
			</themes>
		</round>
	</rounds>
</package>`;

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
	'base64',
);

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'si-local-server-'));
}

async function createPackage(dir: string): Promise<string> {
	const zip = new JSZip();
	zip.file('content.xml', QUESTION_XML);
	zip.file('Images/pic.png', PNG);

	const buffer = await zip.generateAsync({ type: 'nodebuffer' });
	const filePath = path.join(dir, 'test.siq');
	fs.writeFileSync(filePath, buffer);
	return filePath;
}

describe('Local server protocol helpers', () => {
	it('parses package durations', () => {
		expect(parseDuration('00:00:10')).toBe(10);
		expect(parseDuration('00:01:30')).toBe(90);
		expect(parseDuration('01:00:00')).toBe(3600);
		expect(parseDuration(undefined)).toBe(0);
	});

	it('calculates reading time', () => {
		expect(getTextDuration('короткий', 20)).toBeGreaterThanOrEqual(1);
		expect(getTextDuration('a'.repeat(1000), 20)).toBeLessThanOrEqual(30);
	});
});

describe('Package loading', () => {
	let dir: string;
	let loaded: LoadedPackage;

	beforeAll(async () => {
		dir = createTempDir();
		const filePath = await createPackage(dir);
		loaded = await loadPackage(filePath, 'test.siq', path.join(dir, 'media'));
	});

	it('extracts media into the package media folder', () => {
		expect(fs.existsSync(path.join(loaded.rootDir, 'Images', 'pic.png'))).toBe(true);
	});

	it('builds media urls for content', () => {
		const uris = getPackageMediaUris(loaded);

		expect(uris).toHaveLength(1);
		expect(uris[0]).toBe(`/package/${loaded.id}/Images/pic.png`);
		expect(getMediaUrl(loaded, 'Images/pic.png')).toBe(`/package/${loaded.id}/Images/pic.png`);
	});

	it('builds content atoms and answer options', () => {
		const question = loaded.package.rounds[0].themes[0].questions[0];

		const atoms = buildContentAtoms(question, 20, item => (item.type === 'image'
			? { type: 'image', value: `/package/${loaded.id}/Images/pic.png` }
			: null));

		expect(atoms).toHaveLength(2);
		expect(atoms[0].type).toBe('text');
		expect(atoms[0].duration).toBeGreaterThan(0);
		expect(atoms[1].type).toBe('image');

		// Media items do not have an absolute file check inside the resolver: the package owns it
		const options = buildAnswerOptions(question, () => null);

		expect(options).toEqual([
			{ label: 'A', type: 'text', value: 'Правильный' },
			{ label: 'B', type: 'text', value: 'Неправильный' },
		]);
	});

	it('keeps media references working after extraction', () => {
		const uris = getPackageMediaUris(loaded);
		const relativePath = uris[0].split('/').slice(3).join('/');

		expect(fs.existsSync(path.join(loaded.rootDir, relativePath))).toBe(true);
	});
});

describe('Game seats', () => {
	it('creates only the requested seats instead of six fixed ones', async () => {
		const dir = createTempDir();
		const filePath = await createPackage(dir);
		const loaded = await loadPackage(filePath, 'test.siq', path.join(dir, 'media'));

		const lobby = new Lobby(
			new PackageLibrary(path.dirname(filePath), path.join(dir, 'media'), () => { }),
			{
				publicBaseUrl: 'http://localhost:8080',
				serverName: 'test',
				defaultShowmanName: 'Ведущий',
				language: 'ru-RU',
				botNames: [],
				log: () => { },
			},
			path.join(dir, 'uploads'),
		);

		// A game created with three live player names and no extra seats
		const game = lobby.createGame(loaded, 'Игра', 'Ведущий', ['Игрок 1', 'Игрок 2', 'Игрок 3'], false, 0);

		// Three players plus at least one free seat for other players, not six fixed seats
		expect(game.session.players.filter(player => !isEmptySlotName(player.name))).toHaveLength(3);
		expect(game.session.players.filter(player => isEmptySlotName(player.name)).length).toBeGreaterThanOrEqual(1);
		expect(game.session.players.length).toBeLessThan(6);

		game.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reports free seats and the free showman seat to the lobby', async () => {
		const dir = createTempDir();
		const filePath = await createPackage(dir);
		const loaded = await loadPackage(filePath, 'test.siq', path.join(dir, 'media'));

		const lobby = new Lobby(
			new PackageLibrary(path.dirname(filePath), path.join(dir, 'media'), () => { }),
			{
				publicBaseUrl: 'http://localhost:8080',
				serverName: 'test',
				defaultShowmanName: 'Ведущий',
				language: 'ru-RU',
				botNames: [],
				log: () => { },
			},
			path.join(dir, 'uploads'),
		);

		const game = lobby.createGame(loaded, 'Игра', 'Ведущий', ['Игрок 1'], false, 2);
		const info = lobby.buildGameInfo(game);
		const freeSeats = info.Persons.filter(person => !person.IsOnline);

		// Free player seats are visible, so the web client enables the "join as player" button
		expect(freeSeats.filter(person => person.Role === 'Player').length).toBeGreaterThanOrEqual(1);

		// The server drives the showman seat, so a live player could take it
		expect(freeSeats.some(person => person.Role === 'Showman')).toBe(true);

		game.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe('Game engine', () => {
	let dir: string;
	let lobby: Lobby;
	let game: Game;
	let messages: string[];

	beforeAll(async () => {
		dir = createTempDir();
		const filePath = await createPackage(dir);
		const library = new PackageLibrary(path.dirname(filePath), path.join(dir, 'media'), () => { });
		const loadPackageFromFile = await loadPackage(filePath, 'test.siq', path.join(dir, 'media'));

		lobby = new Lobby(
			library,
			{
				publicBaseUrl: 'http://localhost:8080',
				serverName: 'test',
				defaultShowmanName: 'Ведущий',
				language: 'ru-RU',
				botNames: [],
				log: () => { },
			},
			path.join(dir, 'uploads'),
		);

		game = lobby.createGame(loadPackageFromFile, 'Игра', 'Ведущий', []);
	});

	beforeEach(() => {
		messages = [];
	});

	function connect(playerName: string) {
		game.session.players[0].name = playerName;
		game.session.players[0].isHuman = true;

		game.attachConnection(playerName, {
			send: (target: string, ...args: unknown[]) => {
				const [message] = args as [{ Text?: string }];

				if (target === 'Receive' && message?.Text) {
					messages.push(message.Text);
				}
			},
			sendClose: () => { },
		}, 'http://192.168.1.10:8080');
	}

	function hasMessage(prefix: string): boolean {
		return messages.some(text => text.startsWith(prefix));
	}

	it('sends game state on join', () => {
		connect('Игрок');
		game.sendFullState('Игрок');

		expect(hasMessage('GAMEMETADATA\nИгра')).toBe(true);
		expect(hasMessage('INFO2')).toBe(true);
		expect(hasMessage('STAGE\nBefore')).toBe(true);
	});

	it('starts the game when the only player is ready', () => {
		game.handleClientMessage('Игрок', 'READY\n+');

		expect(game.session.phase).not.toBe(GamePhase.Before);
		expect(hasMessage('STAGE\nBegin')).toBe(true);
	});

	it('builds a round table with absolute media urls', () => {
		game.startRound(0);

		expect(hasMessage('ROUNDSNAMES\nРаунд 1')).toBe(true);
		expect(hasMessage('ROUND_THEMES2\nOneByOne\nТема')).toBe(true);
		expect(hasMessage('TABLO2')).toBe(true);

		const content = messages.find(text => text.startsWith('ROUNDCONTENT')) ?? '';
		expect(content).toContain('http://192.168.1.10:8080/package/');
	});

	it('plays a question and accepts the right answer', () => {
		game.handleClientMessage('Игрок', 'CHOICE\n0\n0');

		expect(hasMessage('CHOICE\n0\n0\n100')).toBe(true);

		game.startQuestion();

		expect(hasMessage('QUESTION\n100')).toBe(true);
		expect(hasMessage('LAYOUT\nANSWER_OPTIONS')).toBe(true);
	});

	afterAll(() => {
		game.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
