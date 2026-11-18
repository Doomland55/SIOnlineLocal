import fs from 'fs';
import os from 'os';
import path from 'path';
import { Game } from '../server/src/game/game';
import { LoadedPackage } from '../server/src/game/package';
import { PersonRole } from '../server/src/game/session';

/** Messages that the clients have received in the current test. */
let received: string[] = [];

/** Builds a WAV file of the given duration (the header carries the real duration). */
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

/**
 * Builds a game with a video question and (optionally) answer options.
 * The file is a WAV one renamed to `.mp4`: the duration is read from the header, the name does not matter.
 */
function buildGame(dir: string, withOptions = true): Game {
	fs.writeFileSync(path.join(dir, 'mer.mp4'), buildWav(6));

	const params: Record<string, unknown> = {
		question: {
			items: [
				{ type: 'text', value: 'Что за видео?', isRef: false, placement: 'screen', waitForFinish: false },
				{ type: 'video', value: 'mer.mp4', isRef: true, placement: 'screen', waitForFinish: true },
			],
		},
	};

	if (withOptions) {
		params.answerType = 'select';
		params.answerOptions = {
			A: { items: [{ type: 'text', value: 'Москва', isRef: false, placement: 'screen' }] },
			B: { items: [{ type: 'text', value: 'Париж', isRef: false, placement: 'screen' }] },
			C: { items: [{ type: 'text', value: 'Лондон', isRef: false, placement: 'screen' }] },
			D: { items: [{ type: 'text', value: 'Казань', isRef: false, placement: 'screen' }] },
		};
	}

	const loaded = {
		id: 'test', rootDir: dir, fileName: 'test.siq', filePath: 'test.siq',
		package: {
			name: 'test',
			rounds: [{
				name: 'round', type: '',
				themes: [{ name: 'theme', questions: [{ price: 100, params, right: { answer: ['C'] } }] }],
			}],
		},
	} as unknown as LoadedPackage;

	const game = new Game(1, 'test', loaded, true, 'host', { onGameChanged: () => { }, log: () => { } }, 'http://example');
	game.setTimeSettings({ timeForThinkingOnQuestion: 30, timeOfRound: 300, timeForPrintingAnswer: 30 });

	for (const name of ['Alice', 'Bob']) {
		game.session.players.push({
			name, role: PersonRole.Player, isMale: false, isHuman: true, isConnected: true,
			isBot: false, isReady: true, sum: 0, stake: 0, state: 'None', answer: '',
		});
		// eslint-disable-next-line @typescript-eslint/no-loop-func -- every connection belongs to its own player
		game.attachConnection(name, { send: (_target, message: { Text: string }) => received.push(message.Text), sendClose: () => { } });
	}

	game.session.showman.name = ' ';
	game.session.showman.isHuman = false;
	game.session.showman.isConnected = false;

	return game;
}

/** Starts the first question and waits for the button to become available. */
function startQuestion(game: Game): void {
	game.startRound(0);
	jest.advanceTimersByTime(1000);
	game.handleClientMessage('Alice', 'CHOICE\n0\n0');
	jest.advanceTimersByTime(4000);
}

/** True when a message with the given start has been sent to the clients. */
function hasMessage(prefix: string): boolean {
	return received.some(text => text.startsWith(prefix));
}

describe('Media of a question and the answer of a player', () => {
	let dir: string;
	let game: Game;

	beforeEach(() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the option is missing in the installed typings
		jest.useFakeTimers({ doNotFake: ['performance'] } as any);
		received = [];
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-media-resume-'));
	});

	afterEach(() => {
		game.dispose();
		jest.useRealTimers();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('continues the media from the same place after a wrong answer', () => {
		game = buildGame(dir);
		startQuestion(game);

		game.handleClientMessage('Alice', 'I\n0');
		received = [];

		game.handleClientMessage('Alice', 'ANSWER\nA');

		// The answer is wrong: the media is not stopped by the answer anymore
		expect(game.session.players[0].sum).toBe(-100);
		expect(hasMessage('RESUME')).toBe(true);
	});

	it('does not resume the media when the answer is right: the question is over', () => {
		game = buildGame(dir);
		startQuestion(game);

		game.handleClientMessage('Alice', 'I\n0');
		received = [];

		game.handleClientMessage('Alice', 'ANSWER\nC');

		expect(game.session.players[0].sum).toBe(100);
		expect(hasMessage('RESUME')).toBe(false);
	});

	it('resumes the media when the answer is cancelled by the showman', () => {
		// A question without options is assessed by the showman even in a typed game
		game = buildGame(dir, false);
		game.session.showman.name = 'Ирина';
		game.session.showman.isHuman = true;
		game.session.showman.isConnected = true;
		game.attachConnection('Ирина', { send: () => { }, sendClose: () => { } });
		game.handleClientMessage('Ирина', 'SET_OPTIONS\nOral\ntrue');

		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');
		received = [];

		// The zero multiplier cancels the answer instead of judging it: the question goes on
		game.handleClientMessage('Ирина', 'VALIDATE\n\n-\n0');

		expect(game.session.isQuestionPlaying).toBe(true);
		expect(hasMessage('RESUME')).toBe(true);
	});

	it('does not announce the resume of a question without media', () => {
		const loaded = {
			id: 'test', rootDir: dir, fileName: 'test.siq', filePath: 'test.siq',
			package: {
				name: 'test',
				rounds: [{
					name: 'round', type: '',
					themes: [{
						name: 'theme',
						questions: [{
							price: 100,
							params: {
								question: { items: [{ type: 'text', value: 'Простой вопрос', isRef: false, placement: 'screen' }] },
								answerType: 'select',
								answerOptions: {
									A: { items: [{ type: 'text', value: 'Да', isRef: false, placement: 'screen' }] },
									B: { items: [{ type: 'text', value: 'Нет', isRef: false, placement: 'screen' }] },
								},
							},
							right: { answer: ['A'] },
						}],
					}],
				}],
			},
		} as unknown as LoadedPackage;

		game = new Game(1, 'test', loaded, true, 'host', { onGameChanged: () => { }, log: () => { } }, 'http://example');
		game.setTimeSettings({ timeForThinkingOnQuestion: 30, timeOfRound: 300, timeForPrintingAnswer: 30 });
		game.session.players.push({
			name: 'Alice', role: PersonRole.Player, isMale: false, isHuman: true, isConnected: true,
			isBot: false, isReady: true, sum: 0, stake: 0, state: 'None', answer: '',
		});
		game.attachConnection('Alice', { send: (_target, message: { Text: string }) => received.push(message.Text), sendClose: () => { } });
		game.session.showman.name = ' ';
		game.session.showman.isHuman = false;

		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');
		received = [];

		game.handleClientMessage('Alice', 'ANSWER\nB');

		expect(game.session.players[0].sum).toBe(-100);
		expect(hasMessage('RESUME')).toBe(false);
	});
});

describe('Answer options of a media question', () => {
	let dir: string;
	let game: Game;

	beforeEach(() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the option is missing in the installed typings
		jest.useFakeTimers({ doNotFake: ['performance'] } as any);
		received = [];
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-media-options-'));
	});

	afterEach(() => {
		game.dispose();
		jest.useRealTimers();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** Advances the timers until the first answer option reaches the clients; returns the elapsed time. */
	function waitForFirstOption(limit: number): number {
		const isOptionShown = () => received.some(text => text.startsWith('CONTENT2\nscreen\n1\n'));

		for (let elapsed = 0; elapsed <= limit; elapsed += 100) {
			if (isOptionShown()) {
				return elapsed;
			}

			jest.advanceTimersByTime(100);
		}

		return -1;
	}

	it('shows the options while the media is still playing', () => {
		game = buildGame(dir);
		startQuestion(game);

		const elapsed = waitForFirstOption(5000);

		// The video is six seconds long, so the options appear in the middle of it,
		// together with the button, instead of waiting for its end
		expect(elapsed).toBeGreaterThanOrEqual(0);
		expect(elapsed).toBeLessThan(5900);
		expect(hasMessage('CONTENT2\nscreen\n1\nA\ntext\n\nМосква')).toBe(true);

		// The rest of the options follow, and only then the players may press the button
		jest.advanceTimersByTime(3000);
		expect(hasMessage('CONTENT2\nscreen\n4\nD\ntext\n\nКазань')).toBe(true);
		expect(hasMessage('TRY')).toBe(true);
	});

	it('accepts the option that the player has picked', () => {
		game = buildGame(dir);
		startQuestion(game);

		game.handleClientMessage('Alice', 'I\n0');
		expect(hasMessage('ANSWER\nselect')).toBe(true);

		game.handleClientMessage('Alice', 'ANSWER\nC');
		expect(game.session.players[0].sum).toBe(100);
	});
});
