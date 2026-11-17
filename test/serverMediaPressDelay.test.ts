import fs from 'fs';
import os from 'os';
import path from 'path';
import { Game } from '../server/src/game/game';
import { LoadedPackage } from '../server/src/game/package';
import { PersonRole } from '../server/src/game/session';

/** Messages that the players have received in the current test. */
let received: string[] = [];

/** Builds a WAV file of the given duration. */
function buildWav(duration: number, sampleRate = 8000): Buffer {
	const data = Buffer.alloc(Math.round(sampleRate * duration) * 2);
	const header = Buffer.alloc(44);
	header.write('RIFF', 0, 'latin1');
	header.writeUInt32LE(36 + data.length, 4);
	header.write('WAVE', 8, 'latin1');
	header.write('fmt ', 12, 'latin1');
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36, 'latin1');
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

/** Builds a game whose question has a single media item of the given duration. */
function buildGame(dir: string, item: Record<string, unknown>, mediaSeconds: number): Game {
	fs.writeFileSync(path.join(dir, 'sound.wav'), buildWav(mediaSeconds));

	const loaded = {
		id: 'test',
		rootDir: dir,
		fileName: 'test.siq',
		filePath: 'test.siq',
		package: {
			name: 'test',
			rounds: [{
				name: 'round',
				type: '',
				themes: [{
					name: 'theme',
					questions: [{
						price: 100,
						params: { question: { items: [item] } },
						right: { answer: ['Ответ'] },
					}],
				}],
			}],
		},
	} as unknown as LoadedPackage;

	const game = new Game(1, 'test', loaded, false, 'host', { onGameChanged: () => { }, log: () => { } }, 'http://example');

	const addPlayer = (name: string) => {
		game.session.players.push({
			name, role: PersonRole.Player, isMale: false, isHuman: true,
			isConnected: true, isBot: false, isReady: true, sum: 0, stake: 0, state: 'None', answer: '',
		});
		game.attachConnection(name, { send: (_target: string, message: { Text: string }) => received.push(message.Text), sendClose: () => { } });
	};

	addPlayer('Alice');
	addPlayer('Bob');

	return game;
}

/** Starts the first question of the round. */
function startQuestion(game: Game): void {
	game.startRound(0);
	jest.advanceTimersByTime(1000);
	game.handleClientMessage('Alice', 'CHOICE\n0\n0');

	// The question starts one second after the choice
	jest.advanceTimersByTime(1000);
}

/** True when the players are allowed to press the button. */
function canPress(): boolean {
	return received.some(message => message.startsWith('TRY'));
}

/**
 * Measures when the button is enabled, counted from the moment the question content is shown.
 * Returns -1 when the button has not been enabled within `limit` milliseconds.
 */
function pressDelayAfterContent(limit: number): number {
	const isContentShown = () => received.some(message => message.startsWith('CONTENT2\nscreen'));

	// The content of a question is shown half a second after the question starts
	for (let wait = 0; wait < 5000 && !isContentShown(); wait += 100) {
		jest.advanceTimersByTime(100);
	}

	if (!isContentShown()) {
		return -1;
	}

	for (let elapsed = 0; elapsed <= limit; elapsed += 100) {
		if (canPress()) {
			return elapsed;
		}

		jest.advanceTimersByTime(100);
	}

	return canPress() ? limit : -1;
}

describe('Media question press delay', () => {
	let dir: string;

	beforeEach(() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the option is missing in the installed typings
		jest.useFakeTimers({ doNotFake: ['performance'] } as any);
		received = [];
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-press-delay-'));
	});

	afterEach(() => {
		jest.useRealTimers();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('enables the button in the middle of an audio question', () => {
		const game = buildGame(dir, { type: 'audio', value: 'sound.wav', isRef: true, placement: 'screen' }, 4);

		startQuestion(game);

		// The item lasts the whole file (4 s), so the button waits for its middle
		const elapsed = pressDelayAfterContent(3000);

		// Half of the four seconds of the file
		expect(elapsed).toBeGreaterThanOrEqual(1900);
		expect(elapsed).toBeLessThanOrEqual(2200);

		game.dispose();
	});

	it('waits for the duration written in the package', () => {
		const game = buildGame(
			dir,
			{ type: 'video', value: 'sound.wav', isRef: true, placement: 'screen', duration: '00:00:02' },
			6,
		);

		startQuestion(game);

		// `duration="00:00:02"` tells that the meaningful part lasts two seconds
		const elapsed = pressDelayAfterContent(4000);

		// Two seconds from the package, not the half of the six seconds of the file
		expect(elapsed).toBeGreaterThanOrEqual(1900);
		expect(elapsed).toBeLessThanOrEqual(2200);

		game.dispose();
	});

	it('enables the button right away for a text question', () => {
		const game = buildGame(dir, { type: 'text', value: 'Простой вопрос', isRef: false, placement: 'screen' }, 4);

		startQuestion(game);

		// A text is shown as long as it takes to read it: the button follows the content, as before
		const elapsed = pressDelayAfterContent(4000);

		expect(elapsed).toBeGreaterThanOrEqual(0);
		expect(elapsed).toBeLessThanOrEqual(2000);

		game.dispose();
	});

	it('drops the delayed button when the question ends before the middle of the media', () => {
		const game = buildGame(dir, { type: 'audio', value: 'sound.wav', isRef: true, placement: 'screen' }, 8);

		// The round time is shorter than the media: the question ends before the button appears
		game.setTimeSettings({ timeForThinkingOnQuestion: 1, timeOfRound: 1, timeForPrintingAnswer: 5 });
		startQuestion(game);

		jest.advanceTimersByTime(5000);

		expect(game.session.isQuestionPlaying).toBe(false);

		// The timer of the button must not fire after the question has ended
		jest.advanceTimersByTime(20000);
		expect((game as unknown as { pressPending: unknown }).pressPending).toBeNull();
		expect((game as unknown as { pendingSteps: unknown[] }).pendingSteps).toEqual([]);

		game.dispose();
	});
});
