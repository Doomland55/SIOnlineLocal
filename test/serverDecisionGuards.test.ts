import { Game } from '../server/src/game/game';
import { LoadedPackage } from '../server/src/game/package';
import { GamePhase, PersonRole } from '../server/src/game/session';

const loaded = {
	id: 'test', rootDir: '.', fileName: 'test.siq', filePath: 'test.siq',
	package: { name: 'test', rounds: [{ name: 'round', type: '', themes: [{ name: 'theme', questions: [
		{ price: 100, params: { question: { items: [{ type: 'text', value: 'question', isRef: false, placement: 'screen' }] } }, right: { answer: ['yes'] } },
	] }] }] },
} as LoadedPackage;

describe('Server decision guards', () => {
	let game: Game;
	const received: string[] = [];

	beforeEach(() => {
		jest.useFakeTimers({ doNotFake: ['performance'] } as any);
		received.length = 0;
		game = new Game(1, 'test', loaded, false, 'host', { onGameChanged: () => {}, log: () => {} }, 'http://example');
		for (const name of ['Alice', 'Bob']) {
			game.session.players.push({ name, role: PersonRole.Player, isMale: false, isHuman: true,
				isConnected: true, isBot: false, isReady: true, sum: 0, stake: 0, state: 'None', answer: '' });
			game.attachConnection(name, { send: (_target, message: any) => received.push(message.Text), sendClose: () => {} });
		}
		game.session.viewers.push({ name: 'Viewer', role: PersonRole.Viewer, isMale: false, isHuman: true,
			isConnected: true, isBot: false, isReady: true, sum: 0, stake: 0, state: 'None', answer: '' });
	});

	afterEach(() => { game.dispose(); jest.useRealTimers(); });

	function startQuestion() {
		game.startRound(0);
		jest.advanceTimersByTime(1000);
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
	}

	it('accepts an answer only from the player who pressed, and rejects it while paused', () => {
		game.startRound(0);
		jest.advanceTimersByTime(1000);
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(1000);
		game.handleClientMessage('Bob', 'ANSWER\nyes');
		expect(game.session.players[1].sum).toBe(0);
		jest.advanceTimersByTime(1500);
		game.handleClientMessage('Alice', 'I\n1');
		game.handleClientMessage('Bob', 'ANSWER\nyes');
		expect(game.session.players[1].sum).toBe(0);
		game.handleClientMessage('Alice', 'PAUSE\n+');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		expect(game.session.players[0].sum).toBe(0);
		game.handleClientMessage('Alice', 'PAUSE\n-');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		expect(game.session.players[0].sum).toBe(100);
	});

	it('does not let another player replace the current answerer', () => {
		startQuestion();
		game.handleClientMessage('Alice', 'I\n1');
		game.handleClientMessage('Bob', 'I\n1');
		expect(game.session.answererIndex).toBe(0);
	});

	it.each(['+', '-'])('waits indefinitely for the live showman to validate an oral answer (%s)', sign => {
		Object.assign(game.session.showman, { name: 'Host', role: PersonRole.Showman, isHuman: true,
			isConnected: true, isBot: false });
		const hostMessages: string[] = [];
		game.attachConnection('Host', { send: (_target, message: any) => hostMessages.push(message.Text), sendClose: () => {} });
		game.handleClientMessage('Host', 'SET_OPTIONS\nOral\ntrue');
		game.setTimeSettings({ timeForThinkingOnQuestion: 5, timeOfRound: 10 });
		startQuestion();
		game.handleClientMessage('Alice', 'I\n0');
		// The trailing `+` asks the client for the full set of decisions, the answer text stays empty
		expect(hostMessages).toContain('ASK_VALIDATE\n0\n\n+');
		expect(received).toContain('TIMER\n2\nSTOP');
		game.handleClientMessage('Bob', 'ANSWER\nyes');
		game.handleClientMessage('Host', 'MOVE\n1');
		jest.advanceTimersByTime(60000);
		expect(game.session.isQuestionPlaying).toBe(true);
		expect(game.session.players[0].sum).toBe(0);
		expect(game.session.players[1].sum).toBe(0);
		expect(hostMessages.filter(text => text.startsWith('ASK_VALIDATE'))).toHaveLength(1);
		game.handleClientMessage('Host', `VALIDATE\n\n${sign}\n1`);
		expect(game.session.players[0].sum).toBe(sign === '+' ? 100 : -100);
		if (sign === '-') {
			jest.advanceTimersByTime(1000);
			game.handleClientMessage('Bob', 'I\n0');
			expect(hostMessages.filter(text => text.startsWith('ASK_VALIDATE'))).toHaveLength(2);
			game.handleClientMessage('Host', 'VALIDATE\n\n+\n1');
			expect(game.session.players[1].sum).toBe(100);
		}
	});

	it('restricts table configuration to the manager during the game', () => {
		game.handleClientMessage('Viewer', 'CONFIG\nDELETETABLE\n0');
		expect(game.session.players).toHaveLength(2);
		game.handleClientMessage('Alice', 'CONFIG\nADDTABLE');
		expect(game.session.players).toHaveLength(3);
		game.startRound(0);
		game.handleClientMessage('Viewer', 'CONFIG\nDELETETABLE\n0');
		expect(game.session.players).toHaveLength(3);
		game.handleClientMessage('Alice', 'CONFIG\nDELETETABLE\n1');
		expect(game.session.players).toHaveLength(2);
		expect(game.session.phase).toBe(GamePhase.Round);
	});

	it('ignores invalid question indices and does not leak answer drafts', () => {
		game.startRound(0);
		jest.advanceTimersByTime(1000);
		expect(() => game.handleClientMessage('Alice', 'CHOICE\ninvalid\n0')).not.toThrow();
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
		game.handleClientMessage('Alice', 'I\n1');
		received.length = 0;
		game.handleClientMessage('Alice', 'ANSWER_VERSION\nsecret');
		expect(received.some(text => text.includes('secret'))).toBe(false);
	});
});
