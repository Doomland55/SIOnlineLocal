import { Game, GameClientConnection } from '../server/src/game/game';
import { LoadedPackage } from '../server/src/game/package';
import { GamePhase, PersonRole } from '../server/src/game/session';

const pack = {
	id: 'final', rootDir: '.', fileName: 'final.siq', filePath: 'final.siq',
	package: { name: 'final', rounds: [{ name: 'Final', type: 'final', themes: [{ name: 'theme', questions: [{
		price: 100, params: { question: { items: [{ type: 'text', value: 'question', isRef: false, placement: 'screen' }] } },
		right: { answer: ['yes'] },
	}] }] }] },
} as LoadedPackage;

describe('Final round decisions', () => {
	let game: Game;
	let messages: string[];
	let connections: Record<string, GameClientConnection>;

	beforeEach(() => {
		jest.useFakeTimers({ doNotFake: ['performance'] } as any);
		game = new Game(1, 'test', pack, false, 'host', { onGameChanged: () => {}, log: () => {} }, 'http://example');
		game.setTimeSettings({ timeForMakingStake: 5, timeForFinalThinking: 5 });
		messages = [];
		connections = {};
		for (const [name, sum] of [['Alice', 200], ['Bob', 300], ['Carol', 0]] as [string, number][]) {
			game.session.players.push({ name, role: PersonRole.Player, isMale: false, isHuman: true, isConnected: true,
				isBot: false, isReady: true, sum, stake: 0, state: 'None', answer: 'old' });
			connections[name] = { send: (_target, message: any) => messages.push(message.Text), sendClose: () => {} };
			game.attachConnection(name, connections[name]);
		}
		game.startFinalRound(0);
	});

	afterEach(() => { game.dispose(); jest.useRealTimers(); });

	it('keeps bounded stakes and final answers secret until both are revealed', () => {
		jest.advanceTimersByTime(2000);
		game.handleClientMessage('Alice', 'ANSWER\nyes'); // before answer phase
		game.handleClientMessage('Alice', 'SET_STAKE\nStake\n201');
		game.handleClientMessage('Alice', 'SET_STAKE\nStake\n1abc');
		game.handleClientMessage('Carol', 'SET_STAKE\nStake\n1');
		expect(messages.filter(message => message.startsWith('PERSONFINALSTAKE'))).toHaveLength(0);
		game.handleClientMessage('Alice', 'SET_STAKE\nStake\n50');
		game.handleClientMessage('Alice', 'SET_STAKE\nAllIn'); // cannot change a committed stake
		game.handleClientMessage('Bob', 'SET_STAKE\nAllIn');
		game.handleClientMessage('Alice', 'PASS');
		expect(game.session.isQuestionPlaying).toBe(true);
		expect(game.session.players[0].stake).toBe(50);
		expect(messages.some(message => message.startsWith('PERSONSTAKE\n'))).toBe(false);
		jest.advanceTimersByTime(6000);
		messages.length = 0;
		game.handleClientMessage('Alice', 'ANSWER_VERSION\nsecret-draft');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		game.handleClientMessage('Alice', 'ANSWER\nwrong');
		game.handleClientMessage('Bob', 'ANSWER\nwrong');
		game.handleClientMessage('Carol', 'ANSWER\nyes');
		expect(messages.some(message => /secret-draft|PLAYER_ANSWER|ANSWERS|PERSONSTAKE/.test(message))).toBe(false);
		expect(game.session.players.map(player => player.sum)).toEqual([200, 300, 0]);
		jest.advanceTimersByTime(5000);
		expect(game.session.players.map(player => player.sum)).toEqual([250, 0, 0]);
		expect(messages).toContain('ANSWERS\nyes\nwrong\n');
		expect(messages).toContain('PERSONSTAKE\n0\n1\n50');
		jest.advanceTimersByTime(3000);
		expect(game.session.phase).toBe(GamePhase.Finished);
	});

	it('uses the default stake and last draft after a timeout, freezing decisions while paused', () => {
		jest.advanceTimersByTime(2000);
		game.handleClientMessage('Alice', 'PAUSE\n+');
		game.handleClientMessage('Alice', 'SET_STAKE\nStake\n100');
		jest.advanceTimersByTime(10000);
		expect(game.session.players[0].stake).toBe(0);
		game.handleClientMessage('Alice', 'PAUSE\n-');
		jest.advanceTimersByTime(6000);
		game.handleClientMessage('Alice', 'ANSWER_VERSION\nyes');
		jest.advanceTimersByTime(5000);
		expect(game.session.players.map(player => player.sum)).toEqual([201, 299, 0]);
	});

	it('does not give the original player’s final decision or score to a new seat occupant', () => {
		jest.advanceTimersByTime(2000);
		game.handleClientMessage('Alice', 'SET_STAKE\nStake\n50');
		game.detachConnection(connections.Alice);
		const seat = game.session.players[0];
		seat.name = 'Eve'; seat.sum = 777; seat.isHuman = true; seat.isConnected = true;
		game.attachConnection('Eve', { send: () => {}, sendClose: () => {} });
		jest.advanceTimersByTime(6000);
		game.handleClientMessage('Eve', 'ANSWER\nyes');
		jest.advanceTimersByTime(5000);
		expect(seat.sum).toBe(777);
		seat.name = ' '; seat.isHuman = false; seat.isConnected = false;
		expect(game.restoreSeat('Alice', PersonRole.Player, false)).toBe(true);
		expect(seat.sum).toBe(150);
	});

	it('resends only the pending decision to a returning finalist', () => {
		jest.advanceTimersByTime(2000);
		game.detachConnection(connections.Alice);
		expect(game.restoreSeat('Alice', PersonRole.Player, false)).toBe(true);
		game.attachConnection('Alice', connections.Alice);
		messages.length = 0;
		game.onReconnect('Alice');
		expect(messages).toContain('ASK_STAKE\nStake,AllIn\n1\n200\n1\nFinalStake');
		game.handleClientMessage('Alice', 'SET_STAKE\nStake\n50');
		game.detachConnection(connections.Alice);
		expect(game.restoreSeat('Alice', PersonRole.Player, false)).toBe(true);
		game.attachConnection('Alice', connections.Alice);
		messages.length = 0;
		game.onReconnect('Alice');
		expect(messages.some(text => text.startsWith('ASK_STAKE'))).toBe(false);
		jest.advanceTimersByTime(6000);
		game.detachConnection(connections.Alice);
		expect(game.restoreSeat('Alice', PersonRole.Player, false)).toBe(true);
		game.attachConnection('Alice', connections.Alice);
		messages.length = 0;
		game.onReconnect('Alice');
		expect(messages).toContain('ANSWER\ntext');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		jest.advanceTimersByTime(5000);
		expect(game.session.players[0].sum).toBe(250);
	});

	it('waits for answer video playback before finishing the final', () => {
		game.dispose();
		const withMedia = JSON.parse(JSON.stringify(pack)) as LoadedPackage;
		withMedia.package.rounds[0].themes[0].questions[0].params.answer = {
			items: [{ type: 'video', value: 'https://example/final.mp4', isRef: false, placement: 'screen' }],
		};
		game = new Game(2, 'test', withMedia, false, 'Alice', { onGameChanged: () => {}, log: () => {} }, 'http://example');
		game.setTimeSettings({ timeForMakingStake: 5, timeForFinalThinking: 5 });
		game.session.players.push({ name: 'Alice', role: PersonRole.Player, isMale: false, isHuman: true,
			isConnected: true, isBot: false, isReady: true, sum: 200, stake: 0, state: 'None', answer: '' });
		game.attachConnection('Alice', connections.Alice);
		game.startFinalRound(0);
		jest.advanceTimersByTime(2000);
		game.handleClientMessage('Alice', 'SET_STAKE\nStake\n50');
		jest.advanceTimersByTime(6000);
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		jest.advanceTimersByTime(15000);
		expect(game.session.phase).toBe(GamePhase.Final);
		game.handleClientMessage('Alice', 'ATOM\nvideo\nhttps://example/final.mp4');
		expect(game.session.phase).toBe(GamePhase.Finished);
	});

	it('does not start a final when no connected player or bot has a positive score', () => {
		game.session.players.forEach(player => { player.sum = 0; });
		jest.advanceTimersByTime(2000);
		expect(game.session.phase).toBe(GamePhase.Finished);
	});
});
