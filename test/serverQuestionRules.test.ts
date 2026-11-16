import { Game } from '../server/src/game/game';
import { LoadedPackage } from '../server/src/game/package';
import { GamePhase, PersonRole } from '../server/src/game/session';

/** Messages that the players have received in the current test. */
let received: string[] = [];

const textItem = { type: 'text' as const, value: 'вопрос', isRef: false, placement: 'screen' as const };

function question(params: Record<string, unknown> = {}, right = ['Москва']) {
	return {
		price: 100,
		params: { question: { items: [textItem] }, ...params },
		right: { answer: right },
	};
}

const options = {
	answerType: 'select',
	answerOptions: {
		A: { items: [{ ...textItem, value: 'Москва' }] },
		B: { items: [{ ...textItem, value: 'Париж' }] },
		C: { items: [{ ...textItem, value: 'Лондон' }] },
		D: { items: [{ ...textItem, value: 'Казань' }] },
	},
};

function buildGame(questions: unknown[]): Game {
	const loaded = {
		id: 'test', rootDir: '.', fileName: 'test.siq', filePath: 'test.siq',
		package: { name: 'test', rounds: [{ name: 'round', type: '', themes: [{ name: 'theme', questions }] }] },
	} as unknown as LoadedPackage;

	const game = new Game(1, 'test', loaded, false, 'host', { onGameChanged: () => {}, log: () => {} }, 'http://example');

	const connect = (name: string, sum: number) => {
		game.session.players.push({
			name, role: PersonRole.Player, isMale: false, isHuman: true,
			isConnected: true, isBot: false, isReady: true, sum, stake: 0, state: 'None', answer: '',
		});
		game.attachConnection(name, { send: (_target: string, message: any) => received.push(message.Text), sendClose: () => {} });
	};

	connect('Alice', 0);
	connect('Bob', 0);

	return game;
}

/** Starts the first question of the round and waits for the press phase to begin. */
function startQuestion(game: Game) {
	game.startRound(0);
	jest.advanceTimersByTime(1000);
	game.handleClientMessage('Alice', 'CHOICE\n0\n0');

	// Content, the answer options and the transition to the press phase take a few seconds
	jest.advanceTimersByTime(6000);
}

function setupShowman(game: Game, oral = false): string[] {
	const hostMessages: string[] = [];

	Object.assign(game.session.showman, {
		name: 'Host', role: PersonRole.Showman, isHuman: true, isConnected: true, isBot: false,
	});

	game.attachConnection('Host', { send: (_target, message: any) => hostMessages.push(message.Text), sendClose: () => {} });
	game.handleClientMessage('Host', `SET_OPTIONS\nOral\n${oral}`);
	game.setTimeSettings({ timeForThinkingOnQuestion: 5, timeOfRound: 20, timeForPrintingAnswer: 5 });

	return hostMessages;
}

describe('Showman validation factors', () => {
	let game: Game;

	beforeEach(() => {
		jest.useFakeTimers({ doNotFake: ['performance'] } as any);
		received = [];
		game = buildGame([question()]);
	});

	afterEach(() => { game.dispose(); jest.useRealTimers(); });

	it.each([
		['0.5', '+', 50],
		['2', '+', 200],
		['1', '+', 100],
		['0.5', '-', -50],
		['2', '-', -200],
		['1', '-', -100],
	] as [string, string, number][])('applies the factor %s to the %s decision', (factor, sign, expected) => {
		setupShowman(game, true);
		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Host', `VALIDATE\n\n${sign}\n${factor}`);
		expect(game.session.players[0].sum).toBe(expected);
	});

	it('shows the six decisions to the showman of an oral game and hides the answer', () => {
		const hostMessages = setupShowman(game, true);
		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');

		// The answer text is empty (the answer is spoken) and the `+` enables the extra buttons
		const ask = hostMessages.filter(text => text.startsWith('ASK_VALIDATE'));
		expect(ask).toHaveLength(1);
		expect(ask[0]).toBe('ASK_VALIDATE\n0\n\n+');
	});

	it.each([
		['ISRIGHT\n+\n0.5', 50],
		['ISRIGHT\n-\n2', -200],
	] as [string, number][])('understands the older decision message %s', (message, expected) => {
		setupShowman(game, true);
		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Host', message);
		expect(game.session.players[0].sum).toBe(expected);
	});

	it('does not penalise the player when the answer is cancelled', () => {
		setupShowman(game, true);
		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Host', 'VALIDATE\n\n-\n0');
		expect(game.session.players[0].sum).toBe(0);
		expect(game.session.isQuestionPlaying).toBe(true);
	});

	it('ignores a malformed factor instead of awarding a wrong sum', () => {
		setupShowman(game, true);
		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Host', 'VALIDATE\n\n+\nabc');
		expect(game.session.players[0].sum).toBe(100);
	});
});

describe('Question restrictions', () => {
	let game: Game;

	beforeEach(() => {
		jest.useFakeTimers({ doNotFake: ['performance'] } as any);
		received = [];
	});

	afterEach(() => { game.dispose(); jest.useRealTimers(); });

	it('validates a question with answer options on the server without the showman', () => {
		game = buildGame([question(options)]);
		const hostMessages = setupShowman(game, true);

		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');

		// The player is asked for an option, the showman is not asked to assess anything
		expect(received).toContain('ANSWER\nselect');
		expect(hostMessages.some(text => text.startsWith('ASK_VALIDATE'))).toBe(false);

		game.handleClientMessage('Alice', 'ANSWER\nA');
		expect(game.session.players[0].sum).toBe(100);
	});

	it('accepts only an offered option of the question', () => {
		game = buildGame([question(options)]);

		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Alice', 'ANSWER\nМосква');
		expect(game.session.players[0].sum).toBe(100);

		game.handleClientMessage('Bob', 'ANSWER\nA');
		expect(game.session.players[1].sum).toBe(0);
	});

	it('penalises a wrong option by the price of the question', () => {
		game = buildGame([question(options)]);
		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Alice', 'ANSWER\nB');
		expect(game.session.players[0].sum).toBe(-100);
	});

	it('lets only the players above the minimum stake press the button', () => {
		game = buildGame([question({ price: { numberSet: { minimum: 100, maximum: 500, step: 100 } } })]);
		game.session.players[0].sum = 100; // equal to the minimum is not enough
		game.session.players[1].sum = 200;

		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');
		expect(game.session.answererIndex).toBe(-1);
		game.handleClientMessage('Bob', 'I\n0');
		expect(game.session.answererIndex).toBe(1);
	});

	it('ends the question when nobody is allowed to answer it', () => {
		game = buildGame([question({ price: { numberSet: { minimum: 100, maximum: 500, step: 100 } } })]);

		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Bob', 'I\n0');

		expect(game.session.players.map(player => player.sum)).toEqual([0, 0]);
		jest.advanceTimersByTime(30000);
		expect(game.session.isQuestionPlaying).toBe(false);
	});

	it('does not let the chooser answer the question with selectionMode=exceptCurrent', () => {
		game = buildGame([question({ selectionMode: 'exceptCurrent' })]);

		startQuestion(game);
		game.handleClientMessage('Alice', 'I\n0');
		expect(game.session.answererIndex).toBe(-1);
		game.handleClientMessage('Bob', 'I\n0');
		expect(game.session.answererIndex).toBe(1);
	});
});

describe('Showman disconnect', () => {
	let game: Game;

	beforeEach(() => {
		jest.useFakeTimers({ doNotFake: ['performance'] } as any);
		received = [];
		game = buildGame([question()]);
	});

	afterEach(() => { game.dispose(); jest.useRealTimers(); });

	function prepareShowmanGame() {
		const hostConnection = { send: (_target: string, _message: any) => {}, sendClose: () => {} };

		Object.assign(game.session.showman, {
			name: 'Host', role: PersonRole.Showman, isHuman: true, isConnected: true, isBot: false,
		});

		game.attachConnection('Host', hostConnection);
		game.setTimeSettings({ timeForThinkingOnQuestion: 5, timeOfRound: 20, timeForPrintingAnswer: 5 });
		startQuestion(game);

		return hostConnection;
	}

	it('pauses the game when the showman leaves and resumes it when the showman is back', () => {
		const connection = prepareShowmanGame();
		expect(game.session.isQuestionPlaying).toBe(true);

		game.detachConnection(connection);
		expect(received.some(text => text.startsWith('PAUSE\n+'))).toBe(true);

		Object.assign(game.session.showman, { name: 'Host', isHuman: true, isConnected: false, isBot: false });
		game.attachConnection('Host', { send: () => {}, sendClose: () => {} });
		game.setConnected('Host', true);

		expect(received.some(text => text.startsWith('PAUSE\n-'))).toBe(true);
	});

	it('keeps the round frozen until the showman is back', () => {
		const connection = prepareShowmanGame();
		game.detachConnection(connection);

		// The round timeout and the question steps do not run while the game is paused
		jest.advanceTimersByTime(120000);
		expect(game.session.phase).toBe(GamePhase.Round);
		expect(game.session.isQuestionPlaying).toBe(true);

		Object.assign(game.session.showman, { name: 'Host', isHuman: true, isConnected: false, isBot: false });
		game.attachConnection('Host', { send: () => {}, sendClose: () => {} });
		game.setConnected('Host', true);

		expect(game.session.phase).toBe(GamePhase.Round);
		jest.advanceTimersByTime(1000);
		expect(game.session.isQuestionPlaying).toBe(true);
	});

	it('does not pause a game in the lobby', () => {
		const connection = { send: () => {}, sendClose: () => {} };

		Object.assign(game.session.showman, {
			name: 'Host', role: PersonRole.Showman, isHuman: true, isConnected: true, isBot: false,
		});

		game.attachConnection('Host', connection);
		game.detachConnection(connection);

		expect(received.some(text => text.startsWith('PAUSE'))).toBe(false);
		expect(game.session.phase).toBe(GamePhase.Before);
	});
});
