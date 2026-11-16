import { Game, GameClientConnection } from '../server/src/game/game';
import { LoadedPackage } from '../server/src/game/package';
import { GamePhase, PersonRole } from '../server/src/game/session';

const question = { price: 100, params: { question: { items: [{ type: 'text', value: 'Question', isRef: false, placement: 'screen' }] } },
	right: { answer: ['yes'] } };
const pack = { id: 'themes', rootDir: '.', fileName: 'themes.siq', filePath: 'themes.siq', package: {
	name: 'test', rounds: [{ name: 'Final', type: 'final', themes: [
		{ name: 'A', questions: [question] }, { name: 'B', questions: [question] },
		{ name: 'C', questions: [question] }, { name: 'Empty', questions: [] },
	] }],
} } as LoadedPackage;

describe('Final theme deletion', () => {
	let game: Game;
	let messages: Record<string, string[]>;
	let connections: Record<string, GameClientConnection>;

	beforeEach(() => {
		jest.useFakeTimers({ doNotFake: ['performance'] } as any);
		game = new Game(1, 'test', pack, false, 'host', { onGameChanged: () => {}, log: () => {} }, 'http://example');
		game.setTimeSettings({ timeForChoosingFinalTheme: 5, timeForMakingStake: 5 });
		messages = { Alice: [], Bob: [], Carol: [] };
		connections = {};
		for (const [name, sum] of [['Alice', 100], ['Bob', 200], ['Carol', 0]] as [string, number][]) {
			game.session.players.push({ name, role: PersonRole.Player, isMale: false, isHuman: true, isConnected: true,
				isBot: false, isReady: true, sum, stake: 0, state: 'None', answer: '' });
			// eslint-disable-next-line @typescript-eslint/no-loop-func -- the connection is used by its own player only
			connections[name] = { send: (_target, msg: any) => messages[name].push(msg.Text), sendClose: () => {} };
			game.attachConnection(name, connections[name]);
		}
		game.startFinalRound(0);
	});
	afterEach(() => { game.dispose(); jest.useRealTimers(); });

	it('asks eligible players in turn, rejects invalid deletions and plays the remaining theme', () => {
		expect(messages.Alice).toContain('STAGE\nRound\nFinal\n0\nRemoveOtherThemes');
		expect(messages.Alice).toContain('ROUND_THEMES2\nAllTogether\nA\nB\nC\nEmpty');
		expect(messages.Alice).toContain('OUT\n3');
		game.handleClientMessage('Alice', 'DELETE\n0'); // not invited yet
		jest.advanceTimersByTime(2000);
		expect(messages.Alice).toContain('CHOOSE\n2');
		expect(messages.Bob).not.toContain('CHOOSE\n2');
		game.handleClientMessage('Bob', 'DELETE\n0');
		game.handleClientMessage('Carol', 'DELETE\n1');
		game.handleClientMessage('Alice', 'DELETE\n');
		game.handleClientMessage('Alice', 'DELETE\n3');
		expect(messages.Alice).not.toContain('OUT\n0');
		game.handleClientMessage('Alice', 'DELETE\n0');
		expect(messages.Alice).toContain('OUT\n0');
		game.handleClientMessage('Bob', 'DELETE\n1'); // turn is not open during animation
		expect(messages.Alice).not.toContain('OUT\n1');
		jest.advanceTimersByTime(1000);
		expect(messages.Bob).toContain('CHOOSE\n2');
		game.handleClientMessage('Alice', 'DELETE\n2');
		game.handleClientMessage('Bob', 'DELETE\n2');
		expect(messages.Alice).toContain('OUT\n2');
		jest.advanceTimersByTime(1000);
		expect(game.session.themeIndex).toBe(1);
		expect(messages.Alice).toContain('QUESTIONCAPTION\nB');
		expect(game.session.isQuestionPlaying).toBe(true);
	});

	it('pauses the deletion timer and auto-deletes for an idle player without stale timers changing later turns', () => {
		jest.advanceTimersByTime(2000);
		game.handleClientMessage('Alice', 'PAUSE\n+');
		game.handleClientMessage('Alice', 'DELETE\n0');
		jest.advanceTimersByTime(10000);
		expect(messages.Alice.filter(text => text.startsWith('OUT\n'))).toHaveLength(1);
		game.handleClientMessage('Alice', 'PAUSE\n-');
		jest.advanceTimersByTime(5000);
		expect(messages.Alice.filter(text => text.startsWith('OUT\n'))).toHaveLength(2);
		expect(messages.Alice).toContain('CANCEL');
		jest.advanceTimersByTime(1000);
		jest.advanceTimersByTime(5000);
		expect(messages.Alice.filter(text => text.startsWith('OUT\n'))).toHaveLength(3);
		jest.advanceTimersByTime(1000);
		expect(game.session.phase).toBe(GamePhase.Final);
		expect(game.session.isQuestionPlaying).toBe(true);
	});

	it('rotates the score order so the highest scorer deletes last when the cycle is incomplete', () => {
		game.dispose();
		const more = JSON.parse(JSON.stringify(pack)) as LoadedPackage;
		more.package.rounds[0].themes[3].questions.push(question as any);
		game = new Game(2, 'test', more, false, 'host', { onGameChanged: () => {}, log: () => {} }, 'http://example');
		game.setTimeSettings({ timeForChoosingFinalTheme: 5 });
		for (const [index, name] of ['Alice', 'Bob'].entries()) {
			game.session.players.push({ name, role: PersonRole.Player, isMale: false, isHuman: true, isConnected: true,
				isBot: false, isReady: true, sum: (index + 1) * 100, stake: 0, state: 'None', answer: '' });
			game.attachConnection(name, connections[name]);
		}
		game.startFinalRound(0);
		jest.advanceTimersByTime(2000);
		expect(game.session.chooserIndex).toBe(1);
		game.handleClientMessage('Bob', 'DELETE\n0');
		jest.advanceTimersByTime(1000);
		expect(game.session.chooserIndex).toBe(0);
		game.handleClientMessage('Alice', 'DELETE\n1');
		jest.advanceTimersByTime(1000);
		expect(game.session.chooserIndex).toBe(1);
		game.handleClientMessage('Bob', 'DELETE\n2');
		jest.advanceTimersByTime(1000);
		expect(game.session.themeIndex).toBe(3);
	});

	it('restores removed themes and prompts a reconnected current chooser', () => {
		jest.advanceTimersByTime(2000);
		game.handleClientMessage('Alice', 'DELETE\n0');
		jest.advanceTimersByTime(1000);
		game.detachConnection(connections.Bob);
		expect(game.restoreSeat('Bob', PersonRole.Player, false)).toBe(true);
		game.attachConnection('Bob', connections.Bob);
		messages.Bob.length = 0;
		game.sendFullState('Bob');
		game.onReconnect('Bob');
		expect(messages.Bob).toContain('ROUND_THEMES2\nAllTogether\nA\nB\nC\nEmpty');
		expect(messages.Bob).toContain('OUT\n0');
		expect(messages.Bob).toContain('OUT\n3');
		expect(messages.Bob).toContain('CHOOSE\n2');
		game.handleClientMessage('Bob', 'DELETE\n1');
		jest.advanceTimersByTime(1000);
		expect(game.session.themeIndex).toBe(2);
	});
});
