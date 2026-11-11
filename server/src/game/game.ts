import { Question } from '../../../src/model/siquester/package';
import { buildMessage, escapeNewLines, GameMessage, GameStage, MediaCategory } from '../protocol';
import { AnswerOptionPlan, buildAnswerOptions, buildContentAtoms, ContentAtom, getAnswerContentAtoms } from './questionPlan';
import { getMediaUrl, LoadedPackage, MEDIA_ROUTE_PREFIX, resolveMediaPath } from './package';
import { GamePerson, GamePhase, GameSession, isEmptySlotName, PersonRole } from './session';

/** Callback used by the game to report its state to the outside world. */
export interface GameObserver {
	onGameChanged(game: Game): void;
	log(message: string): void;
}

/** Interface of a client connection that is attached to a game. */
export interface GameClientConnection {
	send(target: string, ...args: unknown[]): void;
	sendClose(error?: string): void;
}

/** How many left seats are kept to return players to their places after a page reload. */
const MAX_SAVED_SEATS = 100;

/** Reasons of player selection. */
const SelectPlayerReason = {
	Answerer: 'Answerer',
	Chooser: 'Chooser',
	Staker: 'Staker',
} as const;

/** A server step scheduled by the game logic. */
interface PendingStep {
	action: () => void;
	dueAt: number;
	remaining: number;
	timeout?: NodeJS.Timeout;
}

/** Outcome of a question. */
interface QuestionOutcome {
	right: boolean;
	answerer: number;
	penaltyOrReward: number;
}

const MIN_STAKE_STEP = 100;

/** A single game hosted by the local server. */
export class Game {
	public readonly session: GameSession;

	/** Connections of the persons by name. */
	private readonly connections = new Map<string, GameClientConnection>();

	/** Pending timeouts. */
	private readonly timeouts = new Set<NodeJS.Timeout>();

	/** Content atoms of the current question. */
	private atoms: ContentAtom[] = [];

	/** Index of the next atom to show. */
	private atomIndex = 0;

	/** Answer options of the current question. */
	private answerOptions: AnswerOptionPlan[] = [];

	/** Players who have already answered the current question. */
	private readonly answeredPlayers = new Set<number>();

	/** Players who can press the button in the current question. */
	private pendingPressers: number[] = [];

	/** Number of answers received in the final round. */
	private finalAnswers = new Map<number, string>();

	/** Round timer value in tenths. */
	private roundTimeLeft = 0;

	/** True when the game timers are paused. */
	private isPaused = false;

	/** Steps scheduled by the game logic. */
	private pendingSteps: PendingStep[] = [];

	/** Time when the round timer has been paused (milliseconds). */
	private roundPausedAt: number | null = null;

	public readonly createdAt = new Date();

	constructor(
		public readonly id: number,
		name: string,
		public readonly packageInfo: LoadedPackage,
		public readonly isAutomatic: boolean,
		public readonly hostName: string,
		private readonly observer: GameObserver,
		private readonly publicBaseUrl: string,
	) {
		this.session = new GameSession(id, name, packageInfo, isAutomatic);
	}

	/** Returns true when the game has no connected humans. */
	get isEmpty(): boolean {
		return this.session.persons.every(person => !person.isHuman || !person.isConnected);
	}

	/** Base url to use for media links of this game. */
	private getMediaBaseUrl(): string {
		return this.baseUrl ?? this.publicBaseUrl;
	}

	/**
	 * Name of the person that manages the game (the client shows management buttons when its name matches `HOSTNAME`).
	 * A live showman always manages the game, then the creator of the game, then the first connected live player:
	 * automatic games and library games start with a server-driven showman, so the management falls back to a player.
	 */
	getManagerName(): string {
		const { showman } = this.session;

		if (showman.name.trim() && showman.isHuman && showman.isConnected) {
			return showman.name;
		}

		const host = this.session.findPerson(this.hostName);

		if (host && host.name === this.hostName && host.isHuman && host.isConnected) {
			return this.hostName;
		}

		const livePlayer = this.session.players.find(player => player.isHuman && player.isConnected);

		// The creator of the game keeps the rights when nobody is connected yet
		return livePlayer?.name ?? this.hostName;
	}

	/** Returns true when a person is allowed to manage the game. */
	private canManage(person: GamePerson): boolean {
		return person.name === this.getManagerName() || person.role === PersonRole.Showman;
	}

	/** Returns a connection of a person. */
	getConnection(name: string): GameClientConnection | null {
		return this.connections.get(name) ?? null;
	}

	/** Attaches a client connection to a person of the game. */
	attachConnection(personName: string, connection: GameClientConnection, baseUrl?: string): void {
		this.connections.set(personName, connection);

		const person = this.session.findPerson(personName);

		if (person && person.name === personName) {
			person.isConnected = true;
		}

		if (baseUrl) {
			this.baseUrl = baseUrl;
		}

		this.notifyChanged();
	}

	/** Base url that clients of this game use (media links are built from it). */
	private baseUrl: string | null = null;

	/** Manager name that has been broadcast to the clients (see `sendHostName`). */
	private announcedManagerName: string | null = null;

	/** Game options that could be changed by the host (rules of the game). */
	private readonly options = {
		oral: false,
		managed: false,
		falseStart: false,
		partialText: false,
		partialImages: false,
		useApellations: false,
		displayAnswerOptionsLabels: true,
		readingSpeed: 20,
		partialImageTime: 3,
	};

	/** Detaches a connection from the game (the person stays in the game as disconnected). */
	detachConnection(connection: GameClientConnection): void {
		for (const [name, current] of this.connections.entries()) {
			if (current === connection) {
				this.connections.delete(name);

				const person = this.session.findPerson(name);

				if (person) {
					// The person leaves the room: the seat becomes free again, so every client
					// (including the ones that join later) shows an empty place instead of a ghost
					this.releaseSeat(person);

					// Other clients must see that the person has left the seat, otherwise the seat stays occupied
					this.sendAll(buildMessage(GameMessage.Disconnected, name));
					this.sendAll(buildMessage(GameMessage.PlayerCount, this.session.players.length));

					// `INFO2` resets player scores and question state on the clients, so it is only safe in the room
					if (this.session.phase === GamePhase.Before) {
						this.sendInfo();
					}

					this.sendSums();
					this.sendReady();

					this.broadcastPersons();
				}
			}
		}

		this.updateManagerName();
		this.notifyChanged();
	}

	/** Frees the seat of a person that has left the room. */
	private releaseSeat(person: GamePerson): void {
		const { name, role, sum, isMale } = person;

		person.isConnected = false;
		person.isHuman = false;
		person.isBot = false;
		person.isReady = false;
		person.sum = 0;
		person.stake = 0;
		person.state = 'None';
		person.answer = '';

		if (role === PersonRole.Viewer) {
			this.session.viewers = this.session.viewers.filter(viewer => viewer !== person);
			return;
		}

		// The seat is freed, but a reload of the page must return the person to the same place with the same score
		if (this.leftSeats.size >= MAX_SAVED_SEATS) {
			const oldest = this.leftSeats.keys().next().value;

			if (oldest !== undefined) {
				this.leftSeats.delete(oldest);
			}
		}

		this.leftSeats.set(name, {
			role,
			index: role === PersonRole.Showman ? -1 : this.session.getPlayerIndex(name),
			sum,
			isMale,
		});

		person.name = GameSession.EMPTY_NAME;
	}

	/**
	 * Takes back the seat that a person has left (e.g. after a page reload).
	 * Returns false when the seat is already taken by somebody else.
	 */
	restoreSeat(name: string, role: PersonRole, isMale: boolean): boolean {
		const seat = this.leftSeats.get(name);

		if (!seat || seat.role !== role) {
			return false;
		}

		const person = role === PersonRole.Showman
			? (isEmptySlotName(this.session.showman.name) ? this.session.showman : null)
			: this.session.players[seat.index];

		if (!person || !isEmptySlotName(person.name)) {
			return false;
		}

		this.leftSeats.delete(name);

		person.name = name;
		person.isHuman = true;
		person.isBot = false;
		person.isConnected = false;
		person.isMale = isMale;
		person.isReady = role === PersonRole.Showman;
		person.sum = seat.sum;

		return true;
	}

	/** Forgets the saved seats of persons that have left and have not returned. */
	private readonly leftSeats = new Map<string, { role: PersonRole; index: number; sum: number; isMale: boolean }>();

	/** Removes a person from the game. */
	removePerson(name: string): void {
		const person = this.session.findPerson(name);

		if (!person) {
			return;
		}

		this.connections.delete(name);

		if (person.role === PersonRole.Player) {
			const index = this.session.getPlayerIndex(name);

			if (index > -1) {
				// Keep the slot but free its name to preserve player indexes
				person.name = GameSession.EMPTY_NAME;
				person.isConnected = false;
				person.isHuman = false;
				person.isBot = false;
				person.isReady = false;
				person.sum = 0;
				person.stake = 0;
				person.state = 'None';
			}
		} else if (person.role === PersonRole.Showman) {
			person.name = GameSession.EMPTY_NAME;
			person.isConnected = false;
			person.isHuman = false;
			person.isReady = false;
		} else {
			this.session.viewers = this.session.viewers.filter(viewer => viewer !== person);
		}

		this.notifyChanged();
		this.broadcastPersons();
	}

	/** Sets a person as connected/disconnected. */
	setConnected(name: string, isConnected: boolean): void {
		const person = this.session.findPerson(name);

		if (!person || person.name !== name) {
			return;
		}

		person.isConnected = isConnected;

		this.sendAll(buildMessage(
			GameMessage.Connected,
			person.role === PersonRole.Showman ? 'showman' : 'player',
			person.role === PersonRole.Showman ? '' : this.session.getPlayerIndex(name),
			name,
			person.isMale ? 'm' : 'f',
		));

		this.broadcastPersons();
		this.updateManagerName();
		this.notifyChanged();
	}

	/** Restores the per-person state of a reconnected client (question in progress etc.). */
	onReconnect(personName: string): void {
		const { session } = this;

		if (!session.isQuestionPlaying) {
			return;
		}

		const index = session.getPlayerIndex(personName);

		if (index === session.answererIndex) {
			this.sendTo(personName, buildMessage(GameMessage.Answer, 'text'));
		}
	}

	/** Sends the `GamePersonsChanged` notification to all lobby clients through the observer. */
	private broadcastPersons(): void {
		this.observer.onGameChanged(this);
	}

	/** Notifies the lobby that the game has changed. */
	notifyChanged(): void {
		this.observer.onGameChanged(this);
	}

	/** Sends a message to all connected persons and remembers it for late joiners. */
	sendAll(text: string): void {
		for (const connection of this.connections.values()) {
			connection.send('Receive', {
				IsSystem: true,
				Sender: '@',
				Text: text,
			});
		}
	}

	/** Sends a message to a single person. */
	sendTo(personName: string, text: string): boolean {
		const connection = this.connections.get(personName);

		if (!connection) {
			return false;
		}

		connection.send('Receive', {
			IsSystem: true,
			Sender: '@',
			Text: text,
		});

		return true;
	}

	/** Sends a message to human players only (used for player-specific prompts). */
	private sendToPlayers(text: string, indexes?: number[]): void {
		const players = indexes
			? indexes.map(index => this.session.players[index]).filter(Boolean)
			: this.session.players;

		for (const player of players) {
			if (player.isHuman && player.isConnected) {
				this.sendTo(player.name, text);
			}
		}
	}

	/** Schedules a server step. Steps are tracked so that a pause could freeze them. */
	private schedule(seconds: number, action: () => void): NodeJS.Timeout {
		const step: PendingStep = {
			action,
			dueAt: Date.now() + Math.max(0, seconds * 1000),
			remaining: Math.max(0, seconds * 1000),
			timeout: undefined,
		};

		this.pendingSteps.push(step);
		this.armStep(step);
		return step.timeout as NodeJS.Timeout;
	}

	private armStep(step: PendingStep): void {
		step.dueAt = Date.now() + step.remaining;

		step.timeout = setTimeout(() => {
			this.pendingSteps = this.pendingSteps.filter(value => value !== step);

			try {
				step.action();
			} catch (e) {
				this.observer.log(`Ошибка игрового шага: ${(e as Error).stack ?? e}`);
			}
		}, step.remaining);
	}

	/** Freezes all pending steps (game pause). */
	private pauseSteps(): void {
		this.isPaused = true;

		for (const step of this.pendingSteps) {
			if (step.timeout) {
				clearTimeout(step.timeout);
				step.timeout = undefined;
			}

			step.remaining = Math.max(0, step.dueAt - Date.now());
		}

		this.roundPausedAt = Date.now();
	}

	/** Resumes all pending steps (game resume). */
	private resumeSteps(): void {
		this.isPaused = false;

		for (const step of this.pendingSteps) {
			this.armStep(step);
		}

		if (this.roundPausedAt) {
			this.roundTimeLeft = Math.max(0, this.roundTimeLeft - Math.floor((Date.now() - this.roundPausedAt) / 100));
			this.roundPausedAt = null;
		}
	}

	/** Cancels all pending steps. */
	private cancelPending(): void {
		for (const step of this.pendingSteps) {
			if (step.timeout) {
				clearTimeout(step.timeout);
			}
		}

		this.pendingSteps = [];
	}

	/** Sends the `INFO2` message with all game persons. */
	sendInfo(personName?: string): void {
		const { session } = this;
		const parts: string[] = [GameMessage.Info, String(session.players.length)];

		const appendAccount = (person: GamePerson) => {
			parts.push(person.name);
			parts.push(person.isMale ? '+' : '-');
			parts.push(person.isConnected ? '+' : '-');
			parts.push(person.isHuman ? '+' : '-');
			parts.push(person.isReady ? '+' : '-');
		};

		appendAccount(session.showman);
		session.players.forEach(appendAccount);
		session.viewers.filter(viewer => viewer.isConnected).forEach(appendAccount);

		const text = parts.join('\n');

		if (personName) {
			this.sendTo(personName, text);
		} else {
			this.sendAll(text);
		}
	}

	/** Sends current player sums. */
	sendSums(personName?: string): void {
		const text = [GameMessage.Sums, ...this.session.players.map(player => player.sum)].join('\n');

		if (personName) {
			this.sendTo(personName, text);
		} else {
			this.sendAll(text);
		}
	}

	/** Sends ready flags of all main persons. */
	sendReady(personName?: string): void {
		for (const person of this.session.mainPersons) {
			if (!person.name.trim()) {
				continue;
			}

			const text = buildMessage(GameMessage.Ready, person.name, person.isReady ? '+' : '-');

			if (personName) {
				this.sendTo(personName, text);
			} else {
				this.sendAll(text);
			}
		}
	}

	/** Broadcasts `HOSTNAME` when the manager of the game has changed. */
	private updateManagerName(): void {
		const managerName = this.getManagerName();

		if (managerName === this.announcedManagerName) {
			return;
		}

		this.announcedManagerName = managerName;
		this.sendHostName();
		this.observer.log(`Управляющий игрой: ${managerName}`);
	}

	/**
	 * Sends the name of the person that manages the game.
	 * The web client enables management buttons (rules, rounds, pause) only when its name matches `HOSTNAME`,
	 * so the message must be broadcast when management moves to another player (e.g. the first live player joins).
	 */
	sendHostName(personName?: string): void {
		const text = buildMessage(GameMessage.HostName, this.getManagerName());

		if (personName) {
			this.sendTo(personName, text);
		} else {
			this.sendAll(text);
		}
	}

	/** Sends game metadata (name, package, host). */
	sendMetadata(personName?: string): void {
		const { session } = this;

		const messages = [
			buildMessage(GameMessage.GameMetadata, session.name, session.packageInfo.package.name, '', ''),
			buildMessage(GameMessage.Package, session.packageInfo.package.name, '', this.getPackageLogoUrl() ?? ''),
		];

		for (const text of messages) {
			if (personName) {
				this.sendTo(personName, text);
			} else {
				this.sendAll(text);
			}
		}
	}

	private getPackageLogoUrl(): string | null {
		const logo = this.session.packageInfo.package.logo;

		if (!logo) {
			return null;
		}

		const mediaPath = resolveMediaPath(this.session.packageInfo, {
			type: 'image',
			value: logo,
			isRef: true,
		} as never);

		if (!mediaPath) {
			return null;
		}

		return this.buildMediaUrl(mediaPath);
	}

	/** Sends the full game state to a person (used on join and on `INFO`). */
	sendFullState(personName: string): void {
		const { session } = this;

		this.sendMetadata(personName);
		// The client enables management buttons only when its name matches HOSTNAME
		this.sendHostName(personName);
		this.sendOptions(personName);
		this.sendInfo(personName);
		this.sendSums(personName);
		this.sendReady(personName);
		this.sendAll(buildMessage(GameMessage.SetJoinMode, 'AnyRole', '-'));

		if (session.phase === GamePhase.Before) {
			this.sendTo(personName, buildMessage(GameMessage.Stage, GameStage.Before));
			return;
		}

		if (session.phase === GamePhase.Round) {
			this.sendStage(personName);
			this.sendRoundInfo(personName);
			this.sendTable(personName);
			this.sendChooser(personName);
		}

		if (session.phase === GamePhase.Final) {
			this.sendStage(personName);
			this.sendRoundInfo(personName);
			this.sendTable(personName);
		}

		if (session.phase === GamePhase.Finished) {
			this.sendTo(personName, buildMessage(GameMessage.Stage, GameStage.After));
		}
	}

	/** Sends the current stage. */
	private sendStage(personName?: string): void {
		const { session } = this;
		const stage = session.phase === GamePhase.Before
			? GameStage.Before
			: session.phase === GamePhase.Finished ? GameStage.After : GameStage.Round;

		const text = buildMessage(GameMessage.Stage, stage, session.roundName, session.roundIndex, 'SelectByPlayer');

		if (personName) {
			this.sendTo(personName, text);
		} else {
			this.sendAll(text);
		}
	}

	/** Sends round names, themes and the table. */
	private sendRoundInfo(personName?: string): void {
		const { session } = this;
		const roundsNames = session.packageInfo.package.rounds.map(round => round.name);
		const roundsText = [GameMessage.RoundsNames, ...roundsNames].join('\n');
		const themesText = [GameMessage.RoundThemes2, 'OneByOne', ...session.themes.map(theme => theme.name)].join('\n');

		if (personName) {
			this.sendTo(personName, roundsText);
			this.sendTo(personName, themesText);
			session.themes.forEach((theme, index) => this.sendTheme(personName, index, theme));
			return;
		}

		this.sendAll(roundsText);
		this.sendAll(themesText);
		session.themes.forEach((theme, index) => this.sendTheme(undefined, index, theme));
	}

	private sendTheme(personName: string | undefined, index: number, theme: { name: string; comments: string; prices: number[] }): void {
		const question = this.session.currentRound?.themes[index];

		if (!question) {
			return;
		}

		const authors = question.info?.authors?.map(author => author.name) ?? [];
		const sources = question.info?.sources?.map(source => source.value) ?? [];

		const text = [
			GameMessage.Theme,
			theme.name,
			theme.prices.length,
			'+',
			escapeNewLines(theme.comments ?? ''),
			authors.length,
			...authors,
			sources.length,
			...sources,
		].join('\n');

		if (personName) {
			this.sendTo(personName, text);
		} else {
			this.sendAll(text);
		}
	}

	/** Sends the round table. */
	sendTable(personName?: string): void {
		const parts: string[] = [GameMessage.Table];

		for (const theme of this.session.themes) {
			for (const price of theme.prices) {
				parts.push(String(price));
			}

			parts.push('');
		}

		const text = parts.join('\n');

		if (personName) {
			this.sendTo(personName, text);
		} else {
			this.sendAll(text);
		}
	}

	/** Sends the current chooser. */
	private sendChooser(personName?: string): void {
		if (this.session.chooserIndex < 0) {
			return;
		}

		const text = buildMessage(GameMessage.SetChooser, this.session.chooserIndex);

		if (personName) {
			this.sendTo(personName, text);
		} else {
			this.sendAll(text);
		}
	}

	/** Handles a protocol message from a client. */
	handleClientMessage(sender: string, text: string): void {
		const person = this.session.findPerson(sender);

		if (!person) {
			return;
		}

		const args = text.split('\n');
		const command = args[0];

		switch (command) {
			case 'INFO':
				this.sendFullState(sender);
				break;

			case 'MOVEABLE':
				this.sendTo(sender, buildMessage(GameMessage.ContentState, 'screen', 0, 'Normal'));
				break;

			case 'READY':
				this.handleReady(person, args[1] !== '-');
				break;

			case 'START':
				this.handleStart(person);
				break;

			case 'CHOICE':
				this.handleChoice(sender, parseInt(args[1], 10), parseInt(args[2], 10));
				break;

			case 'I':
				this.handlePress(sender, parseInt(args[1], 10) || 0);
				break;

			case 'ANSWER':
				this.handleAnswer(sender, args[1] ?? '');
				break;

			case 'ANSWER_VERSION':
				this.handleAnswerVersion(sender, args[1] ?? '');
				break;

			case 'PASS':
				this.handlePass(sender);
				break;

			case 'SET_STAKE':
			case 'STAKE':
				this.handleStake(sender, args[1] ?? '', parseInt(args[2], 10));
				break;

			case 'CONFIG':
				this.handleConfig(person, args);
				break;

			case 'MOVE':
				this.handleMove(person, args);
				break;

			case 'PAUSE':
				this.handlePause(person, args[1] === '+');
				break;

			case 'SETJOINMODE':
				this.sendAll(buildMessage(GameMessage.SetJoinMode, args[1] ?? 'AnyRole', '-'));
				break;

			case 'PIN':
				this.sendTo(sender, buildMessage(GameMessage.Pin, this.getPin()));
				break;

			case 'MEDIALOADED':
				break;

			case 'MEDIA_PRELOAD_PROGRESS':
				this.handlePreloadProgress(sender, parseInt(args[1], 10));
				break;

			case 'ATOM':
				this.handleAtomCompleted();
				break;

			case 'VALIDATE':
			case 'ISRIGHT':
				this.handleValidation(person, args);
				break;

			case 'SETHOST':
			case 'BAN':
			case 'UNBAN':
			case 'MARK':
			case 'REPORT':
			case 'DELETE':
			case 'TOGGLE':
			case 'LEADERBOARD':
			case 'CHANGE':
			case 'APELLATE':
			case 'AVATAR':
				break;

			case 'SET_OPTIONS':
				this.handleSetOptions(person, args);
				break;

			default:
				this.observer.log(`Неизвестная команда от ${sender}: ${command}`);
				break;
		}
	}

	/** Six digit game pin that other players could use to join the game. */
	get pin(): number {
		return this.getPin();
	}

	private getPin(): number {
		// Pin is derived from the game id: 6 digits and stable per game
		return 100000 + (this.id * 7919) % 900000;
	}

	private handleReady(person: GamePerson, isReady: boolean): void {
		if (this.session.phase !== GamePhase.Before) {
			return;
		}

		if (person.role === PersonRole.Viewer) {
			return;
		}

		person.isReady = isReady;
		this.sendAll(buildMessage(GameMessage.Ready, person.name, isReady ? '+' : '-'));

		if (this.session.allReady) {
			this.start();
		} else if (this.session.isAutomatic) {
			this.maybeStartAutomatic();
		}
	}

	private maybeStartAutomatic(): void {
		if (this.session.connectedHumans > 0) {
			this.start();
		}
	}

	private handleStart(person: GamePerson): void {
		if (this.session.phase !== GamePhase.Before) {
			return;
		}

		// Anyone could start a local game: the server acts as the showman
		if (!person.isHuman || !person.isConnected) {
			return;
		}

		this.start();
	}

	/** Starts the game. */
	start(): void {
		if (this.session.phase !== GamePhase.Before) {
			return;
		}

		this.session.phase = GamePhase.Round;
		this.cancelPending();

		this.sendAll(buildMessage(GameMessage.Stage, GameStage.Begin));
		this.notifyChanged();

		this.schedule(2, () => this.startRound(0));
	}

	/** Starts a round by index. */
	startRound(roundIndex: number): void {
		const { session } = this;
		const round = session.packageInfo.package.rounds[roundIndex];

		if (!round) {
			this.endGame();
			return;
		}

		session.roundIndex = roundIndex;
		session.roundName = round.name;
		session.phase = GamePhase.Round;
		session.chooserIndex = -1;
		session.themeIndex = -1;
		session.questionIndex = -1;
		session.isQuestionPlaying = false;

		const themes = round.themes
			.map(theme => ({
				name: theme.name,
				comments: theme.info?.comments ?? '',
				prices: theme.questions.map(question => question.price),
			}))
			.filter(theme => theme.prices.some(price => price >= 0));

		session.themes = themes;

		if (themes.length === 0) {
			this.endRound('empty');
			return;
		}

		this.roundTimeLeft = this.getRoundDuration(roundIndex);

		this.sendAll(buildMessage(GameMessage.Stage, GameStage.Round, round.name, roundIndex, 'SelectByPlayer'));
		this.sendRoundInfo();
		this.sendTable();
		this.sendRoundContent();
		this.sendAll(buildMessage(GameMessage.Timer, 0, 'GO', this.roundTimeLeft));
		this.notifyChanged();

		this.schedule(this.roundTimeLeft / 10, () => this.endRound('timeout'));

		this.schedule(1, () => this.askToSelectQuestion());
	}

	private getRoundDuration(roundIndex: number): number {
		// Round duration is expressed in tenths of a second
		void roundIndex;
		return this.getTimeSettings().timeOfRound * 10;
	}

	/** Sends the list of round media for client-side preloading. */
	private sendRoundContent(): void {
		const round = this.session.currentRound;

		if (!round) {
			return;
		}

		const uris: string[] = [];

		for (const theme of round.themes) {
			for (const question of theme.questions) {
				const atoms = buildContentAtoms(question, this.options.readingSpeed, item => this.resolveMedia(item));

				for (const atom of atoms) {
					if (atom.type !== 'text') {
						uris.push(atom.value);
					}
				}
			}
		}

		if (uris.length > 0) {
			this.sendAll([GameMessage.RoundContent, ...uris].join('\n'));
		}
	}

	/** Resolves a package media item into a public url. */
	private resolveMedia(item: { type: string; value: string; isRef: boolean }): { type: string; value: string } | null {
		if (item.isRef === false) {
			// External link
			return { type: item.type, value: item.value };
		}

		const mediaPath = resolveMediaPath(this.session.packageInfo, item as never);

		if (!mediaPath) {
			return null;
		}

		return {
			type: item.type,
			value: this.buildMediaUrl(mediaPath),
		};
	}

	/** Asks the chooser to select a question. */
	askToSelectQuestion(): void {
		const { session } = this;

		if (session.phase !== GamePhase.Round) {
			return;
		}

		if (this.getActiveQuestionsCount() === 0) {
			this.endRound('empty');
			return;
		}

		if (session.chooserIndex < 0 || !session.players[session.chooserIndex]?.name.trim()) {
			this.selectNextChooser();
		}

		this.sendAll(GameMessage.ShowTable);
		this.sendSums();
		this.sendChooser();

		const chooser = session.players[session.chooserIndex];

		if (!chooser) {
			this.endRound('empty');
			return;
		}

		if (chooser.isBot || !chooser.isConnected) {
			this.sendAll(buildMessage(GameMessage.SetChooser, session.chooserIndex, '+', '-', 'ANNOUNCE'));
			this.schedule(1.5, () => this.makeBotChoice());
			return;
		}

		this.sendTo(chooser.name, [GameMessage.Choose, '1'].join('\n'));
		this.sendAll(buildMessage(GameMessage.SetChooser, session.chooserIndex, '+', '-', 'ANNOUNCE'));
		this.sendAll(buildMessage(GameMessage.Timer, 2, 'GO', this.getTimeSettings().timeForChoosingQuestion * 10, session.chooserIndex));

		// Fallback: bot-like selection if the chooser is idle
		const expectedRound = session.roundIndex;
		this.schedule(this.getTimeSettings().timeForChoosingQuestion, () => {
			if (this.session.roundIndex === expectedRound && this.session.themeIndex < 0) {
				this.makeBotChoice();
			}
		});
	}

	private getActiveQuestionsCount(): number {
		return this.session.themes.reduce((total, theme) => total + theme.prices.filter(price => price >= 0).length, 0);
	}

	private selectNextChooser(): void {
		const { session } = this;
		const count = session.players.length;

		for (let i = 0; i < count; i += 1) {
			const index = (session.chooserIndex + 1 + i) % count;
			const player = session.players[index];

			if (player.name.trim() && player.name !== GameSession.EMPTY_NAME) {
				session.chooserIndex = index;
				return;
			}
		}
	}

	/** Picks a random available question as a bot would do. */
	private makeBotChoice(): void {
		const { session } = this;
		const available: { theme: number; question: number }[] = [];

		session.themes.forEach((theme, themeIndex) => {
			theme.prices.forEach((price, questionIndex) => {
				if (price >= 0) {
					available.push({ theme: themeIndex, question: questionIndex });
				}
			});
		});

		if (available.length === 0) {
			this.endRound('empty');
			return;
		}

		const choice = available[Math.floor(Math.random() * available.length)];
		this.handleChoice(session.players[session.chooserIndex]?.name ?? '', choice.theme, choice.question);
	}

	private handleChoice(sender: string, themeIndex: number, questionIndex: number): void {
		const { session } = this;

		if (session.phase !== GamePhase.Round || session.isQuestionPlaying) {
			return;
		}

		if (themeIndex < 0 || themeIndex >= session.themes.length) {
			return;
		}

		const prices = session.themes[themeIndex].prices;

		if (questionIndex < 0 || questionIndex >= prices.length || prices[questionIndex] < 0) {
			return;
		}

		const chooser = session.players[session.chooserIndex];

		if (chooser && sender && chooser.name !== sender && !chooser.isBot) {
			// Only the chooser may select a question
			if (session.getPlayerIndex(sender) !== session.chooserIndex) {
				return;
			}
		}

		const price = prices[questionIndex];
		prices[questionIndex] = -1;

		session.themeIndex = themeIndex;
		session.questionIndex = questionIndex;
		session.currentPrice = price;

		this.sendAll(buildMessage(GameMessage.Timer, 2, 'STOP'));
		this.sendAll(GameMessage.Choice + '\n' + themeIndex + '\n' + questionIndex + '\n' + price);
		this.sendTable();

		this.schedule(1, () => this.startQuestion());
	}

	/** Starts the current question. */
	startQuestion(): void {
		const { session } = this;
		const question = session.currentQuestion;

		if (!question) {
			this.endRound('empty');
			return;
		}

		const theme = session.themes[session.themeIndex];

		session.isQuestionPlaying = true;
		session.isQuestionAnswerShown = false;
		session.answererIndex = -1;
		session.answerers = [];
		this.answeredPlayers.clear();
		this.atomIndex = 0;
		this.finalAnswers.clear();

		for (const player of session.players) {
			player.state = 'None';
			player.answer = '';
			player.stake = 0;
		}

		this.atoms = buildContentAtoms(question, this.options.readingSpeed, item => this.resolveMedia(item));
		this.answerOptions = buildAnswerOptions(question, item => this.resolveMedia(item));

		const questionType = question.type ?? '';
		const isDefault = questionType === '' || questionType === 'simple';
		const isNoRisk = questionType === 'noRisk';

		this.sendAll(buildMessage(GameMessage.Question, session.currentPrice));
		this.sendAll(buildMessage(GameMessage.QuestionCaption, theme?.name ?? ''));
		this.sendAll(buildMessage(GameMessage.QType, questionType || 'simple', isDefault ? 'True' : 'False', isNoRisk ? 'True' : 'False'));
		this.sendAll(buildMessage(GameMessage.Timer, 2, 'STOP'));

		if (this.answerOptions.length > 0) {
			this.sendLayout();
		}

		this.sendAll(buildMessage(GameMessage.PlayerState, 'None'));

		this.schedule(0.5, () => this.showNextAtom());
	}

	private sendLayout(): void {
		const screenSequence = this.atoms
			.filter(atom => atom.placement === 'screen')
			.map(atom => (atom.type === 'text' ? `text.${atom.value.length}` : atom.type))
			.join('+');

		const text = [
			GameMessage.Layout,
			'ANSWER_OPTIONS',
			screenSequence,
			...this.answerOptions.map(option => option.type),
		].join('\n');

		this.sendAll(text);
	}

	/** Shows the next content atom of the question. */
	private showNextAtom(): void {
		if (!this.session.isQuestionPlaying) {
			return;
		}

		if (this.atomIndex >= this.atoms.length) {
			this.onContentFinished();
			return;
		}

		const atom = this.atoms[this.atomIndex];
		this.atomIndex += 1;

		if (atom.placement === 'background') {
			this.sendAll([GameMessage.Content2, 'background', 0, '', atom.type, '', atom.value].join('\n'));

			if (atom.waitForFinish) {
				this.schedule(atom.duration / 10, () => this.showNextAtom());
			} else {
				this.showNextAtom();
			}

			return;
		}

		if (atom.placement === 'replic') {
			this.sendAll(buildMessage(GameMessage.Replic, 's', escapeNewLines(atom.value)));
			this.schedule(Math.max(atom.duration / 10, 0.2), () => this.showNextAtom());
			return;
		}

		this.sendAll([GameMessage.Content2, 'screen', 0, '', atom.type, '', atom.value].join('\n'));

		if (!atom.waitForFinish) {
			this.showNextAtom();
			return;
		}

		this.schedule(Math.max(atom.duration / 10, 0.2), () => this.showNextAtom());
	}

	/** Called when the last content atom is shown. */
	private onContentFinished(): void {
		const { session } = this;

		if (!session.isQuestionPlaying) {
			return;
		}

		if (!session.isQuestionAnswerShown && this.atomIndex < this.atoms.length) {
			return;
		}

		if (this.answerOptions.length > 0) {
			this.showAnswerOptions();
			return;
		}

		this.beginPressPhase();
	}

	/** Shows answer options one by one. */
	private showAnswerOptions(): void {
		this.answerOptions.forEach((option, index) => {
			this.schedule(0.4 * index, () => {
				this.sendAll([GameMessage.Content2, 'screen', index + 1, option.label, option.type, '', option.value].join('\n'));
			});
		});

		this.schedule(0.4 * this.answerOptions.length + 0.3, () => this.beginPressPhase());
	}

	/** Enables button pressing for the players. */
	private beginPressPhase(): void {
		const { session } = this;

		if (!session.isQuestionPlaying || session.isQuestionAnswerShown) {
			return;
		}

		this.pendingPressers = session.players
			.map((player, index) => ({ player, index }))
			.filter(({ player, index }) => player.name.trim() && !this.answeredPlayers.has(index))
			.map(({ index }) => index);

		if (this.pendingPressers.length === 0) {
			this.finishQuestionWithoutAnswer();
			return;
		}

		const pressTime = this.getTimeSettings().timeForThinkingOnQuestion * 10;

		this.sendAll(buildMessage(GameMessage.Try));
		this.sendAll(buildMessage(GameMessage.Timer, 1, 'GO', pressTime));

		this.schedule(pressTime / 10, () => {
			if (!session.isQuestionPlaying || session.answererIndex >= 0) {
				return;
			}

			this.sendAll(buildMessage(GameMessage.EndTry, 'A'));
			this.finishQuestionWithoutAnswer();
		});

		this.scheduleBotPresses();
	}

	/** Makes bots press the button from time to time. */
	private scheduleBotPresses(): void {
		const bots = this.pendingPressers
			.map(index => this.session.players[index])
			.filter(player => player?.isBot);

		if (bots.length === 0) {
			return;
		}

		this.schedule(1.5 + Math.random() * 3, () => {
			if (this.session.answererIndex >= 0 || !this.session.isQuestionPlaying) {
				return;
			}

			const candidates = this.pendingPressers
				.map(index => ({ index, player: this.session.players[index] }))
				.filter(({ player }) => player?.isBot);

			if (candidates.length === 0) {
				return;
			}

			const chosen = candidates[Math.floor(Math.random() * candidates.length)];
			this.handlePress(chosen.player.name, 1000);
		});
	}

	private handlePress(sender: string, _deltaTime: number): void {
		const { session } = this;

		if (!session.isQuestionPlaying || session.isQuestionAnswerShown) {
			return;
		}

		const index = session.getPlayerIndex(sender);

		if (index < 0 || !this.pendingPressers.includes(index)) {
			return;
		}

		const answerer = session.players[index];

		session.answererIndex = index;
		session.answerers = [index];
		this.pendingPressers = this.pendingPressers.filter(value => value !== index);

		this.sendAll(buildMessage(GameMessage.Timer, 1, 'STOP'));
		this.sendAll(buildMessage(GameMessage.EndTry, index));

		if (answerer.isHuman && answerer.isConnected) {
			const answerTime = 20;
			this.sendTo(answerer.name, buildMessage(GameMessage.Answer, 'text'));
			this.sendAll(buildMessage(GameMessage.Timer, 2, 'GO', answerTime * 10, index));

			this.schedule(answerTime, () => {
				if (this.session.answererIndex === index && !this.session.isQuestionAnswerShown) {
					this.validateAnswer(index, '', false);
				}
			});
		} else {
			// Bot answer
			this.schedule(1 + Math.random() * 2, () => this.validateAnswer(index, this.getBotAnswer(index), this.shouldBotAnswerRight()));
		}
	}

	private shouldBotAnswerRight(): boolean {
		return Math.random() < 0.45;
	}

	private getBotAnswer(index: number): string {
		const question = this.session.currentQuestion;

		if (!question) {
			return '';
		}

		const right = question.right.answer;

		if (right.length > 0) {
			return right[0];
		}

		return '';
	}

	private handleAnswer(sender: string, answer: string): void {
		const index = this.session.getPlayerIndex(sender);

		if (index < 0) {
			return;
		}

		this.validateAnswer(index, answer, this.isAnswerRight(answer));
	}

	private handleAnswerVersion(sender: string, answer: string): void {
		const index = this.session.getPlayerIndex(sender);

		if (index < 0) {
			return;
		}

		this.session.players[index].answer = answer;
		this.sendAll(buildMessage(GameMessage.PlayerAnswer, index, answer));
	}

	private isAnswerRight(answer: string): boolean {
		const question = this.session.currentQuestion;

		if (!question) {
			return false;
		}

		const normalized = this.normalizeAnswer(answer);

		if (this.answerOptions.length > 0) {
			const option = this.answerOptions.find(item => item.label.toLocaleUpperCase() === answer.trim().toLocaleUpperCase());

			if (option) {
				return question.right.answer.some(right => this.normalizeAnswer(right) === this.normalizeAnswer(option.value));
			}
		}

		return question.right.answer.some(right => this.normalizeAnswer(right) === normalized);
	}

	private normalizeAnswer(value: string): string {
		return value.trim().toLocaleLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ').replace(/[.!?]+$/g, '');
	}

	/** Applies the answer of a player. */
	private validateAnswer(playerIndex: number, answer: string, isRight: boolean): void {
		const { session } = this;

		if (!session.isQuestionPlaying || session.isQuestionAnswerShown) {
			return;
		}

		const player = session.players[playerIndex];

		if (!player || this.answeredPlayers.has(playerIndex)) {
			return;
		}

		session.players[playerIndex].answer = answer;
		this.answeredPlayers.add(playerIndex);
		this.sendAll(buildMessage(GameMessage.Timer, 2, 'STOP'));

		if (isRight) {
			const reward = session.currentPrice;
			player.sum += reward;
			player.state = 'Right';

			this.sendAll(buildMessage(GameMessage.Person, '+', playerIndex, reward));
			this.sendSums();
			this.showRightAnswer();
			this.finishQuestion({ right: true, answerer: playerIndex, penaltyOrReward: reward });
			return;
		}

		const penalty = this.getPenaltyAmount();
		player.sum -= penalty;
		player.state = 'Wrong';

		this.sendAll(buildMessage(GameMessage.Person, '-', playerIndex, penalty));
		this.sendSums();
		session.answererIndex = -1;

		if (this.pendingPressers.length === 0) {
			this.showRightAnswer();
			this.finishQuestionWithoutAnswer();
			return;
		}

		this.schedule(1, () => this.beginPressPhase());
	}

	private getPenaltyAmount(): number {
		return this.session.currentPrice;
	}

	/** Shows the right answer. */
	private showRightAnswer(): void {
		const question = this.session.currentQuestion;

		if (!question) {
			return;
		}

		const right = question.right.answer[0] ?? '';
		this.session.isQuestionAnswerShown = true;

		if (this.answerOptions.length > 0) {
			this.sendAll([GameMessage.ContentState, 'screen', this.getRightOptionIndex() + 1, 'Right'].join('\n'));
		}

		// Switch the client to the simple layout: the answer is not an option text in the default case
		// In the answer options layout the client compares RIGHTANSWER with the option labels
		this.sendAll(buildMessage(
			GameMessage.RightAnswer,
			'text',
			this.answerOptions.length > 0 ? this.getRightOptionLabel() ?? right : right,
		));

		const answerAtoms = getAnswerContentAtoms(question, this.options.readingSpeed, item => this.resolveMedia(item));

		for (const atom of answerAtoms) {
			if (atom.type === 'text') {
				this.sendAll([
					GameMessage.Content2,
					atom.placement,
					0,
					'',
					'text',
					'',
					escapeNewLines(atom.value),
				].join('\n'));

				continue;
			}

			this.sendAll([GameMessage.Content2, atom.placement, 0, '', atom.type, '', atom.value].join('\n'));
		}
	}

	private getRightOptionIndex(): number {
		const question = this.session.currentQuestion;

		if (!question || this.answerOptions.length === 0) {
			return -1;
		}

		const right = question.right.answer.map(answer => this.normalizeAnswer(answer));

		return this.answerOptions.findIndex(option => right.includes(this.normalizeAnswer(option.value)));
	}

	/** Returns the label of the right answer option (used to mark it in the answer options layout). */
	private getRightOptionLabel(): string | null {
		return this.answerOptions[this.getRightOptionIndex()]?.label ?? null;
	}

	private finishQuestionWithoutAnswer(): void {
		this.sendAll(buildMessage(GameMessage.Timer, 1, 'STOP'));
		this.showRightAnswer();
		this.finishQuestion(null);
	}

	/** Finishes the current question and moves on. */
	private finishQuestion(outcome: QuestionOutcome | null): void {
		const { session } = this;

		if (!session.isQuestionPlaying) {
			return;
		}

		session.isQuestionPlaying = false;
		this.cancelPending();
		this.restoreRoundTimer();

		if (outcome?.right) {
			session.chooserIndex = outcome.answerer;
		}

		this.schedule(3, () => {
			this.sendAll(buildMessage(GameMessage.QuestionEnd));
			this.sendAll(buildMessage(GameMessage.ShowTable));
			this.sendSums();
			this.notifyChanged();

			if (this.getActiveQuestionsCount() === 0) {
				this.schedule(1, () => this.endRound('empty'));
				return;
			}

			this.schedule(1, () => this.askToSelectQuestion());
		});
	}

	/** Restarts the round timer after a question has finished. */
	private restoreRoundTimer(): void {
		this.sendAll(buildMessage(GameMessage.Timer, 0, 'GO', this.roundTimeLeft));
	}

	/** Ends the current round. */
	endRound(reason: string): void {
		const { session } = this;

		if (session.phase !== GamePhase.Round) {
			return;
		}

		session.isQuestionPlaying = false;
		this.cancelPending();

		this.sendAll(buildMessage(GameMessage.Stop));
		this.sendSums();
		this.sendAll(buildMessage(GameMessage.RoundEnd, reason));

		const nextIndex = session.roundIndex + 1;

		if (nextIndex >= session.packageInfo.package.rounds.length) {
			this.schedule(2, () => this.endGame());
			return;
		}

		const nextRound = session.packageInfo.package.rounds[nextIndex];

		if (nextRound.type === 'final') {
			this.schedule(2, () => this.startFinalRound(nextIndex));
			return;
		}

		this.schedule(2, () => this.startRound(nextIndex));
	}

	/** Starts the final round. */
	startFinalRound(roundIndex: number): void {
		const { session } = this;
		const round = session.packageInfo.package.rounds[roundIndex];

		if (!round) {
			this.endGame();
			return;
		}

		session.roundIndex = roundIndex;
		session.roundName = round.name;
		session.phase = GamePhase.Final;
		session.chooserIndex = -1;
		session.themeIndex = -1;
		session.questionIndex = -1;

		session.themes = round.themes.map(theme => ({
			name: theme.name,
			comments: theme.info?.comments ?? '',
			prices: theme.questions.map(question => question.price),
		}));

		this.sendAll(buildMessage(GameMessage.Stage, GameStage.Round, round.name, roundIndex, 'Sequential'));
		this.sendRoundInfo();
		this.sendTable();
		this.notifyChanged();

		this.schedule(2, () => this.startFinalQuestion());
	}

	/** Plays the final question: every player stakes and answers. */
	private startFinalQuestion(): void {
		const { session } = this;

		const themeIndex = session.themes.findIndex(theme => theme.prices.some(price => price >= 0));

		if (themeIndex < 0) {
			this.endGame();
			return;
		}

		const questionIndex = session.themes[themeIndex].prices.findIndex(price => price >= 0);

		session.themeIndex = themeIndex;
		session.questionIndex = questionIndex;
		session.currentPrice = session.themes[themeIndex].prices[questionIndex];
		session.isQuestionPlaying = true;
		this.answeredPlayers.clear();
		this.finalAnswers.clear();

		const question = session.currentQuestion;

		if (!question) {
			this.endGame();
			return;
		}

		this.atoms = buildContentAtoms(question, this.options.readingSpeed, item => this.resolveMedia(item));
		this.answerOptions = buildAnswerOptions(question, item => this.resolveMedia(item));

		this.sendAll(buildMessage(GameMessage.Question, session.currentPrice));
		this.sendAll(buildMessage(GameMessage.QuestionCaption, session.themes[themeIndex].name));
		this.sendAll(buildMessage(GameMessage.QType, question.type || 'simple', 'True', 'False'));

		// Ask stakes
		const stakeModes = 'Stake,Pass,AllIn';
		const maximum = Math.max(MIN_STAKE_STEP, session.currentPrice);

		session.players.forEach(player => {
			if (player.isHuman && player.isConnected) {
				this.sendTo(player.name, buildMessage(GameMessage.AskStake, stakeModes, MIN_STAKE_STEP, maximum, MIN_STAKE_STEP, 'FinalStake'));
			} else if (player.name.trim()) {
				player.stake = maximum;
			}
		});

		this.sendAll(buildMessage(GameMessage.Timer, 2, 'GO', this.getTimeSettings().timeForMakingStake * 10, -2));

		this.schedule(this.getTimeSettings().timeForMakingStake, () => this.askFinalAnswers());
	}

	private handlePass(sender: string): void {
		const index = this.session.getPlayerIndex(sender);

		if (index < 0) {
			return;
		}

		this.sendAll(buildMessage(GameMessage.Pass, index));
		this.session.players[index].stake = 0;
	}

	private handleStake(sender: string, mode: string, value: number): void {
		const index = this.session.getPlayerIndex(sender);

		if (index < 0) {
			return;
		}

		const player = this.session.players[index];

		if (!player) {
			return;
		}

		switch (mode) {
			case 'Pass':
				player.stake = 0;
				this.sendAll(buildMessage(GameMessage.PersonStake, index, 2));
				break;

			case 'AllIn':
				player.stake = Math.max(player.sum, this.session.currentPrice);
				this.sendAll(buildMessage(GameMessage.PersonStake, index, 3));
				break;

			default:
				player.stake = Number.isFinite(value) ? Math.max(MIN_STAKE_STEP, value) : this.session.currentPrice;
				this.sendAll(buildMessage(GameMessage.PersonStake, index, 1, player.stake));
				break;
		}

		this.sendAll(buildMessage(GameMessage.Timer, 2, 'STOP'));
	}

	/** Asks all players to give their final answers. */
	private askFinalAnswers(): void {
		const { session } = this;

		if (!session.isQuestionPlaying) {
			return;
		}

		this.sendAll(buildMessage(GameMessage.Timer, 2, 'STOP'));

		// Show question content
		this.atomIndex = 0;
		this.showFinalContent();
	}

	private showFinalContent(): void {
		if (this.atomIndex >= this.atoms.length) {
			this.askAllAnswers();
			return;
		}

		const atom = this.atoms[this.atomIndex];
		this.atomIndex += 1;

		if (atom.placement === 'background') {
			this.sendAll([GameMessage.Content2, 'background', 0, '', atom.type, '', atom.value].join('\n'));
			this.schedule(Math.max(atom.duration / 10, 0.2), () => this.showFinalContent());
			return;
		}

		this.sendAll([GameMessage.Content2, 'screen', 0, '', atom.type, '', atom.value].join('\n'));
		this.schedule(Math.max(atom.duration / 10, 0.2), () => this.showFinalContent());
	}

	private askAllAnswers(): void {
		const { session } = this;
		const answerTime = this.getTimeSettings().timeForFinalThinking;

		this.sendAll(buildMessage(GameMessage.FinalThink, answerTime));

		session.players.forEach((player, index) => {
			if (player.isHuman && player.isConnected) {
				this.sendTo(player.name, buildMessage(GameMessage.Answer, 'text'));
			} else if (player.name.trim()) {
				this.schedule(1 + Math.random() * 2, () => {
					const isRight = this.shouldBotAnswerRight();
					this.setFinalAnswer(index, isRight ? this.getBotAnswer(index) : '', isRight);
				});
			}
		});

		this.sendAll(buildMessage(GameMessage.Timer, 2, 'GO', answerTime * 10, -2));

		this.schedule(answerTime, () => this.finishFinalQuestion());
	}

	private setFinalAnswer(index: number, answer: string, isRight: boolean): void {
		this.finalAnswers.set(index, answer);
		this.session.players[index].answer = answer;
		this.sendAll(buildMessage(GameMessage.PlayerAnswer, index, answer));

		if (this.finalAnswers.size >= this.session.players.filter(player => player.name.trim()).length) {
			this.finishFinalQuestion();
		}

		void isRight;
	}

	private finishFinalQuestion(): void {
		const { session } = this;

		if (session.phase !== GamePhase.Final || !session.isQuestionPlaying) {
			return;
		}

		session.isQuestionPlaying = false;
		this.cancelPending();
		this.sendAll(buildMessage(GameMessage.Timer, 2, 'STOP'));

		const question = session.currentQuestion;

		if (question) {
			this.sendAll([GameMessage.Answers, ...session.players.map(player => player.answer ?? '')].join('\n'));
			this.sendAll(buildMessage(GameMessage.RightAnswer, 'text', question.right.answer[0] ?? ''));
		}

		session.players.forEach((player, index) => {
			if (!player.name.trim()) {
				return;
			}

			const answer = this.finalAnswers.get(index) ?? player.answer ?? '';
			const isRight = this.isFinalAnswerRight(answer);

			if (isRight) {
				player.sum += player.stake || 0;
				player.state = 'Right';
			} else if (player.stake > 0) {
				player.sum -= player.stake;
				player.state = 'Wrong';
			}

			this.sendAll(buildMessage(GameMessage.PersonFinalAnswer, index));
			this.sendAll(buildMessage(GameMessage.Person, isRight ? '+' : '-', index, Math.abs(player.stake || 0)));
		});

		this.sendSums();
		this.schedule(3, () => this.endGame());
	}

	private isFinalAnswerRight(answer: string): boolean {
		const question = this.session.currentQuestion;

		if (!question) {
			return false;
		}

		return question.right.answer.some(right => this.normalizeAnswer(right) === this.normalizeAnswer(answer));
	}

	/** Finishes the game. */
	endGame(): void {
		const { session } = this;

		if (session.phase === GamePhase.Finished) {
			return;
		}

		session.phase = GamePhase.Finished;
		session.isQuestionPlaying = false;
		this.cancelPending();

		this.sendAll(buildMessage(GameMessage.Stop));
		this.sendSums();
		this.sendAll(this.buildStatistics());

		const winnerIndex = this.getWinnerIndex();
		this.sendAll(buildMessage(GameMessage.Winner, winnerIndex));
		this.sendAll(buildMessage(GameMessage.Stage, GameStage.After));
		this.notifyChanged();
	}

	private buildStatistics(): string {
		const parts: string[] = [GameMessage.GameStatistics];

		for (const player of this.session.players) {
			if (!player.name.trim()) {
				continue;
			}

			parts.push(player.name, '0', '0', String(player.sum), '0');
		}

		return parts.join('\n');
	}

	private getWinnerIndex(): number {
		let winner = -1;
		let best = Number.NEGATIVE_INFINITY;

		this.session.players.forEach((player, index) => {
			if (player.name.trim() && player.sum > best) {
				best = player.sum;
				winner = index;
			}
		});

		return winner;
	}

	/** Handles table configuration commands (`CONFIG`). */
	private handleConfig(person: GamePerson, args: string[]): void {
		const command = args[1];

		switch (command) {
			case 'ADDTABLE': {
				if (this.session.phase !== GamePhase.Before) {
					return;
				}

				const botName = this.getFreeBotName();

				this.session.players.push({
					name: botName,
					role: PersonRole.Player,
					isMale: Math.random() > 0.5,
					isHuman: false,
					isConnected: false,
					isBot: true,
					isReady: true,
					sum: 0,
					stake: 0,
					state: 'None',
					answer: '',
				});

				const index = this.session.players.length - 1;
				this.sendAll([GameMessage.Config, 'ADDTABLE', botName, '+', '+', '-', '+'].join('\n'));
				this.sendInfo();
				this.sendAll(buildMessage(GameMessage.PlayerCount, this.session.players.length));
				void index;
				this.notifyChanged();
				break;
			}

			case 'DELETETABLE': {
				const index = parseInt(args[2], 10);

				if (index >= 0 && index < this.session.players.length) {
					this.session.players.splice(index, 1);
					this.sendAll(buildMessage(GameMessage.Config, 'DELETETABLE', index));
					this.sendInfo();
					this.notifyChanged();
				}

				break;
			}

			case 'FREE': {
				const isPlayer = args[2] === 'player';
				const index = isPlayer ? parseInt(args[3], 10) : -1;
				const target = isPlayer ? this.session.players[index] : this.session.showman;

				if (!target) {
					return;
				}

				target.name = GameSession.EMPTY_NAME;
				target.isHuman = false;
				target.isBot = false;
				target.isConnected = false;
				target.isReady = false;

				this.sendAll(buildMessage(GameMessage.Config, 'FREE', isPlayer ? 'player' : 'showman', isPlayer ? index : ''));
				this.sendInfo();
				this.notifyChanged();
				break;
			}

			case 'CHANGETYPE': {
				const isPlayer = args[2] === 'player';
				const index = isPlayer ? parseInt(args[3], 10) : -1;
				const target = isPlayer ? this.session.players[index] : this.session.showman;

				if (!target) {
					return;
				}

				const isHuman = args[4] === '+';
				const name = isHuman ? GameSession.EMPTY_NAME : this.getFreeBotName();

				target.name = name;
				target.isHuman = isHuman;
				target.isBot = !isHuman;
				target.isConnected = false;
				target.isReady = !isHuman;

				this.sendAll([
					GameMessage.Config,
					'CHANGETYPE',
					isPlayer ? 'player' : 'showman',
					isPlayer ? index : '',
					isHuman ? '+' : '-',
					name,
					target.isMale ? '+' : '-',
				].join('\n'));

				this.sendInfo();
				this.notifyChanged();
				break;
			}

			case 'SET': {
				const isPlayer = args[2] === 'player';
				const index = isPlayer ? parseInt(args[3], 10) : -1;
				const target = isPlayer ? this.session.players[index] : this.session.showman;

				if (!target) {
					return;
				}

				target.name = args[4] ?? GameSession.EMPTY_NAME;
				target.isHuman = false;
				target.isBot = true;
				target.isConnected = false;

				this.sendAll([
					GameMessage.Config,
					'SET',
					isPlayer ? 'player' : 'showman',
					isPlayer ? index : '',
					target.name,
					target.isMale ? '+' : '-',
				].join('\n'));

				this.sendInfo();
				this.notifyChanged();
				break;
			}

			default:
				break;
		}

		void person;
	}

	private getFreeBotName(): string {
		const used = new Set(this.session.persons.map(person => person.name));
		const names = ['Иннокентий', 'Александра', 'Борис', 'Василиса', 'Григорий', 'Дарья', 'Евгений', 'Зоя', 'Игорь', 'Ксения'];

		for (const name of names) {
			if (!used.has(name)) {
				return name;
			}
		}

		return `Игрок ${this.session.players.length + 1}`;
	}

	/** Handles game move commands. */
	private handleMove(person: GamePerson, args: string[]): void {
		if (!this.canManage(person)) {
			return;
		}

		const direction = parseInt(args[1], 10);

		switch (direction) {
			case 1:
			case 2:
				this.skipToNextRound();
				break;

			case 3: {
				// Jump to a specific round: the round indexes come from the package (see `ROUNDSNAMES`)
				const roundIndex = parseInt(args[2], 10);

				if (Number.isFinite(roundIndex) && roundIndex >= 0 && roundIndex < this.session.packageInfo.package.rounds.length) {
					this.skipToRound(roundIndex);
				}

				break;
			}

			default:
				break;
		}
	}

	/** Jumps to a round selected by the host. */
	private skipToRound(roundIndex: number): void {
		const { session } = this;

		this.cancelPending();
		session.isQuestionPlaying = false;

		if (session.packageInfo.package.rounds[roundIndex]?.type === 'final') {
			this.startFinalRound(roundIndex);
			return;
		}

		this.startRound(roundIndex);
	}

	private skipToNextRound(): void {
		const { session } = this;

		this.cancelPending();
		session.isQuestionPlaying = false;

		const nextIndex = session.roundIndex + 1;

		if (nextIndex >= session.packageInfo.package.rounds.length) {
			this.endGame();
			return;
		}

		if (session.packageInfo.package.rounds[nextIndex].type === 'final') {
			this.startFinalRound(nextIndex);
			return;
		}

		this.startRound(nextIndex);
	}

	private handlePause(person: GamePerson, isPaused: boolean): void {
		if (this.isPaused === isPaused) {
			return;
		}

		if (!this.canManage(person)) {
			return;
		}

		// The server drives all timings, so a pause freezes pending steps and the round timer
		if (isPaused) {
			this.pauseSteps();
			this.sendAll(buildMessage(GameMessage.Pause, '+', this.roundTimeLeft));
			return;
		}

		this.resumeSteps();
		this.sendAll(buildMessage(GameMessage.Pause, '-', this.roundTimeLeft));
	}

	/** Score value used instead of `''` when an option is broadcast. */
	private handleSetOptions(person: GamePerson, args: string[]): void {
		if (!this.canManage(person)) {
			return;
		}

		const name = args[1];
		const value = args[2] ?? '';

		if (!name) {
			return;
		}

		const applied = this.applyOption(name, value);

		if (!applied) {
			this.observer.log(`Неизвестный параметр игры от ${person.name}: ${name}`);
			return;
		}

		// The same message the real server sends: clients update their settings from it
		this.sendAll(buildMessage(GameMessage.Options2, person.name, name, value));
		this.notifyChanged();
	}

	/** Applies a game option. Returns false for unknown options. */
	private applyOption(name: string, value: string): boolean {
		const isEnabled = value.toLowerCase() === 'true';
		const seconds = Number.parseInt(value, 10);
		const { options } = this;

		switch (name) {
			case 'Oral':
				options.oral = isEnabled;
				return true;

			case 'Managed':
				options.managed = isEnabled;
				return true;

			case 'FalseStart':
				options.falseStart = isEnabled;
				return true;

			case 'PartialText':
				options.partialText = isEnabled;
				return true;

			case 'PartialImages':
				options.partialImages = isEnabled;
				return true;

			case 'UseApellations':
				options.useApellations = isEnabled;
				return true;

			case 'DisplayAnswerOptionsLabels':
				options.displayAnswerOptionsLabels = isEnabled;
				return true;

			case 'ReadingSpeed':
			case 'ReadingSpeed2':
				if (Number.isFinite(seconds) && seconds > 0) {
					options.readingSpeed = seconds;
				}
				return true;

			case 'PartialImageTime':
			case 'PartialImage':
				if (Number.isFinite(seconds) && seconds > 0) {
					options.partialImageTime = seconds;
				}
				return true;

			case 'TimeForBlockingButton':
			case 'ButtonBlocking':
				if (Number.isFinite(seconds) && seconds > 0) {
					this.timeSettingsOverride = { ...(this.timeSettingsOverride ?? {}), timeForBlockingButton: seconds };
				}
				return true;

			default:
				return false;
		}
	}

	/** Sends the current game options to a client (or to everyone). */
	sendOptions(personName?: string): void {
		const { options } = this;
		const pairs: [string, string][] = [
			['Oral', String(options.oral)],
			['Managed', String(options.managed)],
			['FalseStart', String(options.falseStart)],
			['PartialText', String(options.partialText)],
			['PartialImages', String(options.partialImages)],
			['UseApellations', String(options.useApellations)],
			['DisplayAnswerOptionsLabels', String(options.displayAnswerOptionsLabels)],
			['ReadingSpeed', String(options.readingSpeed)],
			['PartialImageTime', String(options.partialImageTime)],
			['TimeForBlockingButton', String(this.getTimeSettings().timeForBlockingButton)],
		];

		const text = buildMessage(GameMessage.Options2, '', ...pairs.flat());

		if (personName) {
			this.sendTo(personName, text);
		} else {
			this.sendAll(text);
		}
	}

	private handleValidation(person: GamePerson, args: string[]): void {
		// Showman validation is not supported by the local server: answers are validated by the engine
		void person;
		void args;
	}

	private handlePreloadProgress(sender: string, progress: number): void {
		if (!Number.isFinite(progress)) {
			return;
		}

		this.sendAll(buildMessage(GameMessage.MediaPreloadProgress, sender, Math.max(0, Math.min(100, progress))));
	}

	/** Called when a client reports that a media atom has finished playing. */
	private handleAtomCompleted(): void {
		// The server drives pacing by durations, so media completion only matters for
		// atoms that wait for the media end. To avoid double-advancing we ignore it.
	}

	private getTimeSettings() {
		return {
			timeForChoosingQuestion: 60,
			timeForThinkingOnQuestion: 30,
			timeForMakingStake: 30,
			timeForFinalThinking: 60,
			timeOfRound: 180,
			timeForBlockingButton: 5,
			timeForPrintingAnswer: 60,
			timeForRightAnswer: 10,
			...(this.serverTimeSettings ?? {}),
			...(this.timeSettingsOverride ?? {}),
		};
	}

	/** Server-level time settings (from the server configuration). */
	private serverTimeSettings: Partial<Record<string, number>> | undefined;

	/** Overrides default game time settings (game settings sent by the client). */
	setTimeSettings(settings: Partial<Record<string, number>> | undefined): void {
		this.timeSettingsOverride = settings;
	}

	/** Sets server-level time settings (they have a lower priority than game settings). */
	setServerTimeSettings(settings: Partial<Record<string, number>> | undefined): void {
		this.serverTimeSettings = settings;
	}

	private timeSettingsOverride: Partial<Record<string, number>> | undefined;

	/** Returns the media categories used by the package. */
	static getMediaCategories(): string[] {
		return Object.values(MediaCategory);
	}

	/**
	 * Builds an absolute media url.
	 * Absolute urls are used so that players connected by different addresses (localhost, LAN ip)
	 * always load media from the very host they use to reach the server.
	 */
	private buildMediaUrl(mediaPath: string): string {
		return `${this.getMediaBaseUrl()}${getMediaUrl(this.session.packageInfo, mediaPath)}`;
	}

	/** Returns the current question (for diagnostics and tests). */
	getQuestion(): Question | null {
		return this.session.currentQuestion;
	}

	/** Stops the game and cleans up resources. */
	dispose(): void {
		this.cancelPending();
	}
}

export default Game;
