import { Game } from '../server/src/game/game';
import { LoadedPackage } from '../server/src/game/package';
import { GamePhase, PersonRole } from '../server/src/game/session';

const player = (name: string, role = PersonRole.Player) => ({
	name, role, isMale: false, isHuman: true, isConnected: true, isBot: false,
	isReady: true, sum: 0, stake: 0, state: 'None', answer: '',
});
const question = (answerItems: any[] = []) => ({
	price: 100,
	params: { question: { items: [{ type: 'text', value: 'Question', isRef: false, placement: 'screen' }] },
		answer: { items: answerItems } },
	right: { answer: ['yes'] },
});

describe('Reported game regressions', () => {
	let game: Game;
	let messages: Record<string, string[]>;
	const connect = (name: string) => {
		messages[name] = [];
		game.attachConnection(name, { send: (_target, value: any) => messages[name].push(value.Text), sendClose: () => {} });
	};
	const start = (questions: any[]) => {
		const pack = { id: 'test', rootDir: '.', fileName: 'test.siq', filePath: 'test.siq',
			package: { name: 'test', rounds: [{ name: 'round', type: '', themes: [{ name: 'theme', questions }] }] } } as LoadedPackage;
		game = new Game(1, 'test', pack, false, 'Host', { onGameChanged: () => {}, log: () => {} }, 'http://example');
		game.session.showman = player('Host', PersonRole.Showman);
		game.session.players.push(player('Alice'), player('Bob'));
		messages = {};
		for (const name of ['Host', 'Alice', 'Bob']) connect(name);
		game.setTimeSettings({ timeOfRound: 600, timeForChoosingQuestion: 40 });
		game.startRound(0);
		jest.advanceTimersByTime(1000);
	};
	const answerFirst = () => {
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Alice', 'ANSWER\nyes');
	};
	beforeEach(() => jest.useFakeTimers({ doNotFake: ['performance'] } as any));
	afterEach(() => { game?.dispose(); jest.useRealTimers(); });

	it('initializes and broadcasts the room rules provided at creation', () => {
		start([question()]);
		game.setInitialOptions({ oral: true, managed: true, falseStart: true, partialText: true,
			partialImages: true, useApellations: true, displayAnswerOptionsLabels: false, readingSpeed: 47,
			timeSettings: { partialImageTime: 9 } });
		game.setTimeSettings({ timeForBlockingButton: 8 });
		game.sendOptions('Alice');
		const options = messages.Alice.filter(text => text.startsWith('OPTIONS2')).pop()!;
		for (const pair of ['Oral\ntrue', 'Managed\ntrue', 'FalseStart\ntrue', 'PartialText\ntrue',
			'PartialImages\ntrue', 'UseAppellations\ntrue', 'DisplayAnswerOptionsLabels\nfalse',
			'ReadingSpeed\n47', 'PartialImage\n9', 'ButtonBlocking\n8']) expect(options).toContain(pair);
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(5000);
		expect(messages.Alice).toContain('ORAL_ANSWER');
	});

	it('freezes choice and round timers with elapsed values and continues after resume', () => {
		start([question(), question()]);
		jest.advanceTimersByTime(4000);
		game.handleClientMessage('Host', 'PAUSE\n+');
		const pause = messages.Alice.filter(text => text.startsWith('PAUSE\n+')).pop()!.split('\n').slice(2).map(Number);
		expect(pause).toEqual([50, 0, 40]);
		jest.advanceTimersByTime(60000);
		expect(game.session.themeIndex).toBe(-1);
		game.handleClientMessage('Host', 'PAUSE\n-');
		expect(messages.Alice).toContain('PAUSE\n-\n0\n0\n0');
		jest.advanceTimersByTime(35000);
		expect(game.session.themeIndex).toBe(-1);
		jest.advanceTimersByTime(1000);
		expect(game.session.themeIndex).toBe(0);
	});

	it('freezes the press timer and answer timer for their remaining durations', () => {
		start([question(), question()]);
		game.setTimeSettings({ timeOfRound: 600, timeForThinkingOnQuestion: 10, timeForPrintingAnswer: 8 });
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
		jest.advanceTimersByTime(2000);
		game.handleClientMessage('Host', 'PAUSE\n+');
		const pressPause = messages.Alice.filter(text => text.startsWith('PAUSE\n+')).pop()!.split('\n');
		expect(Number(pressPause[3])).toBe(20);
		jest.advanceTimersByTime(30000);
		game.handleClientMessage('Host', 'PAUSE\n-');
		jest.advanceTimersByTime(7000);
		game.handleClientMessage('Alice', 'I\n0');
		expect(messages.Alice).toContain('TIMER\n2\nGO\n80\n0');
		jest.advanceTimersByTime(3000);
		game.handleClientMessage('Host', 'PAUSE\n+');
		const answerPause = messages.Alice.filter(text => text.startsWith('PAUSE\n+')).pop()!.split('\n');
		expect(Number(answerPause[4])).toBe(30);
		jest.advanceTimersByTime(30000);
		expect(game.session.answererIndex).toBe(0);
		game.handleClientMessage('Host', 'PAUSE\n-');
		jest.advanceTimersByTime(4999);
		expect(game.session.answererIndex).toBe(0);
		jest.advanceTimersByTime(1);
		expect(game.session.answererIndex).toBe(-1);
		expect(game.session.players[0].sum).toBe(-100);
	});

	it('expires the press timer once and reveals the answer', () => {
		start([question(), question()]);
		game.setTimeSettings({ timeOfRound: 600, timeForChoosingQuestion: 40, timeForThinkingOnQuestion: 5 });
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
		expect(messages.Alice).toContain('TRY');
		jest.advanceTimersByTime(5000);
		expect(messages.Alice.filter(text => text === 'TRY')).toHaveLength(1);
		expect(messages.Alice).toContain('RIGHTANSWER\ntext\nyes');
	});

	it('does not let the old press deadline restart or finish a later press phase', () => {
		start([question(), question()]);
		game.setTimeSettings({ timeOfRound: 600, timeForThinkingOnQuestion: 10, timeForPrintingAnswer: 20 });
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
		jest.advanceTimersByTime(5000);
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Alice', 'ANSWER\nwrong');
		jest.advanceTimersByTime(1000);
		expect(messages.Alice.filter(text => text === 'TRY')).toHaveLength(2);
		jest.advanceTimersByTime(4000);
		expect(game.session.isQuestionPlaying).toBe(true);
		expect(messages.Alice.filter(text => text === 'TRY')).toHaveLength(2);
		game.handleClientMessage('Bob', 'I\n0');
		game.handleClientMessage('Bob', 'ANSWER\nyes');
		expect(game.session.players[1].sum).toBe(100);
	});

	it('ends immediately when one player passed and the other answered incorrectly', () => {
		start([question(), question()]);
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		jest.advanceTimersByTime(2500);
		game.handleClientMessage('Bob', 'PASS');
		game.handleClientMessage('Alice', 'I\n0');
		game.handleClientMessage('Alice', 'ANSWER\nwrong');
		expect(messages.Alice).toContain('RIGHTANSWER\ntext\nyes');
		expect(game.session.isQuestionPlaying).toBe(false);
	});

	it('lets the showman pick and cancels the player prompt without changing chooser', () => {
		start([question(), question()]);
		expect(messages.Host).toContain('CHOOSE\n1');
		game.handleClientMessage('Bob', 'CHOICE\n0\n0');
		expect(game.session.themeIndex).toBe(-1);
		game.handleClientMessage('Host', 'CHOICE\n0\n1');
		expect(game.session.questionIndex).toBe(1);
		expect(game.session.chooserIndex).toBe(0);
		expect(messages.Alice).toContain('CANCEL');
		jest.advanceTimersByTime(45000);
		expect(game.session.themes[0].prices.filter(price => price === -1)).toHaveLength(1);
	});

	it('advances the current step, not the round, without replaying old timeouts', () => {
		start([question(), question()]);
		game.handleClientMessage('Bob', 'MOVE\n1');
		expect(game.session.themeIndex).toBe(-1);
		game.handleClientMessage('Host', 'PAUSE\n+');
		game.handleClientMessage('Host', 'MOVE\n1');
		expect(game.session.themeIndex).toBe(-1);
		game.handleClientMessage('Host', 'PAUSE\n-');
		game.handleClientMessage('Host', 'MOVE\n1');
		expect(game.session.roundIndex).toBe(0);
		expect(game.session.themeIndex).toBe(0);
		game.handleClientMessage('Host', 'MOVE\n1');
		expect(game.session.isQuestionPlaying).toBe(true);
		game.handleClientMessage('Host', 'MOVE\n1');
		game.handleClientMessage('Host', 'MOVE\n1');
		expect(messages.Alice).toContain('TRY');
		game.handleClientMessage('Host', 'MOVE\n1');
		expect(messages.Alice).toContain('RIGHTANSWER\ntext\nyes');
		expect(game.session.roundIndex).toBe(0);
		jest.advanceTimersByTime(1000);
		expect(messages.Alice.filter(text => text === 'TRY')).toHaveLength(1);
	});

	it('never prompts the previous answerer on subsequent questions without a new press', () => {
		start([question(), question()]);
		answerFirst();
		jest.advanceTimersByTime(4000);
		messages.Alice.length = 0;
		game.handleClientMessage('Alice', 'CHOICE\n0\n1');
		jest.advanceTimersByTime(2500);
		game.onReconnect('Alice');
		expect(messages.Alice.filter(message => message.startsWith('ANSWER\n'))).toEqual([]);
		game.handleClientMessage('Bob', 'I\n0');
		expect(messages.Bob.filter(message => message === 'ANSWER\ntext')).toHaveLength(1);
		expect(messages.Alice.filter(message => message.startsWith('ANSWER\n'))).toEqual([]);
	});

	it('allows the manager to select the next chooser and cancels the previous prompt', () => {
		start([question(), question()]);
		game.handleClientMessage('Alice', 'SETCHOOSER\n1');
		expect(game.session.chooserIndex).toBe(0);
		game.handleClientMessage('Host', 'SETCHOOSER\n999');
		expect(game.session.chooserIndex).toBe(0);
		game.handleClientMessage('Host', 'SETCHOOSER\n1');
		expect(game.session.chooserIndex).toBe(1);
		expect(messages.Alice).toContain('CANCEL');
		expect(messages.Bob).toContain('CHOOSE\n1');
		game.handleClientMessage('Alice', 'CHOICE\n0\n0');
		expect(game.session.themeIndex).toBe(-1);
		game.handleClientMessage('Bob', 'CHOICE\n0\n0');
		expect(game.session.themeIndex).toBe(0);
	});

	it('gives a live showman time to choose the opening player when a bot is first', () => {
		start([question()]);
		game.session.players[0].isHuman = false;
		game.session.players[0].isBot = true;
		game.askToSelectQuestion();
		jest.advanceTimersByTime(3000);
		expect(game.session.themeIndex).toBe(-1);
		game.handleClientMessage('Host', 'SETCHOOSER\n1');
		expect(game.session.chooserIndex).toBe(1);
		jest.advanceTimersByTime(10000);
		expect(game.session.themeIndex).toBe(-1);
	});

	it('does not treat unsupported management commands as avatar updates', () => {
		start([question()]);
		messages.Alice.length = 0;
		game.handleClientMessage('Host', 'CHANGE\nimage\nhttps://example/avatar');
		expect(messages.Alice.some(text => text.startsWith('AVATAR'))).toBe(false);
	});

	it('toggles human and bot using the actual client CHANGETYPE command', () => {
		start([question()]);
		game.handleClientMessage('Host', 'CONFIG\nCHANGETYPE\nplayer\n1');
		expect(game.session.players[1].isBot).toBe(true);
		game.handleClientMessage('Host', 'CONFIG\nCHANGETYPE\nplayer\n1');
		expect(game.session.players[1].isHuman).toBe(true);
		expect(game.session.players[1].isBot).toBe(false);
	});

	it('replays both existing avatar types after INFO for a late joiner', () => {
		start([question()]);
		game.handleClientMessage('Alice', 'AVATAR\nimage\ndata:image/png;base64,AAAA');
		game.handleClientMessage('Alice', 'AVATAR\nvideo\nhttps://example/video');
		game.sendFullState('Bob');
		const infoIndex = messages.Bob.length - 1 - [...messages.Bob].reverse().findIndex(text => text.startsWith('INFO2'));
		expect(messages.Bob.slice(infoIndex)).toContain('AVATAR\nAlice\nimage\ndata:image/png;base64,AAAA');
		expect(messages.Bob.slice(infoIndex)).toContain('AVATAR\nAlice\nvideo\nhttps://example/video');
	});

	it('waits for answer video completion, matches URL and resumes only once', () => {
		const uri = 'https://example/test.mp4';
		start([question([{ type: 'video', value: uri, isRef: false, placement: 'screen' }]), question()]);
		answerFirst();
		expect(messages.Alice).toContain(`CONTENT2\nscreen\n0\n\nvideo\n\n${uri}`);
		jest.advanceTimersByTime(10000);
		expect(messages.Alice).not.toContain('QUESTION_END');
		game.handleClientMessage('Bob', 'ATOM\nvideo\nhttps://example/wrong.mp4');
		game.handleClientMessage('Bob', `ATOM\naudio\n${uri}`);
		expect(messages.Alice).not.toContain('QUESTION_END');
		game.handleClientMessage('Host', 'PAUSE\n+');
		game.handleClientMessage('Bob', `ATOM\nvideo\n${uri}`);
		expect(messages.Alice).not.toContain('QUESTION_END');
		game.handleClientMessage('Host', 'PAUSE\n-');
		expect(messages.Alice).toContain('QUESTION_END');
		game.handleClientMessage('Bob', `ATOM\nvideo\n${uri}`);
		expect(messages.Alice.filter(text => text === 'QUESTION_END')).toHaveLength(1);
	});

	it('plays answer audio in the background and advances after it ends', () => {
		const uri = 'https://example/test.mp3';
		start([question([{ type: 'audio', value: uri, isRef: false, placement: 'screen', waitForFinish: false }]), question()]);
		answerFirst();
		expect(messages.Alice).toContain(`CONTENT2\nbackground\n0\n\naudio\n\n${uri}`);
		jest.advanceTimersByTime(5000);
		expect(messages.Alice).not.toContain('QUESTION_END');
		game.handleClientMessage('Alice', `ATOM\naudio\n${uri}`);
		expect(messages.Alice).toContain('QUESTION_END');
	});

	it('plays successive answer media without cutting off the first', () => {
		const video = 'https://example/one.mp4';
		const audio = 'https://example/two.mp3';
		start([question([
			{ type: 'video', value: video, isRef: false, placement: 'screen' },
			{ type: 'audio', value: audio, isRef: false, placement: 'background' },
		]), question()]);
		answerFirst();
		expect(messages.Alice).toContain(`CONTENT2\nscreen\n0\n\nvideo\n\n${video}`);
		expect(messages.Alice).not.toContain(`CONTENT2\nbackground\n0\n\naudio\n\n${audio}`);
		game.handleClientMessage('Bob', `ATOM\nvideo\n${video}`);
		expect(messages.Alice).toContain(`CONTENT2\nbackground\n0\n\naudio\n\n${audio}`);
		game.handleClientMessage('Bob', `ATOM\nvideo\n${video}`);
		expect(messages.Alice).not.toContain('QUESTION_END');
		game.handleClientMessage('Bob', `ATOM\naudio\n${audio}`);
		expect(messages.Alice).toContain('QUESTION_END');
	});

	it('honours a fixed media duration and has a bounded fallback when playback is unavailable', () => {
		const uri = 'https://example/test.mp4';
		start([question([{ type: 'video', value: uri, isRef: false, placement: 'screen', duration: '00:00:12' }]), question()]);
		answerFirst();
		game.handleClientMessage('Bob', `ATOM\nvideo\n${uri}`);
		jest.advanceTimersByTime(11999);
		expect(messages.Alice).not.toContain('QUESTION_END');
		jest.advanceTimersByTime(1);
		expect(messages.Alice).toContain('QUESTION_END');
	});

	it('advances after the fallback timeout if no client can play the answer media', () => {
		start([question([{ type: 'video', value: 'https://example/test.mp4', isRef: false, placement: 'screen' }]), question()]);
		answerFirst();
		jest.advanceTimersByTime(179999);
		expect(messages.Alice).not.toContain('QUESTION_END');
		jest.advanceTimersByTime(1);
		expect(messages.Alice).toContain('QUESTION_END');
		expect(game.session.phase).toBe(GamePhase.Round);
	});
});
