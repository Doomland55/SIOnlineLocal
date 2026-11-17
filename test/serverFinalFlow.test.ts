import { Game } from '../server/src/game/game';
import { LoadedPackage } from '../server/src/game/package';
import { GamePhase, PersonRole } from '../server/src/game/session';

const QUESTION = 'Финальный вопрос';
const RIGHT = 'Ставка';

const pack = {
	id: 'final-flow', rootDir: '.', fileName: 'final.siq', filePath: 'final.siq',
	package: {
		name: 'final', rounds: [{
			name: 'Final',
			type: 'final',
			themes: [{
				name: 'theme',
				questions: [{
					price: 100,
					params: { question: { items: [{ type: 'text', value: QUESTION, isRef: false, placement: 'screen' }] } },
					right: { answer: [RIGHT] },
				}],
			}],
		}],
	},
} as LoadedPackage;

describe('Final question flow', () => {
	let game: Game;
	let messages: string[];

	beforeEach(() => {
		jest.useFakeTimers({ doNotFake: ['performance'] } as any);
		messages = [];
		game = new Game(1, 'test', pack, false, 'host', { onGameChanged: () => { }, log: (message: string) => messages.push(`LOG ${message}`) }, 'http://example');
		game.setTimeSettings({ timeForMakingStake: 30, timeForFinalThinking: 30, timeForChoosingQuestion: 5 });

		for (const [name, sum] of [['Alice', 100], ['Bob', 300], ['Carol', 500]] as [string, number][]) {
			game.session.players.push({
				name, role: PersonRole.Player, isMale: false, isHuman: true, isConnected: true,
				isBot: false, isReady: true, sum, stake: 0, state: 'None', answer: '',
			});
			// eslint-disable-next-line @typescript-eslint/no-loop-func -- every connection belongs to its own player
			game.attachConnection(name, { send: (_target, message: { Text: string }) => messages.push(message.Text), sendClose: () => { } });
		}

		// The showman seat is empty, so Alice (the first live player) manages the game
		game.session.showman.name = ' ';
		game.session.showman.isHuman = false;
		game.session.showman.isConnected = false;

		game.startFinalRound(0);
		jest.advanceTimersByTime(2000);
	});

	/** Puts a live showman into the game: the players do not have to judge their own answers. */
	function addShowman(): void {
		game.session.showman.name = 'Ирина';
		game.session.showman.isHuman = true;
		game.session.showman.isConnected = true;
		game.attachConnection('Ирина', { send: (_target, message: { Text: string }) => messages.push(message.Text), sendClose: () => { } });
	}

	afterEach(() => {
		game.dispose();
		jest.useRealTimers();
	});

	it('starts the question as soon as every player has staked', () => {
		expect(messages.some(message => message.startsWith('CONTENT2\nscreen'))).toBe(false);

		game.handleClientMessage('Alice', 'SET_STAKE\nStake\n100');
		game.handleClientMessage('Bob', 'SET_STAKE\nAllIn');

		// Carol is the last one to stake: the rest of the stake timer is skipped
		expect(messages.some(message => message.startsWith('CONTENT2\nscreen'))).toBe(false);
		game.handleClientMessage('Carol', 'SET_STAKE\nStake\n200');
		expect(messages.some(message => message.startsWith('CONTENT2\nscreen'))).toBe(true);
		expect(messages.some(message => message.startsWith('FINALTHINK'))).toBe(false);

		// The answer input is already open while the question is shown
		expect(messages).toContain('ANSWER\ntext');
	});

	it('uses the minimum stake when the stake timer is over', () => {
		jest.advanceTimersByTime(30000);

		// Nobody has staked: every stake is the minimum one
		expect(game.session.players.map(player => player.stake)).toEqual([1, 1, 1]);
		expect(messages.some(message => message.startsWith('CONTENT2\nscreen'))).toBe(true);
	});

	it('skips the answer timer when everybody has answered and keeps a partial answer otherwise', () => {
		game.handleClientMessage('Alice', 'SET_STAKE\nAllIn');
		game.handleClientMessage('Bob', 'SET_STAKE\nAllIn');
		game.handleClientMessage('Carol', 'SET_STAKE\nAllIn');

		// The question is shown for its reading time, then the answer timer runs
		jest.advanceTimersByTime(5000);
		expect(messages.some(message => message.startsWith('FINALTHINK'))).toBe(true);

		game.handleClientMessage('Alice', 'ANSWER\nСтавка');
		game.handleClientMessage('Bob', 'ANSWER\nЧто-то');

		// Carol has not answered: the answers stay hidden and the timer keeps running
		expect(messages.some(message => message.startsWith('ASK_VALIDATE'))).toBe(false);
		expect(messages.some(message => message.startsWith('PLAYER_ANSWER'))).toBe(false);

		// Carol has typed a part of her thought: the timer sends what she has managed to write
		game.handleClientMessage('Carol', 'ANSWER_VERSION\nСтав');
		jest.advanceTimersByTime(40000);

		expect(messages).not.toContain('ASK_VALIDATE\n2\nСтав\n');

		// Nobody shows the answers here, so the server assesses them:
		// Alice is right, Bob and the unfinished thought of Carol are wrong
		expect(game.session.players.map(player => player.sum)).toEqual([200, 0, 0]);
	});

	it('assesses answers one by one and builds a sorted statistics table', () => {
		addShowman();

		// Carol is right, Bob is wrong, Alice is right: 500+500, 300−300, 100+100
		game.handleClientMessage('Alice', 'SET_STAKE\nAllIn');
		game.handleClientMessage('Bob', 'SET_STAKE\nAllIn');
		game.handleClientMessage('Carol', 'SET_STAKE\nAllIn');
		jest.advanceTimersByTime(5000);

		game.handleClientMessage('Alice', 'ANSWER\nСтавка');
		game.handleClientMessage('Bob', 'ANSWER\nне знаю');
		game.handleClientMessage('Carol', 'ANSWER\nСтавка');

		const prompts = messages.filter(message => message.startsWith('ASK_VALIDATE'));
		expect(prompts).toHaveLength(1);

		// Alice
		game.handleClientMessage('Ирина', 'VALIDATE\nСтавка\n+\n1');
		expect(game.session.players[0].sum).toBe(200);
		jest.advanceTimersByTime(3000);

		// Bob
		game.handleClientMessage('Ирина', 'VALIDATE\nне знаю\n-\n1');
		expect(game.session.players[1].sum).toBe(0);
		jest.advanceTimersByTime(3000);

		// Carol
		game.handleClientMessage('Ирина', 'VALIDATE\nСтавка\n+\n1');
		expect(game.session.players[2].sum).toBe(1000);

		// The game ends and the statistics are ordered by the score
		jest.advanceTimersByTime(30000);
		expect(game.session.phase).toBe(GamePhase.Finished);

		const statistics = messages.find(message => message.startsWith('GAME_STATISTICS'));
		expect(statistics?.split('\n')).toEqual([
			'GAME_STATISTICS',
			'Carol', '1', '0', '500', '0',
			'Alice', '1', '0', '100', '0',
			'Bob', '0', '1', '0', '300',
		]);
	});

	it('falls back to the server decision when a finalist manages the game', () => {
		// Alice is the manager and a finalist at once: she cannot assess her own answer
		expect(game.getManagerName()).toBe('Alice');

		game.handleClientMessage('Alice', 'SET_STAKE\nStake\n100');
		game.handleClientMessage('Bob', 'SET_STAKE\nStake\n100');
		game.handleClientMessage('Carol', 'SET_STAKE\nStake\n100');
		jest.advanceTimersByTime(5000);

		game.handleClientMessage('Alice', 'ANSWER\nСтавка');
		game.handleClientMessage('Bob', 'ANSWER\nСтавка');
		game.handleClientMessage('Carol', 'ANSWER\nнет');

		expect(messages.some(message => message.startsWith('ASK_VALIDATE'))).toBe(false);

		// Alice and Bob are right, the answer of Carol is wrong: 100+100, 300+100, 500−100
		jest.advanceTimersByTime(30000);
		expect(game.session.players.map(player => player.sum)).toEqual([200, 400, 400]);
		expect(game.session.phase).toBe(GamePhase.Finished);
	});
});
