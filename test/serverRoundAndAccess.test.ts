import { Game } from '../server/src/game/game';
import { LoadedPackage } from '../server/src/game/package';
import { Lobby } from '../server/src/game/lobby';
import { PackageLibrary } from '../server/src/game/library';
import { SIHostHub } from '../server/src/hubs/siHostHub';
import { HubConnection } from '../server/src/signalr/hubConnection';
import { GamePhase, PersonRole } from '../server/src/game/session';

const question = (answer: string) => ({
	price: 100,
	params: { question: { items: [{ type: 'text', value: 'Question', isRef: false, placement: 'screen' }] } },
	right: { answer: [answer] },
});

function createGame(questions: any[]) {
	const pack = { id: 'test', rootDir: '.', fileName: 'test.siq', filePath: 'test.siq',
		package: { name: 'test', rounds: [{ name: 'round', type: '', themes: [{ name: 'theme', questions }] }] } } as LoadedPackage;
	const game = new Game(1, 'test', pack, false, 'host', { onGameChanged: () => {}, log: () => {} }, 'http://example');
	game.session.players.push({ name: 'Alice', role: PersonRole.Player, isMale: false, isHuman: true,
		isConnected: true, isBot: false, isReady: true, sum: 0, stake: 0, state: 'None', answer: '' });
	const messages: string[] = [];
	game.attachConnection('Alice', { send: (_target, message: any) => messages.push(message.Text), sendClose: () => {} });
	return { game, messages };
}

describe('Round and access regressions', () => {
	let game: Game;
	beforeEach(() => jest.useFakeTimers({ doNotFake: ['performance'] } as any));
	afterEach(() => { game?.dispose(); jest.useRealTimers(); });

	it.each([['D', 'D', 100], ['D', 'B', -100], ['other', 'B', 100]])(
		'checks SIQ option labels and legacy content (%s, %s)', (right, answer, expected) => {
			const q: any = question(right);
			q.params.answerType = 'select';
			q.params.answerOptions = {
				B: { items: [{ type: 'text', value: 'other' }] },
				D: { items: [{ type: 'text', value: 'correct' }] },
			};
			const created = createGame([q]);
			game = created.game;
			game.startRound(0);
			jest.advanceTimersByTime(1000);
			game.handleClientMessage('Alice', 'CHOICE\n0\n0');
			jest.advanceTimersByTime(4000);
			game.handleClientMessage('Alice', 'I\n0');
			game.handleClientMessage('Alice', `ANSWER\n${answer}`);
			expect(game.session.players[0].sum).toBe(expected);
			expect(created.messages).toContain(`RIGHTANSWER\ntext\n${right === 'other' ? 'B' : 'D'}`);
			expect(created.messages.some(value => value.startsWith('CONTENT2\nscreen\n2\nD\n'))).toBe(true);
		},
	);

	it('keeps the round deadline after a question and freezes it during pause', () => {
		game = createGame([question('yes'), question('yes')]).game;
		game.setTimeSettings({ timeOfRound: 10 });
		game.startRound(0);
		jest.advanceTimersByTime(1000);
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		game.handleClientMessage('Alice', 'PAUSE\n+');
		jest.advanceTimersByTime(20000);
		expect(game.session.phase).toBe(GamePhase.Round);
		game.handleClientMessage('Alice', 'PAUSE\n-');
		jest.advanceTimersByTime(6000);
		expect(game.session.phase).toBe(GamePhase.Round);
		jest.advanceTimersByTime(3000);
		expect(game.session.phase).toBe(GamePhase.Finished);
	});

	it('does not interrupt a question when the round deadline expires', () => {
		game = createGame([question('yes'), question('yes')]).game;
		game.setTimeSettings({ timeOfRound: 3 });
		game.startRound(0);
		jest.advanceTimersByTime(1000);
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
		expect(game.session.isQuestionPlaying).toBe(true);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		expect(game.session.players[0].sum).toBe(100);
		jest.advanceTimersByTime(6000);
		expect(game.session.phase).toBe(GamePhase.Finished);
	});

	it('finishes a question selected immediately before the round deadline', () => {
		game = createGame([question('yes'), question('yes')]).game;
		game.setTimeSettings({ timeOfRound: 2 });
		game.startRound(0);
		jest.advanceTimersByTime(1000);
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
		expect(game.session.isQuestionPlaying).toBe(true);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		jest.advanceTimersByTime(6000);
		expect(game.session.players[0].sum).toBe(100);
		expect(game.session.phase).toBe(GamePhase.Finished);
	});

	it('selects a random question on every idle chooser turn, without stale timeouts', () => {
		const created = createGame([question('yes'), { ...question('yes'), price: 350 }, { ...question('yes'), price: 725 }]);
		game = created.game;
		game.setTimeSettings({ timeForChoosingQuestion: 5, timeOfRound: 120 });
		game.startRound(0);
		jest.advanceTimersByTime(1000);
		expect(created.messages).toContain('TIMER\n2\nGO\n50\n0');
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		jest.advanceTimersByTime(4000);
		expect(game.session.isQuestionPlaying).toBe(false);
		expect(game.session.themes[0].prices).toEqual([-1, 350, 725]);
		jest.advanceTimersByTime(4999);
		expect(game.session.isQuestionPlaying).toBe(false);
		jest.advanceTimersByTime(1);
		expect(game.session.themes[0].prices.filter(price => price >= 0)).toHaveLength(1);
		expect([350, 725]).toContain(game.session.currentPrice);
	});

	it('defers destructive seat changes until a question ends and preserves connected people', () => {
		const created = createGame([question('yes'), question('yes')]);
		game = created.game;
		game.session.players.push({ name: 'Bob', role: PersonRole.Player, isMale: false, isHuman: true,
			isConnected: true, isBot: false, isReady: true, sum: 25, stake: 0, state: 'None', answer: '' });
		game.attachConnection('Bob', { send: () => {}, sendClose: () => {} });
		game.startRound(0);
		jest.advanceTimersByTime(1000);
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
		game.handleClientMessage('Alice', 'CONFIG\nADDTABLE');
		game.handleClientMessage('Alice', 'CONFIG\nCHANGETYPE\nplayer\n1\n-');
		game.handleClientMessage('Alice', 'CONFIG\nDELETETABLE\n0');
		expect(game.session.players).toHaveLength(3);
		expect(game.session.players[1].name).toBe('Bob');
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		jest.advanceTimersByTime(3000);
		expect(game.session.players).toHaveLength(2);
		expect(game.session.players[0].isBot).toBe(true);
		expect(game.session.players[0].sum).toBe(25);
		expect(game.session.viewers.map(p => p.name)).toEqual(expect.arrayContaining(['Alice', 'Bob']));
		expect(game.session.chooserIndex).toBe(-1);
		jest.advanceTimersByTime(1000);
		expect(game.session.chooserIndex).toBe(0);
	});

	it('preserves the package price in the table, chosen question and score', () => {
		const created = createGame([{ ...question('yes'), price: 725 }]);
		game = created.game;
		game.startRound(0);
		expect(created.messages).toContain('TABLO2\n725\n');
		jest.advanceTimersByTime(1000);
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		expect(created.messages).toContain('CHOICE\n0\n0\n725');
		jest.advanceTimersByTime(2500);
		expect(created.messages).toContain('QUESTION\n725');
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
		expect(game.session.players[0].sum).toBe(725);
	});

	it('does not deduct points for a wrong answer to a no-risk question', () => {
		game = createGame([{ ...question('yes'), price: 725, type: 'noRisk' }]).game;
		game.startRound(0);
		jest.advanceTimersByTime(1000);
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Alice', 'ANSWER\nno');
		expect(game.session.players[0].sum).toBe(0);
	});

	it('removes a room after its last connected person leaves, even if bots remain', () => {
		const template = createGame([question('yes')]);
		game = template.game;
		const lobby = new Lobby({} as PackageLibrary, {
			publicBaseUrl: 'http://example', serverName: 'test', defaultShowmanName: 'host',
			language: 'ru', botNames: [], log: () => {},
		}, '.');
		const room = lobby.createGame(game.session.packageInfo, 'room', 'host', ['Bot'], false, 1);
		const hub = new SIHostHub(lobby, () => {});
		const first = { send: () => {}, sendClose: () => {} } as unknown as HubConnection;
		const second = { send: () => {}, sendClose: () => {} } as unknown as HubConnection;
		const join = (connection: HubConnection, name: string) => hub.methods.JoinGame2(connection,
			{ GameId: room.id, UserName: name, Role: 'Viewer', Sex: 'Female' });
		expect(join(first, 'First')).toBe('Success');
		expect(join(second, 'Second')).toBe('Success');
		hub.onClosed(first);
		expect(lobby.getGame(room.id)).toBe(room);
		hub.onClosed(second);
		expect(lobby.getGame(room.id)).toBeNull();
	});

	it('cleans up a created room that nobody ever joins', () => {
		game = createGame([question('yes')]).game;
		const lobby = new Lobby({} as PackageLibrary, {
			publicBaseUrl: 'http://example', serverName: 'test', defaultShowmanName: 'host',
			language: 'ru', botNames: [], log: () => {},
		}, '.');
		const room = lobby.createGame(game.session.packageInfo, 'room', 'host', [], false, 1);
		jest.advanceTimersByTime(59999);
		expect(lobby.getGame(room.id)).toBe(room);
		jest.advanceTimersByTime(1);
		expect(lobby.getGame(room.id)).toBeNull();
	});

	it('publishes the password requirement when the game is created', () => {
		const template = createGame([question('yes')]);
		game = template.game;
		const lobby = new Lobby({} as PackageLibrary, {
			publicBaseUrl: 'http://example', serverName: 'test', defaultShowmanName: 'host',
			language: 'ru', botNames: [], log: () => {},
		}, '.');
		const created: boolean[] = [];
		lobby.addListener({ onGameCreated: (_id, info) => created.push(info.PasswordRequired),
			onGameChanged: () => {}, onGameDeleted: () => {} });
		const protectedGame = lobby.createGame(game.session.packageInfo, 'private', 'host', [], false, 1,
			{ password: 'secret', allowViewers: false });
		expect(created).toEqual([true]);
		expect(lobby.buildGameInfo(protectedGame).PasswordRequired).toBe(true);
		expect(protectedGame.allowViewers).toBe(false);
		protectedGame.dispose();
	});

	it('checks password and viewer permission before reserving or restoring a seat', () => {
		game = createGame([question('yes')]).game;
		game.joinPassword = 'secret';
		game.allowViewers = false;
		const lobby = { getGame: () => game, getGameByPin: () => null, onGamePersonsChanged: () => {}, onGameChanged: () => {} } as unknown as Lobby;
		const hub = new SIHostHub(lobby, () => {});
		const connection = { send: () => {}, sendClose: () => {} } as unknown as HubConnection;
		const request = { GameId: 1, UserName: 'Alice', Role: 'Player' as const, Sex: 'Female' as const };
		expect(hub.methods.JoinGame2(connection, { ...request, Password: 'wrong' })).toBe('WrongPassword');
		expect(hub.methods.JoinGame2(connection, { ...request, Role: 'Viewer', Password: 'secret' })).toBe('ForbiddenRole');
		expect(hub.getGame(connection)).toBeNull();
		game.session.players[0].isConnected = false;
		expect(hub.methods.JoinGame2(connection, { ...request, Password: 'secret' })).toBe('Success');
		expect(hub.getGame(connection)).toBe(game);
	});
});
