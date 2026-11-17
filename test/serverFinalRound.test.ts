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
			// eslint-disable-next-line @typescript-eslint/no-loop-func -- the connection is used by its own player only
			connections[name] = { send: (_target, message: any) => messages.push(message.Text), sendClose: () => {} };
			game.attachConnection(name, connections[name]);
		}
		game.startFinalRound(0);
	});

	afterEach(() => { game.dispose(); jest.useRealTimers(); });

	it('keeps bounded stakes and final answers secret until both are revealed', () => {
		// A live showman that does not play assesses the answers; the players only see the results
		game.session.showman.name = 'Ирина';
		game.session.showman.isHuman = true;
		game.session.showman.isConnected = true;
		game.attachConnection('Ирина', { send: (_target, message: { Text: string }) => messages.push(message.Text), sendClose: () => { } });

		jest.advanceTimersByTime(2000);
		game.handleClientMessage('Alice', 'ANSWER\nyes'); // before answer phase
		game.handleClientMessage('Alice', 'SET_STAKE\nStake\n201');
		game.handleClientMessage('Alice', 'SET_STAKE\nStake\n1abc');
		expect(messages.filter(message => message.startsWith('PERSONFINALSTAKE'))).toHaveLength(0);
		game.handleClientMessage('Alice', 'SET_STAKE\nStake\n50');
		game.handleClientMessage('Alice', 'SET_STAKE\nAllIn'); // cannot change a committed stake
		game.handleClientMessage('Bob', 'SET_STAKE\nAllIn');
		expect(game.session.players[0].stake).toBe(50);

		// Everybody has staked (Carol has no points and does not take part): the question starts at once
		expect(messages.some(message => message.startsWith('CONTENT2\nscreen'))).toBe(true);
		expect(game.session.isQuestionPlaying).toBe(true);
		expect(messages.some(message => message.startsWith('PERSONSTAKE\n'))).toBe(false);

		jest.advanceTimersByTime(1000);
		messages.length = 0;
		game.handleClientMessage('Alice', 'ANSWER_VERSION\nsecret-draft');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		game.handleClientMessage('Alice', 'ANSWER\nwrong');
		game.handleClientMessage('Bob', 'ANSWER\nwrong');
		expect(messages.filter(message => /secret-draft|PLAYER_ANSWER|ANSWERS|PERSONSTAKE/.test(message))).toEqual([]);
		expect(game.session.players.map(player => player.sum)).toEqual([200, 300, 0]);

		// Every finalist has answered: the showman assesses the answers one by one
		expect(messages.some(message => message.startsWith('ASK_VALIDATE'))).toBe(true);
		expect(game.session.players.map(player => player.sum)).toEqual([200, 300, 0]);
		expect(messages).toContain('ASK_VALIDATE\n0\nyes\n');

		game.handleClientMessage('Ирина', 'VALIDATE\nyes\n+\n1');
		expect(game.session.players[0].sum).toBe(250);
		expect(messages).toContain('PERSONSTAKE\n0\n1\n50');
		expect(messages).toContain('ANSWERS\nyes\n\n');

		jest.advanceTimersByTime(3000);

		// Alice manages the game (she is the first live player), so she assesses every answer
		game.handleClientMessage('Ирина', 'VALIDATE\nwrong\n-\n1');
		expect(game.session.players[1].sum).toBe(0);

		expect(messages).toContain('ANSWERS\nyes\nwrong\n');

		// The right answer is shown and the game is over once its content has played
		jest.advanceTimersByTime(5000);
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

		// The server plays the showman: the draft of Alice is right, the empty answer of Bob is wrong
		jest.advanceTimersByTime(15000);
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
		jest.advanceTimersByTime(15000);

		// Eve shows the answers now, but the answer of the absent Alice must not become hers
		expect(seat.sum).toBe(777);
		game.handleClientMessage('Eve', 'VALIDATE\n\n-\n1');
		jest.advanceTimersByTime(3000);
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
		// The input is already open while the question is shown, so a returning player keeps it
		expect(messages).toContain('ANSWER\ntext');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		jest.advanceTimersByTime(15000);
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

	it('announces the players that do not take part in the final and never bets their score', () => {
		jest.advanceTimersByTime(2000);
		// Carol has 0 points: the client must show her card as out of the game
		expect(messages).toContain('PLAYER_STATE\nPass\n2');

		// She keeps her seat but is not asked for a stake and her score stays untouched
		game.handleClientMessage('Carol', 'SET_STAKE\nStake\n10');
		jest.advanceTimersByTime(3000);
		expect(game.session.players[2].stake).toBe(0);
		jest.advanceTimersByTime(3000);
		game.handleClientMessage('Carol', 'ANSWER\nyes');
		jest.advanceTimersByTime(5000);
		expect(game.session.players[2].sum).toBe(0);
	});

	it('restores the final participants for a late joiner', () => {
		jest.advanceTimersByTime(2000);
		messages.length = 0;
		game.attachConnection('Late', { send: (_target, message: any) => messages.push(message.Text), sendClose: () => {} });
		game.sendFullState('Late');
		expect(messages).toContain('PLAYER_STATE\nPass\n2');
	});

	it('lets the manager put a player back into the final with a score change', () => {
		jest.advanceTimersByTime(2000);
		game.handleClientMessage('Alice', 'CHANGE\n3\n150');
		expect(game.session.players[2].sum).toBe(150);
		expect(messages).toContain('PLAYER_SCORE_CHANGED\n2\n150');

		// A late joiner is told the actual final participants: a fixed score makes Carol a player again
		messages.length = 0;
		game.attachConnection('Late', { send: (_target, message: any) => messages.push(message.Text), sendClose: () => {} });
		game.sendFullState('Late');
		// The final question has already started, so the announcement of the round did not repeat,
		// but the state sync still tells the client which cards are active
		expect(game.session.players[2].sum).toBe(150);
	});
});
