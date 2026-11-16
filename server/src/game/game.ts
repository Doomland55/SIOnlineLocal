import { Question } from '../../../src/model/siquester/package';
import { buildMessage, escapeNewLines, GameMessage, GameStage, MediaCategory, SERVER_HOST_PLACEHOLDER } from '../protocol';
import { AnswerOptionPlan, buildAnswerOptions, buildContentAtoms, ContentAtom, getAnswerContentAtoms } from './questionPlan';
import { getMediaUrl, LoadedPackage, MEDIA_ROUTE_PREFIX, resolveMediaPath } from './package';
import { GamePerson, GamePhase, GameSession, isEmptySlotName, MAX_PLAYER_COUNT, PersonRole } from './session';

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

/** A participant is bound to a name as seats may be released and reused during the final. */
interface FinalParticipant {
	name: string;
	sum: number;
	stake: number | null;
	answer: string | null;
	draft: string;
}

/** A single game hosted by the local server. */
export class Game {
	public readonly session: GameSession;

	/** Join credentials and viewer policy set when the game is created. */
	public joinPassword = '';

	public allowViewers = true;

	/** Connections of the persons by name. */
	private readonly connections = new Map<string, GameClientConnection>();

	/** Pending timeouts. */
	private readonly timeouts = new Set<NodeJS.Timeout>();

	/** Content atoms of the current question. */
	private atoms: ContentAtom[] = [];

	private waitingAnswerMedia: { atom: ContentAtom; step: PendingStep; advance: () => void; completedWhilePaused?: boolean } | null = null;

	/** Index of the next atom to show. */
	private atomIndex = 0;

	/** Answer options of the current question. */
	private answerOptions: AnswerOptionPlan[] = [];

	/** Players who have already answered the current question. */
	private readonly answeredPlayers = new Set<number>();

	/** Answers that wait for the decision of the showman in an oral game. */
	private readonly answersToValidate = new Map<number, number>();

	/** Players who can press the button in the current question. */
	private pendingPressers: number[] = [];

	private pressTurn = 0;

	/** Final decisions are kept private until the simultaneous reveal. */
	private finalParticipants = new Map<number, FinalParticipant>();

	private finalStage: 'none' | 'themes' | 'stake' | 'content' | 'answer' | 'reveal' = 'none';

	private finalThemeRemaining = new Set<number>();

	private finalDeleters: { index: number; name: string; sum: number }[] = [];

	private finalDeleteTurn = 0;

	private finalDeletePending = false;

	/** Round timer value in tenths. */
	private roundTimeLeft = 0;

	/** True when the game timers are paused. */
	private isPaused = false;

	/** Foreground transition, distinct from the round deadline and bot background actions. */
	private mainStep: PendingStep | null = null;

	private readonly visibleTimers: ({ maximum: number; startedAt: number; elapsed: number; running: boolean } | null)[] = [null, null, null];

	/** Steps scheduled by the game logic. */
	private pendingSteps: PendingStep[] = [];

	/** The round deadline is independent of question-level steps. */
	private roundStep: PendingStep | null = null;

	/** Invalidates callbacks from earlier chooser turns. */
	private choiceTurn = 0;

	private choosingQuestion = false;

	private firstChoicePending = false;

	/** Seat edits that would invalidate an active question are applied after it ends. */
	private pendingSeatEdits: { person: GamePerson; args: string[]; target: GamePerson }[] = [];

	private roundExpired = false;

	private closingQuestion = false;

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

		this.connectionBaseUrls.set(personName, (baseUrl ?? this.publicBaseUrl).replace(/\/+$/, ''));

		this.notifyChanged();
	}

	/** Each client receives media URLs for the host it used to reach the server. */
	private readonly connectionBaseUrls = new Map<string, string>();

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
				this.connectionBaseUrls.delete(name);

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
			person.role === PersonRole.Showman ? 'showman' : person.role === PersonRole.Player ? 'player' : 'viewer',
			person.role === PersonRole.Player ? this.session.getPlayerIndex(name) : '',
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

		const index = session.getPlayerIndex(personName);

		if (session.phase === GamePhase.Final && this.finalStage === 'themes') {
			const deleter = this.finalDeleters[this.finalDeleteTurn % this.finalDeleters.length];
			if (this.finalDeletePending && deleter?.index === index && deleter.name === personName) {
				this.sendTo(personName, buildMessage(GameMessage.Choose, 2));
			}
			return;
		}

		if (session.phase === GamePhase.Round && this.choosingQuestion &&
			(personName === session.players[session.chooserIndex]?.name || personName === session.showman.name)) {
			this.sendTo(personName, buildMessage(GameMessage.Choose, 1));
		}

		if (!session.isQuestionPlaying) {
			return;
		}

		if (personName === session.showman.name && session.showman.isHuman) {
			this.sendQuestionAnswers(personName);
		}
		if (personName === this.getManagerName()) {
			const pendingIndex = this.answersToValidate.keys().next().value;
			if (pendingIndex !== undefined) {
				this.sendTo(personName, buildMessage(GameMessage.AskValidate, pendingIndex, '', '-'));
			}
		}

		if (session.phase === GamePhase.Final) {
			const participant = this.finalParticipants.get(index);
			if (participant?.name === personName) {
				if (this.finalStage === 'stake' && participant.stake === null) {
					this.sendFinalStakePrompt(participant);
				} else if (this.finalStage === 'answer' && participant.answer === null) {
					this.sendTo(personName, buildMessage(GameMessage.Answer, 'text'));
				}
			}
			return;
		}

		if (index >= 0 && index === session.answererIndex && !session.isQuestionAnswerShown
			&& !this.answeredPlayers.has(index) && !this.answersToValidate.has(index)) {
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
		const parts = text.split('\n');
		if (parts[0] === GameMessage.Timer) {
			const index = Number(parts[1]);
			if (index >= 0 && index < this.visibleTimers.length) {
				if (parts[2] === 'GO') {
					this.visibleTimers[index] = { maximum: Number(parts[3]), startedAt: Date.now(), elapsed: 0, running: true };
				} else if (parts[2] === 'STOP') {
					this.visibleTimers[index] = null;
				}
			}
		} else if (parts[0] === GameMessage.Stop) {
			this.visibleTimers.fill(null);
		}
		for (const [name, connection] of this.connections) {
			connection.send('Receive', {
				IsSystem: true,
				Sender: '@',
				Text: this.resolveClientMediaUrls(name, text),
			});
		}
	}

	private resolveClientMediaUrls(name: string, text: string): string {
		const marker = `${SERVER_HOST_PLACEHOLDER}${MEDIA_ROUTE_PREFIX}/${this.packageInfo.id}/`;
		const base = this.connectionBaseUrls.get(name) ?? this.publicBaseUrl;
		return text.replaceAll(marker, `${base}${MEDIA_ROUTE_PREFIX}/${this.packageInfo.id}/`);
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
			Text: this.resolveClientMediaUrls(personName, text),
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
	private schedule(seconds: number, action: () => void): PendingStep {
		const step: PendingStep = {
			action,
			dueAt: Date.now() + Math.max(0, seconds * 1000),
			remaining: Math.max(0, seconds * 1000),
			timeout: undefined,
		};

		this.pendingSteps.push(step);
		if (!this.isPaused) this.armStep(step);
		return step;
	}

	private cancelMainStep(): void {
		if (!this.mainStep) return;
		if (this.mainStep.timeout) clearTimeout(this.mainStep.timeout);
		this.pendingSteps = this.pendingSteps.filter(step => step !== this.mainStep);
		this.mainStep = null;
	}

	private scheduleMain(seconds: number, action: () => void): PendingStep {
		this.cancelMainStep();
		const step = this.schedule(seconds, () => {
			if (this.mainStep === step) this.mainStep = null;
			action();
		});
		this.mainStep = step;
		return step;
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
	}

	/** Resumes all pending steps (game resume). */
	private resumeSteps(): void {
		this.isPaused = false;

		for (const step of this.pendingSteps) {
			this.armStep(step);
		}
	}

	/** Cancels all pending steps. */
	private cancelPending(preserveRound = false): void {
		this.waitingAnswerMedia = null;
		this.mainStep = null;
		for (const step of this.pendingSteps) {
			if (step.timeout && (!preserveRound || step !== this.roundStep)) {
				clearTimeout(step.timeout);
			}
		}

		this.pendingSteps = preserveRound && this.roundStep && this.pendingSteps.includes(this.roundStep)
			? [this.roundStep] : [];

		if (!preserveRound) {
			this.roundStep = null;
		}
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

	/** Remembers the avatar of a person and broadcasts it to everybody. */
	private handleAvatar(person: GamePerson, contentType: string, uri: string): void {
		if (contentType !== 'image' && contentType !== 'video') {
			return;
		}

		const value = uri.trim();

		if (!value) {
			return;
		}

		// Avatars are sent as hyperlinks; relative links are resolved by the clients against the game server
		person.avatar = value;

		const message = buildMessage(GameMessage.Avatar, person.name, contentType, value);
		this.sendAll(message);

		// Late joiners receive the current avatars with the rest of the state
		const avatars = this.avatars.get(person.name) ?? {};
		avatars[contentType] = value;
		this.avatars.set(person.name, avatars);
	}

	/** Avatars of the persons that are in the game (used for the full state sync). */
	private readonly avatars = new Map<string, { image?: string; video?: string }>();

	/** Sends the avatars of all persons that are in the game. */
	private sendAvatars(personName: string): void {
		for (const [name, avatar] of this.avatars) {
			const person = this.session.findPerson(name);

			if (!person) {
				continue;
			}

			if (avatar.image) this.sendTo(personName, buildMessage(GameMessage.Avatar, name, 'image', avatar.image));
			if (avatar.video) this.sendTo(personName, buildMessage(GameMessage.Avatar, name, 'video', avatar.video));
		}
	}

	/** Sends the full game state to a person (used on join and on `INFO`). */
	sendFullState(personName: string): void {
		const { session } = this;

		this.sendMetadata(personName);
		// The client enables management buttons only when its name matches HOSTNAME
		this.sendHostName(personName);
		this.sendOptions(personName);
		this.sendInfo(personName);
		this.sendAvatars(personName);
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

		const rules = session.phase === GamePhase.Final ? 'RemoveOtherThemes' : 'SelectByPlayer';
		const text = buildMessage(GameMessage.Stage, stage, session.roundName, session.roundIndex, rules);

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
		const themesMode = session.phase === GamePhase.Final ? 'AllTogether' : 'OneByOne';
		const themesText = [GameMessage.RoundThemes2, themesMode, ...session.themes.map(theme => theme.name)].join('\n');

		if (personName) {
			this.sendTo(personName, roundsText);
			this.sendTo(personName, themesText);
			if (session.phase === GamePhase.Final) {
				session.themes.forEach((_theme, index) => {
					if (!this.finalThemeRemaining.has(index)) {
						this.sendTo(personName, buildMessage(GameMessage.Out, index));
					}
				});
				return;
			}
			session.themes.forEach((theme, index) => this.sendTheme(personName, index, theme));
			return;
		}

		this.sendAll(roundsText);
		this.sendAll(themesText);
		if (session.phase === GamePhase.Final) {
			return;
		}
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

		// Do not allow decisions to advance or mutate a paused game.
		if (this.isPaused && [
			'CHOICE', 'I', 'ANSWER', 'ANSWER_VERSION', 'PASS', 'SET_STAKE', 'STAKE', 'VALIDATE', 'ISRIGHT', 'CONFIG', 'DELETE', 'SETCHOOSER',
		].includes(command)) {
			return;
		}

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

			case 'SETCHOOSER':
				this.handleSetChooser(person, args[1] ?? '');
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
				this.handleStake(sender, args[1] ?? '', Number(args[2] ?? ''));
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
				// Join restrictions are not implemented; do not advertise a mode that is not enforced.
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
				this.handleAtomCompleted(sender, args[1] ?? '', args[2] ?? '');
				break;

			case 'VALIDATE':
			case 'ISRIGHT':
				this.handleValidation(person, args);
				break;

			case 'DELETE':
				this.handleFinalThemeDelete(sender, /^\d+$/.test(args[1] ?? '') ? Number(args[1]) : NaN);
				break;

			case 'SETHOST':
			case 'BAN':
			case 'UNBAN':
			case 'MARK':
			case 'REPORT':
			case 'TOGGLE':
			case 'LEADERBOARD':
			case 'CHANGE':
			case 'APELLATE':
				// These commands are not implemented; do not interpret their arguments as an avatar.
				this.observer.log(`Команда пока не поддерживается: ${command}`);
				break;

			case 'AVATAR':
				this.handleAvatar(person, args[1] ?? '', args[2] ?? '');
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

		this.scheduleMain(2, () => this.startRound(0));
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
		this.firstChoicePending = true;
		session.themeIndex = -1;
		session.questionIndex = -1;
		session.isQuestionPlaying = false;

		// All themes of the round are kept, so the table keeps its original size.
		// Played questions are marked with -1 (hidden) instead of being removed
		const themes = round.themes.map(theme => ({
			name: theme.name,
			comments: theme.info?.comments ?? '',
			prices: theme.questions.map(question => question.price),
		}));

		session.themes = themes;

		if (themes.every(theme => !theme.prices.some(price => price >= 0))) {
			this.endRound('empty');
			return;
		}

		this.roundTimeLeft = this.getRoundDuration(roundIndex);
		this.roundExpired = false;
		this.closingQuestion = false;

		this.sendAll(buildMessage(GameMessage.Stage, GameStage.Round, round.name, roundIndex, 'SelectByPlayer'));
		this.sendRoundInfo();
		this.sendTable();
		this.sendRoundContent();
		this.sendAll(buildMessage(GameMessage.Timer, 0, 'GO', this.roundTimeLeft));
		this.notifyChanged();

		this.roundStep = this.schedule(this.roundTimeLeft / 10, () => {
			this.roundStep = null;
			this.roundTimeLeft = 0;
			this.roundExpired = true;
			if (!session.isQuestionPlaying && !this.closingQuestion) {
				this.endRound('timeout');
			}
		});

		this.scheduleMain(1, () => this.askToSelectQuestion());
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
		const turn = ++this.choiceTurn;
		this.choosingQuestion = true;

		if (!chooser) {
			this.endRound('empty');
			return;
		}

		if (session.showman.isHuman && session.showman.isConnected && session.showman.name !== chooser.name) {
			this.sendTo(session.showman.name, buildMessage(GameMessage.Choose, 1));
		}

		if (chooser.isBot || !chooser.isConnected) {
			this.sendAll(buildMessage(GameMessage.SetChooser, session.chooserIndex, '+', 'ANNOUNCE'));
			// Give a live showman time to assign the opening move before a bot chooses it.
			const botDelay = this.firstChoicePending && session.showman.isHuman && session.showman.isConnected
				? Math.min(10, this.getTimeSettings().timeForChoosingQuestion) : 1.5;
			this.scheduleMain(botDelay, () => {
				if (this.choiceTurn === turn && session.phase === GamePhase.Round && !session.isQuestionPlaying && !this.closingQuestion) {
					this.makeBotChoice();
				}
			});
			return;
		}

		this.sendTo(chooser.name, [GameMessage.Choose, '1'].join('\n'));
		this.sendAll(buildMessage(GameMessage.SetChooser, session.chooserIndex, '+', 'ANNOUNCE'));
		this.sendAll(buildMessage(GameMessage.Timer, 2, 'GO', this.getTimeSettings().timeForChoosingQuestion * 10, session.chooserIndex));

		// Fallback: bot-like selection if the chooser is idle
		const expectedRound = session.roundIndex;
		this.scheduleMain(this.getTimeSettings().timeForChoosingQuestion, () => {
			if (this.choiceTurn === turn && this.session.phase === GamePhase.Round
				&& this.session.roundIndex === expectedRound && !session.isQuestionPlaying && !this.closingQuestion) {
				this.makeBotChoice();
			}
		});
	}

	/** The manager can hand the turn to an active player before a question starts. */
	private handleSetChooser(person: GamePerson, value: string): void {
		if (!this.canManage(person) || this.session.phase !== GamePhase.Round
			|| this.session.isQuestionPlaying || this.closingQuestion || !/^\d+$/.test(value)) return;
		const index = Number(value);
		if (!Number.isSafeInteger(index) || !this.isActiveSeat(this.session.players[index])) return;
		const oldChooser = this.session.players[this.session.chooserIndex];
		if (this.choosingQuestion && oldChooser && oldChooser !== this.session.players[index]) {
			this.sendTo(oldChooser.name, buildMessage(GameMessage.Cancel));
		}
		this.session.chooserIndex = index;
		this.sendAll(buildMessage(GameMessage.SetChooser, index, '-', '+'));
		if (this.choosingQuestion) this.askToSelectQuestion();
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

		if (session.phase !== GamePhase.Round || session.isQuestionPlaying || this.closingQuestion) {
			return;
		}

		if (!Number.isInteger(themeIndex) || themeIndex < 0 || themeIndex >= session.themes.length) {
			return;
		}

		const prices = session.themes[themeIndex].prices;

		if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= prices.length || prices[questionIndex] < 0) {
			return;
		}

		const chooser = session.players[session.chooserIndex];

		if (!this.choosingQuestion || (chooser?.name !== sender &&
			!(session.showman.isHuman && session.showman.isConnected && session.showman.name === sender))) {
			return;
		}
		this.cancelMainStep();
		if (chooser) this.sendTo(chooser.name, buildMessage(GameMessage.Cancel));
		if (session.showman.name !== chooser?.name) this.sendTo(session.showman.name, buildMessage(GameMessage.Cancel));

		const price = prices[questionIndex];
		this.choiceTurn += 1;
		this.choosingQuestion = false;
		this.firstChoicePending = false;
		this.closingQuestion = true; // A selected question must play even if the round time expires during the transition.
		prices[questionIndex] = -1;

		session.themeIndex = themeIndex;
		session.questionIndex = questionIndex;
		session.currentPrice = price;

		this.sendAll(buildMessage(GameMessage.Timer, 2, 'STOP'));
		this.sendAll(GameMessage.Choice + '\n' + themeIndex + '\n' + questionIndex + '\n' + price);
		this.sendTable();

		this.scheduleMain(1, () => this.startQuestion());
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
		this.closingQuestion = false;
		session.isQuestionAnswerShown = false;
		session.answererIndex = -1;
		session.answerers = [];
		this.answeredPlayers.clear();
		this.answersToValidate.clear();
		this.pendingPressers = [];
		this.atomIndex = 0;


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
		this.sendQuestionAnswers(session.showman.name);
		this.sendAll(buildMessage(GameMessage.QuestionCaption, theme?.name ?? ''));
		this.sendAll(buildMessage(GameMessage.QType, questionType || 'simple', isDefault ? 'True' : 'False', isNoRisk ? 'True' : 'False'));
		this.sendAll(buildMessage(GameMessage.Timer, 2, 'STOP'));

		if (this.answerOptions.length > 0) {
			this.sendLayout();
		}

		this.sendAll(buildMessage(GameMessage.PlayerState, 'None'));

		this.scheduleMain(0.5, () => this.showNextAtom());
	}

	/** Sends answer hints privately to the showman, never to players or spectators. */
	private sendQuestionAnswers(personName: string): void {
		const question = this.session.currentQuestion;
		if (!question || personName !== this.session.showman.name || !this.session.showman.isHuman) return;
		const right = question.right.answer.map(escapeNewLines);
		const wrong = (question.wrong?.answer ?? []).map(escapeNewLines);
		this.sendTo(personName, buildMessage(GameMessage.QuestionAnswers, right.length, ...right, ...wrong));
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
				this.scheduleMain(atom.duration / 10, () => this.showNextAtom());
			} else {
				this.showNextAtom();
			}

			return;
		}

		if (atom.placement === 'replic') {
			this.sendAll(buildMessage(GameMessage.Replic, 's', escapeNewLines(atom.value)));
			this.scheduleMain(Math.max(atom.duration / 10, 0.2), () => this.showNextAtom());
			return;
		}

		this.sendAll([GameMessage.Content2, 'screen', 0, '', atom.type, '', atom.value].join('\n'));

		if (!atom.waitForFinish) {
			this.showNextAtom();
			return;
		}

		this.scheduleMain(Math.max(atom.duration / 10, 0.2), () => this.showNextAtom());
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
		let index = 0;
		const showNext = () => {
			if (index >= this.answerOptions.length) {
				this.scheduleMain(0.3, () => this.beginPressPhase());
				return;
			}
			const option = this.answerOptions[index];
			this.sendAll([GameMessage.Content2, 'screen', index + 1, option.label, option.type, '', option.value].join('\n'));
			index += 1;
			this.scheduleMain(0.4, showNext);
		};
		showNext();
	}

	/** Enables button pressing for the players. */
	private beginPressPhase(): void {
		const { session } = this;

		if (!session.isQuestionPlaying || session.isQuestionAnswerShown) {
			return;
		}

		this.pendingPressers = this.collectPressers();
		this.pressTurn += 1;

		if (this.pendingPressers.length === 0) {
			this.finishQuestionWithoutAnswer();
			return;
		}

		const pressTime = this.getTimeSettings().timeForThinkingOnQuestion * 10;

		this.sendAll(buildMessage(GameMessage.Try));
		this.sendAll(buildMessage(GameMessage.Timer, 1, 'GO', pressTime));

		this.scheduleMain(pressTime / 10, () => {
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

		const turn = this.pressTurn;
		this.schedule(1.5 + Math.random() * 3, () => {
			if (turn !== this.pressTurn || this.session.answererIndex >= 0 || !this.session.isQuestionPlaying) {
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

		if (this.isPaused || !session.isQuestionPlaying || session.isQuestionAnswerShown || session.answererIndex >= 0) {
			return;
		}

		const index = session.getPlayerIndex(sender);

		if (index < 0 || !this.pendingPressers.includes(index)) {
			return;
		}

		const answerer = session.players[index];

		this.pressTurn += 1;
		session.answererIndex = index;
		session.answerers = [index];
		this.pendingPressers = this.pendingPressers.filter(value => value !== index);

		this.sendAll(buildMessage(GameMessage.Timer, 1, 'STOP'));
		this.sendAll(buildMessage(GameMessage.EndTry, index));

		if (answerer.isHuman && answerer.isConnected) {
			if (this.options.oral) {
				this.askToValidate(index);
				return;
			}
			const answerTime = this.getTimeSettings().timeForPrintingAnswer;
			this.sendTo(answerer.name, buildMessage(GameMessage.Answer, 'text'));
			this.sendAll(buildMessage(GameMessage.Timer, 2, 'GO', answerTime * 10, index));

			this.scheduleMain(answerTime, () => {
				if (this.session.answererIndex === index && !this.session.isQuestionAnswerShown) {
					this.validateAnswer(index, '', false);
				}
			});
		} else {
			// Bot answer
			this.scheduleMain(1 + Math.random() * 2, () => this.validateAnswer(index, this.getBotAnswer(index), this.shouldBotAnswerRight()));
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

		if (this.session.phase === GamePhase.Final) {
			const participant = this.finalParticipants.get(index);
			if (!this.isPaused && this.finalStage === 'answer' && participant?.name === sender && participant.answer === null) {
				participant.answer = answer;
			}
			return;
		}

		if (index < 0 || this.isPaused || this.session.phase !== GamePhase.Round
			|| !this.session.isQuestionPlaying || this.session.isQuestionAnswerShown
			|| this.answeredPlayers.has(index) || this.answersToValidate.has(index)) {
			return;
		}

		if (this.session.answererIndex !== index) {
			return;
		}

		// Oral responses are spoken and assessed by the manager, not submitted as text.
		if (this.options.oral) return;

		this.validateAnswer(index, answer, this.isAnswerRight(answer));
	}

	/** Starts a manual decision for the spoken answer without soliciting text. */
	private askToValidate(playerIndex: number): void {
		const managerName = this.getManagerName();
		const manager = managerName ? this.session.findPerson(managerName) : null;
		if (!manager || !manager.isHuman || !manager.isConnected) {
			this.validateAnswer(playerIndex, '', false);
			return;
		}

		// Freeze the question until the manager decides; the independent round deadline remains.
		this.cancelPending(true);
		this.sendAll(buildMessage(GameMessage.Timer, 2, 'STOP'));
		this.answersToValidate.set(playerIndex, Date.now());
		this.session.players[playerIndex].answer = '';
		this.sendTo(managerName, buildMessage(GameMessage.AskValidate, playerIndex, '', '-'));
	}

	private handleAnswerVersion(sender: string, answer: string): void {
		const index = this.session.getPlayerIndex(sender);

		if (this.session.phase === GamePhase.Final) {
			const participant = this.finalParticipants.get(index);
			if (!this.isPaused && this.finalStage === 'answer' && participant?.name === sender && participant.answer === null) {
				participant.draft = answer;
			}
			return;
		}

		if (index < 0) {
			return;
		}

		if (this.isPaused || this.options.oral || !this.session.isQuestionPlaying || this.session.isQuestionAnswerShown
			|| this.session.answererIndex !== index || this.answersToValidate.has(index)) {
			return;
		}

		this.session.players[index].answer = answer;
	}

	private isAnswerRight(answer: string): boolean {
		const question = this.session.currentQuestion;

		if (!question) {
			return false;
		}

		const normalized = this.normalizeAnswer(answer);

		if (this.answerOptions.length > 0) {
			const option = this.answerOptions.find(item => this.normalizeAnswer(item.label) === normalized);

			if (option) {
				const right = question.right.answer.map(value => this.normalizeAnswer(value));
				const hasLabels = this.answerOptions.some(item => right.includes(this.normalizeAnswer(item.label)));
				// Labels take precedence; older local packages may store option content instead.
				return right.includes(this.normalizeAnswer(hasLabels ? option.label : option.value));
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

		this.cancelMainStep();
		session.players[playerIndex].answer = answer;
		this.answeredPlayers.add(playerIndex);
		if (session.answererIndex === playerIndex) session.answererIndex = -1;
		this.pendingPressers = this.pendingPressers.filter(index => index !== playerIndex);
		this.answersToValidate.delete(playerIndex);
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

		if (this.areOnlyPassedPlayersLeft()) {
			this.finishQuestionWithoutAnswer();
			return;
		}

		this.scheduleMain(1, () => this.beginPressPhase());
	}

	private getPenaltyAmount(): number {
		return this.session.currentQuestion?.type === 'noRisk' ? 0 : this.session.currentPrice;
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
	}

	/** Show answer items in order; unknown media duration is driven by playback completion. */
	private playAnswerContent(done: () => void): void {
		const question = this.session.currentQuestion;
		const atoms = question ? getAnswerContentAtoms(question, this.options.readingSpeed, item => this.resolveMedia(item)) : [];
		let index = 0;
		const next = () => {
			if (index >= atoms.length) {
				done();
				return;
			}
			const atom = atoms[index++];
			this.sendAll([GameMessage.Content2, atom.placement, 0, '', atom.type, '',
				atom.type === 'text' ? escapeNewLines(atom.value) : atom.value].join('\n'));
			if (!atom.waitForFinish && index < atoms.length) {
				next();
			} else if (atom.waitForMediaEnd) {
				// Playback failures or autoplay restrictions must not hang the game forever.
				const step = this.scheduleMain(180, () => {
					this.waitingAnswerMedia = null;
					next();
				});
				this.waitingAnswerMedia = { atom, step, advance: next };
			} else {
				this.scheduleMain(Math.max(atom.type === 'text' ? 3 : 0.2, atom.duration / 10), next);
			}
		};
		if (atoms.length) next();
		else this.scheduleMain(3, done);
	}

	private getRightOptionIndex(): number {
		const question = this.session.currentQuestion;

		if (!question || this.answerOptions.length === 0) {
			return -1;
		}

		const right = question.right.answer.map(answer => this.normalizeAnswer(answer));

		// SIQ select answers name an option; content matching supports older local packages.
		const labelIndex = this.answerOptions.findIndex(option => right.includes(this.normalizeAnswer(option.label)));
		return labelIndex >= 0 ? labelIndex : this.answerOptions.findIndex(option => right.includes(this.normalizeAnswer(option.value)));
	}

	/** Returns the label of the right answer option (used to mark it in the answer options layout). */
	private getRightOptionLabel(): string | null {
		return this.answerOptions[this.getRightOptionIndex()]?.label ?? null;
	}

	private finishQuestionWithoutAnswer(): void {
		this.sendAll(buildMessage(GameMessage.Timer, 1, 'STOP'));
		this.sendAll(buildMessage(GameMessage.Timer, 2, 'STOP'));
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
		this.pressTurn += 1;
		this.closingQuestion = true;
		this.pendingPressers = [];
		this.cancelPending(true);
		this.restoreRoundTimer();

		if (outcome?.right) {
			session.chooserIndex = outcome.answerer;
		}

		this.playAnswerContent(() => {
			this.sendAll(buildMessage(GameMessage.QuestionEnd));
			this.sendAll(buildMessage(GameMessage.ShowTable));
			this.sendSums();
			this.notifyChanged();

			this.closingQuestion = false;
			this.applyPendingSeatEdits();
			if (this.roundExpired) {
				this.endRound('timeout');
				return;
			}

			if (this.getActiveQuestionsCount() === 0) {
				this.scheduleMain(1, () => this.endRound('empty'));
				return;
			}

			this.scheduleMain(1, () => this.askToSelectQuestion());
		});
	}

	/** Restarts the round timer after a question has finished. */
	private restoreRoundTimer(): void {
		this.roundTimeLeft = this.getRoundTimeLeft();
		this.sendAll(this.roundTimeLeft > 0
			? buildMessage(GameMessage.Timer, 0, 'GO', this.roundTimeLeft)
			: buildMessage(GameMessage.Timer, 0, 'STOP'));
	}

	private getRoundTimeLeft(): number {
		if (!this.roundStep) {
			return this.roundTimeLeft;
		}
		const remaining = this.isPaused ? this.roundStep.remaining : this.roundStep.dueAt - Date.now();
		return Math.max(0, Math.ceil(remaining / 100));
	}

	/** Ends the current round. */
	endRound(reason: string): void {
		const { session } = this;

		if (session.phase !== GamePhase.Round) {
			return;
		}

		session.isQuestionPlaying = false;
		this.choosingQuestion = false;
		this.choiceTurn += 1;
		this.cancelPending();
		this.applyPendingSeatEdits();

		this.sendAll(buildMessage(GameMessage.Stop));
		this.sendSums();
		this.sendAll(buildMessage(GameMessage.RoundEnd, reason));

		const nextIndex = session.roundIndex + 1;

		if (nextIndex >= session.packageInfo.package.rounds.length) {
			this.scheduleMain(2, () => this.endGame());
			return;
		}

		const nextRound = session.packageInfo.package.rounds[nextIndex];

		if (nextRound.type === 'final') {
			this.scheduleMain(2, () => this.startFinalRound(nextIndex));
			return;
		}

		this.scheduleMain(2, () => this.startRound(nextIndex));
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
		session.isQuestionPlaying = false;
		session.isQuestionAnswerShown = false;
		this.finalStage = 'none';
		this.finalParticipants.clear();

		session.themes = round.themes.map(theme => ({
			name: theme.name,
			comments: theme.info?.comments ?? '',
			prices: theme.questions.map(question => question.price),
		}));

		this.finalThemeRemaining = new Set(session.themes
			.map((theme, index) => (theme.prices.some(price => price >= 0) ? index : -1))
			.filter(index => index >= 0));
		this.finalDeleters = session.players
			.map((player, index) => ({ index, name: player.name, sum: player.sum, active: this.isActiveSeat(player) }))
			.filter(player => player.active && Number.isSafeInteger(player.sum) && player.sum > 0)
			.sort((a, b) => a.sum - b.sum || a.index - b.index);
		// Rotate the ascending score order so the highest-scoring player has the last deletion.
		if (this.finalDeleters.length > 0) {
			const deletions = Math.max(0, this.finalThemeRemaining.size - 1);
			const offset = (this.finalDeleters.length - deletions % this.finalDeleters.length) % this.finalDeleters.length;
			this.finalDeleters = [...this.finalDeleters.slice(offset), ...this.finalDeleters.slice(0, offset)];
		}
		this.finalDeleteTurn = 0;
		this.finalDeletePending = false;
		this.finalStage = 'themes';

		this.sendAll(buildMessage(GameMessage.Stage, GameStage.Round, round.name, roundIndex, 'RemoveOtherThemes'));
		this.sendRoundInfo();
		for (let index = 0; index < session.themes.length; index += 1) {
			if (!this.finalThemeRemaining.has(index)) {
				this.sendAll(buildMessage(GameMessage.Out, index));
			}
		}
		this.notifyChanged();

		if (this.finalDeleters.length === 0 || this.finalThemeRemaining.size === 0) {
			this.endGame();
			return;
		}
		this.scheduleMain(2, () => this.askToDeleteFinalTheme());
	}

	/** Gives each eligible player a turn; an idle or absent player is handled by a bounded fallback. */
	private askToDeleteFinalTheme(): void {
		if (this.session.phase !== GamePhase.Final || this.finalStage !== 'themes') {
			return;
		}
		if (this.finalThemeRemaining.size <= 1) {
			this.startFinalQuestion();
			return;
		}

		this.finalDeletePending = true;
		const turn = this.finalDeleteTurn;
		const deleter = this.finalDeleters[turn % this.finalDeleters.length];
		const player = this.session.players[deleter.index];
		this.session.chooserIndex = deleter.index;
		this.sendAll(buildMessage(GameMessage.SetChooser, deleter.index, '+', '-', 'ANNOUNCE'));
		if (player?.name === deleter.name && player.isHuman && player.isConnected) {
			this.sendTo(deleter.name, buildMessage(GameMessage.Choose, 2));
		}
		const seconds = player?.name === deleter.name && player.isBot ? 1.5 : this.getTimeSettings().timeForChoosingFinalTheme;
		this.sendAll(buildMessage(GameMessage.Timer, 2, 'GO', seconds * 10, deleter.index));
		this.scheduleMain(seconds, () => {
			if (this.session.phase === GamePhase.Final && this.finalStage === 'themes' && this.finalDeleteTurn === turn) {
				const remaining = [...this.finalThemeRemaining];
				this.deleteFinalTheme(remaining[Math.floor(Math.random() * remaining.length)]);
			}
		});
	}

	private handleFinalThemeDelete(sender: string, index: number): void {
		if (this.isPaused || this.session.phase !== GamePhase.Final || this.finalStage !== 'themes'
			|| !this.finalDeletePending || !Number.isInteger(index) || !this.finalThemeRemaining.has(index)) {
			return;
		}
		const deleter = this.finalDeleters[this.finalDeleteTurn % this.finalDeleters.length];
		if (!deleter || deleter.name !== sender || this.session.getPlayerIndex(sender) !== deleter.index) {
			return;
		}
		this.deleteFinalTheme(index);
	}

	private deleteFinalTheme(index: number): void {
		if (!this.finalThemeRemaining.has(index) || this.finalThemeRemaining.size <= 1) {
			return;
		}
		const deleter = this.finalDeleters[this.finalDeleteTurn % this.finalDeleters.length];
		this.finalDeletePending = false;
		this.sendTo(deleter.name, buildMessage(GameMessage.Cancel));
		this.finalThemeRemaining.delete(index);
		this.finalDeleteTurn += 1;
		this.sendAll(buildMessage(GameMessage.Timer, 2, 'STOP'));
		this.sendAll(buildMessage(GameMessage.Out, index));
		// Wait for the client deletion animation before enabling another selection.
		this.scheduleMain(1, () => this.askToDeleteFinalTheme());
	}

	/** Plays the final question: every player stakes and answers. */
	private startFinalQuestion(): void {
		const { session } = this;

		const themeIndex = [...this.finalThemeRemaining][0] ?? -1;

		if (themeIndex < 0) {
			this.endGame();
			return;
		}

		const questionIndex = session.themes[themeIndex].prices.findIndex(price => price >= 0);

		session.themeIndex = themeIndex;
		session.questionIndex = questionIndex;
		session.currentPrice = session.themes[themeIndex].prices[questionIndex];
		session.isQuestionPlaying = true;
		session.isQuestionAnswerShown = false;
		this.answeredPlayers.clear();
		this.finalParticipants.clear();
		for (const [index, player] of session.players.entries()) {
			player.answer = '';
			player.stake = 0;
			player.state = 'None';
			if (this.isActiveSeat(player) && Number.isSafeInteger(player.sum) && player.sum > 0) {
				this.finalParticipants.set(index, { name: player.name, sum: player.sum, stake: null, answer: null, draft: '' });
			}
		}
		if (this.finalParticipants.size === 0) {
			this.endGame();
			return;
		}
		this.finalStage = 'stake';

		const question = session.currentQuestion;

		if (!question) {
			this.endGame();
			return;
		}

		this.atoms = buildContentAtoms(question, this.options.readingSpeed, item => this.resolveMedia(item));
		this.answerOptions = buildAnswerOptions(question, item => this.resolveMedia(item));

		this.sendAll(buildMessage(GameMessage.Question, session.currentPrice));
		this.sendQuestionAnswers(session.showman.name);
		this.sendAll(buildMessage(GameMessage.QuestionCaption, session.themes[themeIndex].name));
		this.sendAll(buildMessage(GameMessage.QType, question.type || 'simple', 'True', 'False'));

		// All stakes remain secret until the final answer is revealed.
		this.finalParticipants.forEach((participant, index) => {
			const player = session.players[index];
			if (player.isHuman && player.isConnected) {
				this.sendFinalStakePrompt(participant);
			} else if (player.isBot) {
				participant.stake = participant.sum;
				this.sendAll(buildMessage(GameMessage.PersonFinalStake, index));
			}
		});

		this.sendAll(buildMessage(GameMessage.Timer, 2, 'GO', this.getTimeSettings().timeForMakingStake * 10, -2));
		this.scheduleMain(this.getTimeSettings().timeForMakingStake, () => this.askFinalAnswers());
	}

	private sendFinalStakePrompt(participant: FinalParticipant): void {
		this.sendTo(participant.name, buildMessage(GameMessage.AskStake, 'Stake,AllIn', 1, participant.sum, 1, 'FinalStake'));
	}

	private handlePass(sender: string): void {
		const { session } = this;
		const index = session.getPlayerIndex(sender);

		if (index < 0 || session.phase !== GamePhase.Round || this.answersToValidate.has(index)) {
			return;
		}

		this.sendAll(buildMessage(GameMessage.Pass, index));
		session.players[index].stake = 0;

		// A pass during a question means that the player refuses to answer it: once everybody
		// has passed, the question is over and the right answer is shown
		if (!session.isQuestionPlaying || session.isQuestionAnswerShown) {
			return;
		}

		session.players[index].state = 'Pass';
		this.pendingPressers = this.pendingPressers.filter(value => value !== index);

		if (this.answersToValidate.size > 0 || !this.areOnlyPassedPlayersLeft()) {
			return;
		}

		this.sendAll(buildMessage(GameMessage.Timer, 1, 'STOP'));
		this.sendAll(buildMessage(GameMessage.EndTry, 'A'));
		this.finishQuestionWithoutAnswer();
	}

	/** Indexes of the players that still could press the button and have not answered yet. */
	private collectPressers(): number[] {
		return this.session.players
			.map((player, index) => ({ player, index }))
			.filter(({ player, index }) => this.isActiveSeat(player) && player.state !== 'Pass' && !this.answeredPlayers.has(index))
			.map(({ index }) => index);
	}

	/**
	 * True when the seat could act right now: it is taken either by a bot or by a live connected player.
	 * The seats reserved in the game settings and the seats of the players that have left are ignored.
	 */
	private isActiveSeat(player: GamePerson | undefined): boolean {
		if (!player || player.name.trim().length === 0) {
			return false;
		}

		return player.isBot || (player.isHuman && player.isConnected);
	}

	/** True when every player that still could answer has passed this question. */
	private areOnlyPassedPlayersLeft(): boolean {
		const active = this.session.players
			.map((player, index) => ({ player, index }))
			.filter(({ player, index }) => this.isActiveSeat(player) && !this.answeredPlayers.has(index));

		return active.length === 0 || active.every(({ player }) => player.state === 'Pass');
	}

	private handleStake(sender: string, mode: string, value: number): void {
		if (this.isPaused || this.session.phase !== GamePhase.Final || this.finalStage !== 'stake') {
			return;
		}

		const index = this.session.getPlayerIndex(sender);
		const participant = this.finalParticipants.get(index);
		if (!participant || participant.name !== sender || participant.stake !== null) {
			return;
		}

		const stake = mode === 'AllIn' ? participant.sum : value;
		if ((mode !== 'Stake' && mode !== 'AllIn') || !Number.isSafeInteger(stake) || stake < 1 || stake > participant.sum) {
			return;
		}

		participant.stake = stake;
		this.session.players[index].stake = stake;
		this.sendAll(buildMessage(GameMessage.PersonFinalStake, index));
	}

	/** Asks all players to give their final answers. */
	private askFinalAnswers(): void {
		const { session } = this;

		if (session.phase !== GamePhase.Final || !session.isQuestionPlaying || this.finalStage !== 'stake') {
			return;
		}

		this.finalParticipants.forEach((participant, index) => {
			if (participant.stake === null) {
				participant.stake = 1;
				if (session.players[index]?.name === participant.name) {
					session.players[index].stake = 1;
				}
				this.sendAll(buildMessage(GameMessage.PersonFinalStake, index));
			}
		});
		this.finalStage = 'content';
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
			this.scheduleMain(Math.max(atom.duration / 10, 0.2), () => this.showFinalContent());
			return;
		}

		this.sendAll([GameMessage.Content2, 'screen', 0, '', atom.type, '',
			atom.type === 'text' ? escapeNewLines(atom.value) : atom.value].join('\n'));
		this.scheduleMain(Math.max(atom.duration / 10, 0.2), () => this.showFinalContent());
	}

	private askAllAnswers(): void {
		const { session } = this;
		if (session.phase !== GamePhase.Final || this.finalStage !== 'content') {
			return;
		}
		this.finalStage = 'answer';
		const answerTime = this.getTimeSettings().timeForFinalThinking;
		this.sendAll(buildMessage(GameMessage.FinalThink, answerTime));

		this.finalParticipants.forEach((participant, index) => {
			const player = session.players[index];
			if (player?.name !== participant.name) {
				return;
			}
			if (player.isHuman && player.isConnected) {
				this.sendTo(participant.name, buildMessage(GameMessage.Answer, 'text'));
			} else if (player.isBot) {
				this.schedule(1 + Math.random() * 2, () => {
					if (this.finalStage === 'answer' && participant.answer === null) {
						participant.answer = this.shouldBotAnswerRight() ? this.getBotAnswer(index) : '';
					}
				});
			}
		});

		this.sendAll(buildMessage(GameMessage.Timer, 2, 'GO', answerTime * 10, -2));
		this.scheduleMain(answerTime, () => this.finishFinalQuestion());
	}

	private finishFinalQuestion(): void {
		const { session } = this;
		if (session.phase !== GamePhase.Final || !session.isQuestionPlaying || this.finalStage !== 'answer') {
			return;
		}

		this.finalStage = 'reveal';
		session.isQuestionPlaying = false;
		this.cancelPending();
		this.sendAll(buildMessage(GameMessage.Timer, 2, 'STOP'));
		const answers = session.players.map((_player, index) => {
			const participant = this.finalParticipants.get(index);
			return escapeNewLines(participant ? participant.answer ?? participant.draft : '');
		});
		this.sendAll(buildMessage(GameMessage.Answers, ...answers));
		this.showRightAnswer();

		this.finalParticipants.forEach((participant, index) => {
			const answer = participant.answer ?? participant.draft;
			const stake = participant.stake ?? 1;
			const isRight = answer.trim().length > 0 && this.isAnswerRight(answer);
			const newSum = participant.sum + (isRight ? stake : -stake);
			const player = session.players[index];
			if (player?.name === participant.name) {
				player.sum = newSum;
				player.answer = answer;
				player.stake = stake;
				player.state = isRight ? 'Right' : 'Wrong';
			} else {
				// A disconnected participant can recover their updated score, never the new occupant's.
				const saved = this.leftSeats.get(participant.name);
				if (saved?.role === PersonRole.Player && saved.index === index) {
					saved.sum = newSum;
				}
			}
			this.sendAll(buildMessage(GameMessage.PersonStake, index, 1, stake));
			this.sendAll(buildMessage(GameMessage.PersonFinalAnswer, index));
			this.sendAll(buildMessage(GameMessage.Person, isRight ? '+' : '-', index, stake));
		});

		this.sendSums();
		this.playAnswerContent(() => this.endGame());
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

	/** Apply edits by seat identity, not by indices that earlier edits may have changed. */
	private applyPendingSeatEdits(): void {
		const pending = this.pendingSeatEdits.splice(0);
		for (const edit of pending) {
			const index = this.session.players.indexOf(edit.target);
			if (edit.target !== this.session.showman && index < 0) continue;
			const args = [...edit.args];
			if (args[1] === 'DELETETABLE') args[2] = String(index);
			else if (args[2] === 'player') args[3] = String(index);
			this.handleConfig(edit.person, args, true);
		}
	}

	/** A displaced connected human stays in the room as a viewer. */
	private moveSeatOccupantToViewers(target: GamePerson): void {
		if (target.isHuman && target.isConnected && !isEmptySlotName(target.name)) {
			this.session.viewers.push({ ...target, role: PersonRole.Viewer, sum: 0, stake: 0, answer: '' });
		}
	}

	/** Handles table configuration commands (`CONFIG`). */
	private handleConfig(person: GamePerson, args: string[], applyingPending = false): void {
		if (!applyingPending && !this.canManage(person)) return;
		const command = args[1];
		// Final-round decisions retain player indices until the end of the game.
		if (this.session.phase === GamePhase.Final) return;
		if (!applyingPending && command !== 'ADDTABLE'
			&& this.session.phase === GamePhase.Round && (this.session.isQuestionPlaying || this.closingQuestion)) {
			const index = Number(command === 'DELETETABLE' ? args[2] : args[3]);
			const target = command === 'DELETETABLE' || args[2] === 'player'
				? this.session.players[index] : this.session.showman;
			if (target && ['DELETETABLE', 'FREE', 'CHANGETYPE', 'SET'].includes(command)) {
				this.pendingSeatEdits.push({ person, args: [...args], target });
			}
			return;
		}

		switch (command) {
			case 'ADDTABLE': {
				if (this.session.players.length >= MAX_PLAYER_COUNT) return;

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
				if (this.session.phase === GamePhase.Before) {
					this.sendInfo();
				} else {
					this.sendAll(buildMessage(
						GameMessage.Config, 'CHANGETYPE', 'player', index, '-', botName,
						this.session.players[index].isMale ? '+' : '-',
					));
				}
				this.sendAll(buildMessage(GameMessage.PlayerCount, this.session.players.length));
				this.notifyChanged();
				break;
			}

			case 'DELETETABLE': {
				const index = parseInt(args[2], 10);

				if (index >= 0 && index < this.session.players.length && this.session.players.length > 1) {
					this.moveSeatOccupantToViewers(this.session.players[index]);
					this.session.players.splice(index, 1);
					if (this.session.chooserIndex === index) this.session.chooserIndex = -1;
					else if (this.session.chooserIndex > index) this.session.chooserIndex -= 1;
					for (const [name, seat] of this.leftSeats) {
						if (seat.role !== PersonRole.Player) continue;
						if (seat.index === index) this.leftSeats.delete(name);
						else if (seat.index > index) seat.index -= 1;
					}
					this.sendAll(buildMessage(GameMessage.Config, 'DELETETABLE', index));
					if (this.session.phase === GamePhase.Before) this.sendInfo();
					this.sendAll(buildMessage(GameMessage.PlayerCount, this.session.players.length));
					this.sendSums();
					this.updateManagerName();
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

				this.moveSeatOccupantToViewers(target);
				target.name = GameSession.EMPTY_NAME;
				target.isHuman = false;
				target.isBot = false;
				target.isConnected = false;
				target.isReady = false;

				this.sendAll(buildMessage(GameMessage.Config, 'FREE', isPlayer ? 'player' : 'showman', isPlayer ? index : ''));
				if (this.session.phase === GamePhase.Before) this.sendInfo();
				this.updateManagerName();
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

				this.moveSeatOccupantToViewers(target);
				const isHuman = args[4] === '+' || (args[4] === undefined && !target.isHuman);
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

				if (this.session.phase === GamePhase.Before) this.sendInfo();
				this.updateManagerName();
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

				this.moveSeatOccupantToViewers(target);
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

				if (this.session.phase === GamePhase.Before) this.sendInfo();
				this.updateManagerName();
				this.notifyChanged();
				break;
			}

			default:
				break;
		}

		if (!applyingPending && this.session.phase === GamePhase.Round && this.choosingQuestion
			&& !this.session.isQuestionPlaying && !this.closingQuestion && command !== 'ADDTABLE') {
			this.askToSelectQuestion();
		}

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
		if (!this.canManage(person) || this.isPaused) {
			return;
		}

		const direction = parseInt(args[1], 10);

		switch (direction) {
			case 1: {
				if (this.isPaused || !this.mainStep) break;
				const step = this.mainStep;
				this.cancelMainStep();
				if (this.waitingAnswerMedia?.step === step) this.waitingAnswerMedia = null;
				step.action();
				break;
			}

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
		this.choosingQuestion = false;
		this.choiceTurn += 1;
		this.applyPendingSeatEdits();

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
		this.choosingQuestion = false;
		this.choiceTurn += 1;
		if (session.phase === GamePhase.Round) this.applyPendingSeatEdits();

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
			this.roundTimeLeft = this.getRoundTimeLeft();
			const elapsed = this.visibleTimers.map(timer => {
				if (!timer) return 0;
				if (timer.running) timer.elapsed = Math.min(timer.maximum, timer.elapsed + (Date.now() - timer.startedAt) / 100);
				timer.running = false;
				return Math.floor(timer.elapsed);
			});
			this.sendAll(buildMessage(GameMessage.Pause, '+', ...elapsed));
			return;
		}

		for (const timer of this.visibleTimers) {
			if (timer) { timer.startedAt = Date.now(); timer.running = true; }
		}
		this.resumeSteps();
		this.sendAll(buildMessage(GameMessage.Pause, '-', 0, 0, 0));
		const waiting = this.waitingAnswerMedia;
		if (waiting?.completedWhilePaused) {
			this.waitingAnswerMedia = null;
			this.cancelMainStep();
			waiting.advance();
		}
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

		// The same message the real server sends: clients update their settings from it.
		// The client knows the blocking button time under the `ButtonBlocking` name, so it is sent the way it expects
		this.sendAll(buildMessage(GameMessage.Options2, person.name, this.clientOptionName(name), value));
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
			case 'UseAppellations':
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

	/** Name of the option used by the clients (the client name differs for some options). */
	private clientOptionName(name: string): string {
		switch (name) {
			case 'TimeForBlockingButton':
				return 'ButtonBlocking';

			case 'PartialImageTime':
				return 'PartialImage';

			case 'UseApellations':
			case 'UseAppellations':
				return 'UseAppellations';

			default:
				return name;
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
			['UseAppellations', String(options.useApellations)],
			['DisplayAnswerOptionsLabels', String(options.displayAnswerOptionsLabels)],
			['ReadingSpeed', String(options.readingSpeed)],
			['PartialImage', String(options.partialImageTime)],
			['ButtonBlocking', String(this.getTimeSettings().timeForBlockingButton)],
		];

		const text = buildMessage(GameMessage.Options2, '', ...pairs.flat());

		if (personName) {
			this.sendTo(personName, text);
		} else {
			this.sendAll(text);
		}
	}

	private handleValidation(person: GamePerson, args: string[]): void {
		// The showman of an oral game marks the answer of a player as right or wrong.
		// The client sends the answer text (`VALIDATE\n<answer>\n<+|->\n<factor>`),
		// the answerer could be sent by its index too (that is what `ASK_VALIDATE` gives)
		if (!this.canManage(person) || this.answersToValidate.size === 0) {
			return;
		}

		if (!this.session.isQuestionPlaying || this.session.isQuestionAnswerShown) {
			return;
		}

		const subject = args[1] ?? '';
		const sign = args[2] === '+' || args[2] === '-' ? args[2] : '+';

		// The answer text is matched first: an answer could be a number too, so an index is used only as a fallback
		const answeredIndex = this.findAnswererByAnswer(subject);
		const index = answeredIndex >= 0 ? answeredIndex : this.findAnswererByIndex(subject);

		if (index < 0 || !this.answersToValidate.has(index)) {
			return;
		}

		const answer = answeredIndex >= 0 ? subject : this.session.players[index].answer;

		this.validateAnswer(index, answer, sign === '+');
	}

	/** Finds the player by its index in the request of the showman. */
	private findAnswererByIndex(value: string): number {
		const index = parseInt(value, 10);

		if (!/^\d+$/.test(value.trim()) || !this.session.players[index]) {
			return -1;
		}

		return index;
	}

	/** Finds the player that has given the answer (used by the showman validation). */
	private findAnswererByAnswer(answer: string): number {
		const normalized = this.normalizeAnswer(answer);

		return this.session.players.findIndex((player, index) => this.answersToValidate.has(index)
			&& this.normalizeAnswer(player.answer) === normalized
			&& (player.isHuman || player.isBot)
			&& player.name.trim().length > 0);
	}

	private handlePreloadProgress(sender: string, progress: number): void {
		if (!Number.isFinite(progress)) {
			return;
		}

		this.sendAll(buildMessage(GameMessage.MediaPreloadProgress, sender, Math.max(0, Math.min(100, progress))));
	}

	/** Called when a client reports that a media atom has finished playing. */
	private handleAtomCompleted(sender: string, type: string, value: string): void {
		const waiting = this.waitingAnswerMedia;
		if (!waiting || type !== waiting.atom.type
			|| value !== this.resolveClientMediaUrls(sender, waiting.atom.value)) return;
		if (this.isPaused) {
			waiting.completedWhilePaused = true;
			return;
		}
		this.waitingAnswerMedia = null;
		if (this.mainStep === waiting.step) this.cancelMainStep();
		else {
			if (waiting.step.timeout) clearTimeout(waiting.step.timeout);
			this.pendingSteps = this.pendingSteps.filter(step => step !== waiting.step);
		}
		waiting.advance();
	}

	private getTimeSettings() {
		return {
			timeForChoosingQuestion: 60,
			timeForChoosingFinalTheme: 30,
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

	/** Applies the client rules supplied when the room is created. */
	setInitialOptions(settings: Record<string, unknown> | undefined): void {
		if (!settings) return;
		const names: Record<string, string> = {
			oral: 'Oral', managed: 'Managed', falseStart: 'FalseStart', partialText: 'PartialText',
			partialImages: 'PartialImages', useApellations: 'UseApellations',
			displayAnswerOptionsLabels: 'DisplayAnswerOptionsLabels', readingSpeed: 'ReadingSpeed',
		};
		for (const [key, name] of Object.entries(names)) {
			const value = settings[key];
			if (typeof value === 'boolean' || typeof value === 'number') this.applyOption(name, String(value));
		}
		const times = settings.timeSettings as Record<string, unknown> | undefined;
		if (typeof times?.partialImageTime === 'number') this.applyOption('PartialImageTime', String(times.partialImageTime));
	}

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
		return `${SERVER_HOST_PLACEHOLDER}${getMediaUrl(this.session.packageInfo, mediaPath)}`;
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
