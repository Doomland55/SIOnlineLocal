'use strict';

/**
 * Local SIGame game engine.
 *
 * The web client is a thin terminal: it renders whatever the server sends as
 * "\n"-separated text messages and sends player actions back. This module is
 * the authoritative game state holder for one game: it owns the package
 * progress, timers, player scores and the question flow, and it broadcasts
 * every state transition to all connected clients.
 *
 * Synchronization guarantees implemented here:
 *  - timers are server-side only; clients render a countdown from the
 *    remaining time they receive, and a joining client gets the remaining
 *    time instead of the full duration;
 *  - question media is not started until every connected client reported
 *    MEDIALOADED (with a safety timeout), and round media is preloaded in
 *    advance through ROUNDCONTENT;
 *  - a client that joins or reconnects in the middle of a question receives a
 *    full snapshot plus a replay of the current question messages.
 */

const { QuestionTypes, getTextContent } = require('./package');
const { computeContentHash, findMediaKey } = require('./content');

const ROLE_SHOWMAN = 'showman';
const ROLE_PLAYER = 'player';
const ROLE_VIEWER = 'viewer';

const SERVER_ROLE = {
	showman: 'Showman',
	player: 'Player',
	viewer: 'Viewer',
};

/** Name placeholder used by the client for a free or computer-controlled seat. */
const ANY_NAME = ' ';

/** Sender of system messages: must match DefaultEndpoints.GameClient on the client. */
const GAME_CLIENT = '@';

const STAGE = {
	Before: 'Before',
	Begin: 'Begin',
	Round: 'Round',
	After: 'After',
};

const PLAYER_STATE = {
	None: 'None',
	Answering: 'Answering',
	Lost: 'Lost',
	Right: 'Right',
	Wrong: 'Wrong',
	HasAnswered: 'HasAnswered',
	Pass: 'Pass',
};

const QUESTION_SPLASH_DELAY = 1200;
const MEDIA_LOAD_TIMEOUT = 25000;
const PRESS_ACCEPT_WINDOW = 120;
const NEXT_QUESTION_DELAY = 1200;

const DEFAULT_TIME_SETTINGS = {
	timeForChoosingQuestion: 30,
	timeForThinkingOnQuestion: 5,
	timeForPrintingAnswer: 25,
	timeForGivingACat: 30,
	timeForMakingStake: 30,
	timeForThinkingOnSpecial: 25,
	timeOfRound: 3600,
	timeForChoosingFinalTheme: 30,
	timeForFinalThinking: 45,
	timeForShowmanDecisions: 30,
	timeForRightAnswer: 2,
	timeForBlockingButton: 3,
	partialImageTime: 3,
	imageTime: 5,
	buttonsAccepting: 300,
};

function inlineText(value) {
	return String(value).replace(/\r\n|\r|\n/g, ' ');
}

function escapeText(value) {
	return String(value).replace(/\\/g, '\\\\').replace(/\r\n/g, '\n').replace(/\n/g, '\\n');
}

function normalizeAnswer(value) {
	return String(value || '')
		.toLowerCase()
		.replace(/ё/g, 'е')
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

class Game {
	/**
	 * @param {object} options
	 * @param {number} options.id Game identifier.
	 * @param {object} options.settings GameSettings received from the client.
	 * @param {object} options.parsedPackage Parsed .siq package.
	 * @param {object} options.packageInfo PackageInfo received from the client.
	 * @param {(clientId: string, text: string) => void} options.send Sends a system message to a client.
	 * @param {() => string} options.baseUrl Public base url of this server.
	 * @param {object} options.contentService Content service instance (media URIs).
	 * @param {(game: Game) => void} [options.onChanged] Called when lobby info changes.
	 * @param {Function} [options.log]
	 */
	constructor(options) {
		this.id = options.id;
		this.settings = options.settings || {};
		this.parsedPackage = options.parsedPackage;
		this.packageInfo = options.packageInfo;
		this.send = options.send;
		this.baseUrl = options.baseUrl;
		this.contentService = options.contentService;
		this.onChanged = options.onChanged || (() => {});
		this.log = options.log || (() => {});

		this.timeSettings = {
			...DEFAULT_TIME_SETTINGS,
			...(this.settings.appSettings && this.settings.appSettings.timeSettings),
		};

		this.name = this.settings.networkGameName || 'Локальная игра';
		this.password = this.settings.networkGamePassword || '';
		this.owner = this.settings.humanPlayerName || '';
		this.isPrivate = !!this.settings.isPrivate;
		this.pin = createPin();
		this.createdAt = new Date();
		this.realStartTime = null;

		this.joinMode = 0; // 0 = any role, 1 = viewer only, 2 = forbidden

		// The creator of the game is the host, exactly like in the reference SI
		// server. The host rights (starting the game, moving to the next round,
		// editing the scores) are decided by the client with the HOSTNAME
		// message, so it must never stay null.
		this.hostName = this.owner || null;

		this.showman = this.createShowmanSeat();
		this.players = this.createPlayerSeats();
		this.viewers = [];

		/** @type {Map<string, {clientId: string, name: string, role: string, index: number}>} */
		this.clients = new Map();

		this.stage = STAGE.Before;
		this.stageName = this.name;
		this.stageIndex = -1;
		this.isStarted = false;

		this.roundIndex = -1;
		this.round = null;
		this.themes = [];
		this.table = [];
		this.playedQuestions = new Set();

		this.phase = 'lobby';
		this.chooserIndex = -1;
		this.currentQuestion = null;
		this.questionStartedAt = 0;

		/** Messages of the current question, replayed to clients that join mid-question. */
		this.questionLog = [];

		this.timers = [null, null, null];
		this.pausedTimers = [];
		this.isPaused = false;

		this.pressState = null;
		this.mediaWait = null;
		this.pendingStakes = null;
		this.pendingAnswers = null;
		this.pendingValidation = null;

		this.questionCounters = {
			total: this.parsedPackage ? this.parsedPackage.totalQuestions : 0,
			played: 0,
		};

		this.startDelayTimer = null;
		this.disposed = false;
	}

	// ---------------------------------------------------------------- seats

	createShowmanSeat() {
		const showmanSettings = this.settings.showman || { name: ANY_NAME, isHuman: true };

		return {
			role: ROLE_SHOWMAN,
			index: -1,
			name: showmanSettings.name || ANY_NAME,
			isHuman: !!showmanSettings.isHuman,
			isMale: showmanSettings.isMale !== false,
			clientId: null,
			isReady: false,
			sum: 0,
			state: PLAYER_STATE.None,
			rightCount: 0,
			wrongCount: 0,
			rightSum: 0,
			wrongSum: 0,
		};
	}

	createPlayerSeats() {
		const seats = Array.isArray(this.settings.players) ? this.settings.players : [];

		return seats.map((seat, index) => ({
			...this.createPlayerSeat(index, seat.isMale !== false),
			name: seat.name || ANY_NAME,
			isHuman: seat.isHuman !== false,
		}));
	}

	/** All seats that can host a human. */
	allSeats() {
		return [this.showman, ...this.players, ...this.viewers];
	}

	findSeatByName(name) {
		return this.allSeats().find(seat => seat.name === name) || null;
	}

	// ------------------------------------------------------------ membership

	/**
	 * Adds a client to the game.
	 * @returns {string} JoinGame2Result value.
	 */
	addClient(client, request) {
		const name = String(request.UserName || '').trim() || 'Игрок';
		const role = request.Role || 'Player';
		const isMale = request.Sex !== 'Female';

		if (this.joinMode === 2 && role !== 'Viewer') {
			return 'Forbidden';
		}

		if (this.password && request.Password !== this.password) {
			return 'WrongPassword';
		}

		// Reconnect: the same person was here before, take their seat back.
		const existingSeat = this.allSeats().find(seat => seat.name === name && seat.clientId === null);

		if (existingSeat) {
			existingSeat.clientId = client.id;
			existingSeat.isHuman = true;
			this.clients.set(client.id, { clientId: client.id, name, role: existingSeat.role, index: existingSeat.index });
			this.announceConnected(existingSeat);
			this.sendSnapshot(client.id);
			this.onChanged(this);
			return 'Success';
		}

		if (this.findSeatByName(name)) {
			return 'NameIsOccupied';
		}

		let seat = null;

		if (role === 'Showman' && this.showman.clientId === null) {
			seat = this.showman;
		} else if (role !== 'Viewer') {
			seat = this.players.find(playerSeat => playerSeat.clientId === null && playerSeat.isHuman && playerSeat.name === ANY_NAME);

			if (!seat) {
				seat = this.players.find(playerSeat => playerSeat.clientId === null && !playerSeat.isHuman);
			}
		}

		// The game can grow while it is still in the lobby: a LAN party often
		// starts with fewer configured seats than there are players.
		if (!seat && role === 'Player' && !this.isStarted && this.joinMode !== 1 && this.players.length < 12) {
			seat = this.createPlayerSeat(this.players.length, isMale);
			this.players.push(seat);
		}

		// No free seat: join as a viewer instead of failing. This keeps late
		// arrivals in the room, where they at least see the game and the chat.
		if (!seat) {
			seat = {
				role: ROLE_VIEWER,
				index: this.viewers.length,
				name,
				isHuman: true,
				isMale,
				clientId: client.id,
				isReady: false,
				sum: 0,
				state: PLAYER_STATE.None,
			};

			this.viewers.push(seat);
			this.clients.set(client.id, { clientId: client.id, name, role: ROLE_VIEWER, index: seat.index });
			this.announceConnected(seat);
			this.sendSnapshot(client.id);
			this.onChanged(this);
			return 'Success';
		}

		const wasFreePlayerSeat = seat.role === ROLE_PLAYER && seat.clientId === null && seat.name === ANY_NAME;

		// Take the seat: replace a placeholder or a computer-controlled player.
		seat.clientId = client.id;
		seat.isHuman = true;
		seat.isMale = isMale;
		seat.name = name;

		this.clients.set(client.id, { clientId: client.id, name, role: seat.role, index: seat.index });

		// A new player row must be announced to everyone, otherwise existing
		// clients do not know about the extra player index.
		if (seat.role !== ROLE_VIEWER && wasFreePlayerSeat) {
			this.broadcastInfoAndSums();
		}

		this.announceConnected(seat);
		this.sendSnapshot(client.id);
		this.onChanged(this);
		return 'Success';
	}

	createPlayerSeat(index, isMale) {
		return {
			role: ROLE_PLAYER,
			index,
			name: ANY_NAME,
			isHuman: true,
			isMale,
			clientId: null,
			isReady: false,
			sum: 0,
			state: PLAYER_STATE.None,
			answer: '',
			rightCount: 0,
			wrongCount: 0,
			rightSum: 0,
			wrongSum: 0,
			pressedAt: null,
			answered: false,
			stake: 0,
			stakeType: 0,
		};
	}

	/** Sends the current scores of all players. */
	broadcastSums() {
		this.broadcastLines(['SUMS', ...this.players.map(player => String(player.sum))]);
	}

	/** Re-sends the person list and scores to everybody (used when a seat appears). */
	broadcastInfoAndSums() {
		this.broadcast(this.infoLines().join('\n'));
		this.broadcastSums();
	}

	removeClient(clientId) {
		const client = this.clients.get(clientId);
		if (!client) {
			return;
		}

		this.clients.delete(clientId);
		const seat = this.findSeatByName(client.name);

		if (seat) {
			seat.clientId = null;
			seat.isReady = false;
			this.broadcast(`DISCONNECTED\n${seat.name}`);
		}

		// Drop viewers that left instead of keeping dead rows in the room.
		if (seat && seat.role === ROLE_VIEWER) {
			this.viewers = this.viewers.filter(viewer => viewer !== seat);
			this.viewers.forEach((viewer, index) => {
				viewer.index = index;
			});
		}

		if (this.pendingStakes) {
			this.pendingStakes.pending.delete(clientId);
			if (this.pendingStakes.pending.size === 0) {
				this.completeStakes();
			}
		}

		if (this.pendingAnswers) {
			this.pendingAnswers.pending.delete(clientId);
			if (this.pendingAnswers.pending.size === 0) {
				this.clearTimer(2);
				this.collectForAllAnswers();
			}
		}

		// Do not stall the game when the answering player goes away.
		if (this.currentQuestion && this.phase === 'answering' && this.currentQuestion.answererIndex === client.index) {
			this.delay(500, () => this.onAnswerTimeout(client.index));
		}

		// Move the question choice to another player if the chooser is gone.
		if (this.phase === 'choosing' && this.chooserIndex === client.index) {
			const nextChooser = this.players.findIndex(player => player.clientId !== null);
			if (nextChooser >= 0) {
				this.delay(500, () => {
					if (this.phase === 'choosing') {
						this.chooseNextChooser(nextChooser);
					}
				});
			}
		}

		if (this.pressState) {
			this.pressState.pending.delete(clientId);
		}

		if (this.mediaWait) {
			this.mediaWait.pending.delete(clientId);
			if (this.mediaWait.pending.size === 0) {
				this.finishMediaWait();
			}
		}

		this.onChanged(this);
	}

	announceConnected(seat) {
		this.broadcast(`CONNECTED\n${seat.role}\n${seat.index}\n${seat.name}\n${seat.isMale ? 'm' : 'f'}`);
	}

	connectedSeats() {
		return this.allSeats().filter(seat => seat.clientId !== null);
	}

	connectedClients() {
		return [...this.clients.values()];
	}

	// -------------------------------------------------------------- sending

	/**
	 * Sends a system message (one or more "\n"-joined arguments) to a client.
	 * Several messages can be passed as arrays, they are joined into one payload.
	 */
	sendMessage(clientId, ...lines) {
		if (!clientId) {
			return;
		}

		this.send(clientId, lines.map(line => (Array.isArray(line) ? line.join('\n') : line)).join('\n'));
	}

	broadcast(text, options = {}) {
		for (const client of this.clients.values()) {
			this.send(client.clientId, text);
		}

		if (!options.noLog && this.phase !== 'lobby' && this.currentQuestion) {
			this.questionLog.push(text);
		}
	}

	broadcastLines(...lines) {
		this.broadcast(lines.map(line => (Array.isArray(line) ? line.join('\n') : line)).join('\n'));
	}

	// ------------------------------------------------------------- snapshot

	infoLines() {
		const lines = ['INFO2', String(this.players.length)];

		for (const seat of [this.showman, ...this.players, ...this.viewers]) {
			lines.push(
				seat.name,
				seat.isMale ? '+' : '-',
				seat.clientId ? '+' : '-',
				seat.isHuman ? '+' : '-',
				seat.isReady ? '+' : '-'
			);
		}

		return lines;
	}

	/** Sends the complete current state to one client (join / reconnect / INFO request). */
	sendSnapshot(clientId) {
		const lines = [];

		lines.push(this.infoLines());
		lines.push(['SETJOINMODE', String(this.joinMode), '+']);
		lines.push(['HOSTNAME', this.hostName || '']);

		if (this.parsedPackage) {
			const logoKey = this.parsedPackage.logo
				? findMediaKey(this.parsedPackage.files, this.parsedPackage.logo)
				: null;
			const logoUri = logoKey
				? this.contentService.getMediaUri(this.parsedPackage.hash, logoKey)
				: '';

			lines.push(['PACKAGE', this.parsedPackage.name, '-', logoUri]);
			lines.push(['GAMEMETADATA', this.name, this.parsedPackage.name, this.parsedPackage.contactUri || '']);
			lines.push(['STAGE', this.stage, this.stageName, String(this.stageIndex), this.getRoundRules()]);
			lines.push(['ROUNDSNAMES', ...this.parsedPackage.rounds.map(round => round.name)]);
		}

		lines.push(['SUMS', ...this.players.map(player => String(player.sum))]);

		const activeStates = this.players
			.map((player, index) => ({ index, state: player.state }))
			.filter(item => item.state !== PLAYER_STATE.None);

		for (const state of new Set(activeStates.map(item => item.state))) {
			lines.push([
				'PLAYERSTATE',
				state,
				...activeStates.filter(item => item.state === state).map(item => String(item.index)),
			]);
		}

		if (this.stage === STAGE.Round && this.round) {
			lines.push(['ROUND_THEMES2', 'AllTogether', ...this.themes.map(theme => theme.name)]);
			lines.push(this.tableLines());

			if (this.chooserIndex >= 0) {
				lines.push(['SETCHOOSER', String(this.chooserIndex), this.phase === 'choosing' ? '+' : '-', '-']);
			}

			// Replay of the current question, without stale timers and media reports.
			for (const text of this.questionLog) {
				const firstLine = text.substring(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));

				if (firstLine === 'TIMER' || firstLine === 'MEDIALOADED' || firstLine === 'MEDIA_PRELOAD_PROGRESS') {
					continue;
				}

				lines.push([text]);
			}

			// Fresh timers with the remaining time.
			for (let index = 0; index < this.timers.length; index++) {
				const timer = this.timers[index];
				if (timer) {
					lines.push(['TIMER', String(index), 'GO', String(this.remainingMs(index)), timer.personIndex === null ? undefined : String(timer.personIndex)]);
				}
			}

			// Personal decisions.
			lines.push(...this.getPersonalMessagesForClient(clientId));
		}

		for (const message of lines) {
			this.sendMessage(clientId, message);
		}
	}

	getPersonalMessagesForClient(clientId) {
		const client = this.clients.get(clientId);
		if (!client) {
			return [];
		}

		const messages = [];

		if (this.phase === 'choosing' && client.role === ROLE_PLAYER && client.index === this.chooserIndex) {
			messages.push('CHOOSE');
		}

		const current = this.currentQuestion;

		if (current && this.phase === 'answering' && current.answererIndex === client.index && client.role === ROLE_PLAYER) {
			messages.push(`ANSWER\n${current.answerType}`);
		}

		if (current && this.phase === 'answering' && client.role === ROLE_SHOWMAN && this.pendingValidation) {
			messages.push(`ASK_VALIDATE\n${this.pendingValidation.playerIndex}\n${escapeText(this.pendingValidation.answer)}\n-`);
		}

		if (this.pendingStakes && this.pendingStakes.pending.has(clientId)) {
			messages.push(this.buildAskStakeMessage());
		}

		return messages.filter(message => message && message.length > 0);
	}

	buildAskStakeMessage() {
		const stake = this.pendingStakes;
		return ['ASK_STAKE', stake.modes, String(stake.minimum), String(stake.maximum), String(stake.step), stake.reason].join('\n');
	}

	tableLines() {
		// TABLO2: theme prices separated by empty arguments.
		const args = ['TABLO2'];

		for (const theme of this.table) {
			args.push(...theme.prices.map(price => String(price)));
			args.push('');
		}

		return args;
	}

	getRoundRules() {
		return '';
	}

	remainingMs(timerIndex) {
		const timer = this.timers[timerIndex];
		if (!timer) {
			return 0;
		}

		return Math.max(0, timer.endsAt - Date.now());
	}

	// --------------------------------------------------------------- timers

	runTimer(timerIndex, durationMs, personIndex, onExpire) {
		this.clearTimer(timerIndex);

		if (this.isPaused || durationMs <= 0) {
			return;
		}

		const timer = {
			index: timerIndex,
			durationMs,
			endsAt: Date.now() + durationMs,
			personIndex: personIndex === undefined ? null : personIndex,
			onExpire,
			timeout: null,
		};

		timer.timeout = setTimeout(() => {
			this.timers[timerIndex] = null;
			try {
				if (onExpire) {
					onExpire();
				}
			} catch (error) {
				this.log(`Timer ${timerIndex} handler failed: ${error.stack || error}`);
			}
		}, durationMs);

		this.timers[timerIndex] = timer;

		const lines = ['TIMER', String(timerIndex), 'GO', String(durationMs)];
		if (timer.personIndex !== null) {
			lines.push(String(timer.personIndex));
		}

		this.broadcastLines(lines);
	}

	clearTimer(timerIndex) {
		const timer = this.timers[timerIndex];
		if (timer && timer.timeout) {
			clearTimeout(timer.timeout);
		}
		this.timers[timerIndex] = null;
	}

	stopTimer(timerIndex) {
		const wasRunning = !!this.timers[timerIndex];
		this.clearTimer(timerIndex);

		if (wasRunning) {
			this.broadcastLines(['TIMER', String(timerIndex), 'STOP']);
		}
	}

	stopAllTimers() {
		for (let index = 0; index < this.timers.length; index++) {
			this.stopTimer(index);
		}
	}

	pauseTimers() {
		if (this.isPaused) {
			return;
		}

		this.isPaused = true;
		this.pausedTimers = [];

		for (let index = 0; index < this.timers.length; index++) {
			const timer = this.timers[index];

			if (timer) {
				this.pausedTimers.push({
					index,
					remaining: this.remainingMs(index),
					personIndex: timer.personIndex,
					onExpire: timer.onExpire,
				});
				this.clearTimer(index);
			}
		}

		this.broadcastLines([
			'PAUSE',
			'+',
			String(this.pausedTimers[0] ? this.pausedTimers[0].remaining : 0),
			String(this.pausedTimers[1] ? this.pausedTimers[1].remaining : 0),
			String(this.pausedTimers[2] ? this.pausedTimers[2].remaining : 0),
		]);
	}

	resumeTimers() {
		if (!this.isPaused) {
			return;
		}

		this.isPaused = false;
		const timersToResume = this.pausedTimers;
		this.pausedTimers = [];

		this.broadcastLines([
			'PAUSE',
			'-',
			String(timersToResume[0] ? timersToResume[0].remaining : 0),
			String(timersToResume[1] ? timersToResume[1].remaining : 0),
			String(timersToResume[2] ? timersToResume[2].remaining : 0),
		]);

		for (const timer of timersToResume) {
			this.runTimer(timer.index, timer.remaining, timer.personIndex, timer.onExpire);
		}
	}

	// ----------------------------------------------------------- game start

	start() {
		if (this.phase !== 'lobby') {
			return;
		}

		if (!this.parsedPackage) {
			this.broadcastLines(['USER_ERROR', '0']);
			return;
		}

		this.isStarted = true;
		this.realStartTime = new Date();
		this.phase = 'starting';
		this.stageIndex = -1;

		this.broadcastLines(['STAGE', STAGE.Begin, this.parsedPackage.name, '0', '']);
		this.onChanged(this);

		this.delay(1500, () => this.beginRound(0));
	}

	beginRound(roundIndex) {
		const rounds = this.parsedPackage.rounds;

		if (roundIndex >= rounds.length) {
			this.finishGame();
			return;
		}

		this.roundIndex = roundIndex;
		this.round = rounds[roundIndex];
		/** @type {{name: string, prices: number[]}[]} */
		this.themes = this.round.themes;
		this.table = this.round.themes.map(theme => ({
			name: theme.name,
			prices: theme.questions.map(question => question.price),
		}));
		this.playedQuestions = new Set();
		this.chooserIndex = -1;
		this.currentQuestion = null;
		this.questionLog = [];
		this.phase = 'roundBegin';

		this.stage = STAGE.Round;
		this.stageName = this.round.name;
		this.stageIndex = roundIndex + 1;

		this.resetPlayerRoundState();

		this.broadcastLines(['STAGE', STAGE.Round, this.round.name, String(this.stageIndex), this.getRoundRules()]);

		if (this.round.type === 'final') {
			this.beginFinalRound();
			return;
		}

		this.broadcastLines(['ROUND_THEMES2', 'AllTogether', ...this.themes.map(theme => theme.name)]);
		this.broadcastLines(this.tableLines());
		this.broadcastRoundContent();

		const roundTime = Number(this.timeSettings.timeOfRound) || 0;
		if (roundTime > 0) {
			this.runTimer(0, roundTime * 1000, null, () => this.endRound('timeout'));
		}

		this.phase = 'choosing';
		this.chooseNextChooser(0, false);
		this.onChanged(this);
	}

	broadcastRoundContent() {
		const media = this.collectRoundMedia(this.round);
		if (media.length > 0) {
			this.broadcastLines(['ROUNDCONTENT', ...media], { noLog: true });
		}
	}

	collectRoundMedia(round) {
		const uris = new Set();
		const addContent = param => {
			if (!param || !param.items) {
				return;
			}

			for (const item of param.items) {
				const uri = this.resolveContentUrl(item);
				if (uri && (item.type === 'image' || item.type === 'audio' || item.type === 'video' || item.type === 'html')) {
					uris.add(uri);
				}
			}
		};

		for (const theme of round.themes) {
			for (const question of theme.questions) {
				addContent(question.params.question);
				addContent(question.params.answer);

				if (question.params.answerOptions) {
					for (const option of Object.values(question.params.answerOptions)) {
						addContent(option);
					}
				}
			}
		}

		return [...uris];
	}

	chooseNextChooser(preferredIndex, announce = true) {
		const candidates = this.players
			.map((player, index) => ({ player, index }))
			.filter(item => item.player.clientId !== null && item.player.isHuman);

		if (candidates.length === 0) {
			this.endRound('noPlayers');
			return;
		}

		let chooserIndex = preferredIndex;

		if (chooserIndex === null || chooserIndex === undefined || !this.players[chooserIndex] || !this.players[chooserIndex].clientId) {
			chooserIndex = candidates[0].index;
		}

		this.chooserIndex = chooserIndex;
		this.phase = 'choosing';

		this.broadcastLines([
			'SETCHOOSER',
			String(chooserIndex),
			'+',
			'-',
			announce ? 'ANNOUNCE' : '-',
		]);

		const chooser = this.players[chooserIndex];
		if (chooser && chooser.clientId) {
			this.sendMessage(chooser.clientId, 'CHOOSE');
		}
	}

	// -------------------------------------------------------------- questions

	/** Handles a CHOICE message from a player. */
	onChoice(clientId, themeIndex, questionIndex) {
		if (this.phase !== 'choosing') {
			return;
		}

		const client = this.clients.get(clientId);

		if (!client || client.role !== ROLE_PLAYER) {
			return;
		}

		// In a local game the chooser is trusted, but keep the state consistent:
		// if the chooser is unknown, accept the first choice.
		if (this.chooserIndex >= 0 && client.index !== this.chooserIndex) {
			return;
		}

		const theme = this.round && this.round.themes[themeIndex];
		const question = theme && theme.questions[questionIndex];

		if (!question) {
			return;
		}

		if (this.playedQuestions.has(`${themeIndex}:${questionIndex}`)) {
			return;
		}

		this.phase = 'questionSplash';
		this.currentQuestion = {
			themeIndex,
			questionIndex,
			theme,
			question,
			price: question.price,
			answererIndex: -1,
			answerType: '',
			isStake: question.type === QuestionTypes.Stake || question.type === QuestionTypes.StakeAll,
			isForAll: question.type === QuestionTypes.ForAll,
			isNoRisk: question.type === QuestionTypes.NoRisk,
			answeredPlayers: new Set(),
			presses: [],
			startedAt: Date.now(),
		};

		this.questionLog = [];
		this.playedQuestions.add(`${themeIndex}:${questionIndex}`);
		this.table[themeIndex].prices[questionIndex] = -1;
		this.questionCounters.played += 1;

		this.broadcastLines(['CHOICE', String(themeIndex), String(questionIndex), String(question.price)]);
		this.onChanged(this);

		this.delay(QUESTION_SPLASH_DELAY, () => this.showQuestionSplash());
	}

	showQuestionSplash() {
		const current = this.currentQuestion;
		if (!current) {
			return;
		}

		const themeInfo = current.theme.info || { authors: [], sources: [], comments: '' };

		this.broadcastLines([
			'THEME',
			current.theme.name,
			'-',
			escapeText(themeInfo.comments || ''),
			String(themeInfo.authors.length),
			...themeInfo.authors.map(author => inlineText(author)),
			String(themeInfo.sources.length),
			...themeInfo.sources.map(source => inlineText(source)),
		]);

		this.broadcastLines(['QUESTION', String(current.price)]);
		this.broadcastLines(['QTYPE', current.question.type || '', current.question.type === QuestionTypes.Default ? 'True' : 'False', current.isNoRisk ? 'True' : 'False']);

		if (current.isStake) {
			this.requestStakes('question', () => this.sendQuestionContent());
			return;
		}

		this.sendQuestionContent();
	}

	sendQuestionContent() {
		const current = this.currentQuestion;
		if (!current) {
			return;
		}

		const question = current.question;

		if (question.info && question.info.authors && question.info.authors.length > 0) {
			this.broadcastLines(['QUESTION_AUTHORS', ...question.info.authors.map(author => inlineText(author))]);
		}

		if (question.info && question.info.comments) {
			this.broadcastLines(['QUESTION_COMMENTS', escapeText(question.info.comments)]);
		}

		current.mediaSent = this.sendContentItems(question.params.question);
		current.answerType = question.params.answerType || '';

		this.phase = 'mediaLoading';
		this.waitForMedia(() => this.afterQuestionContent());
	}

	afterQuestionContent() {
		this.log(`Question content ready, phase=${this.phase}`);
		const current = this.currentQuestion;
		if (!current) {
			return;
		}

		if (current.isForAll) {
			this.startForAllAnswers();
			return;
		}

		if (current.isStake) {
			this.startStakeAnswer();
			return;
		}

		this.startPressPhase();
	}

	/**
	 * Sends CONTENT2 messages for a content param (question or answer).
	 * @returns {number} Number of media items (non-text) that were sent.
	 */
	sendContentItems(param) {
		if (!param || !param.items || param.items.length === 0) {
			return 0;
		}

		const byPlacement = new Map();
		let mediaCount = 0;

		for (const item of param.items) {
			const placement = item.placement || 'screen';
			const value = item.type === 'text' ? escapeText(item.value) : this.resolveContentUrl(item);

			if (!value) {
				continue;
			}

			if (item.type !== 'text') {
				mediaCount += 1;
			}

			if (!byPlacement.has(placement)) {
				byPlacement.set(placement, []);
			}

			byPlacement.get(placement).push(item.type, '', value);
		}

		// Screen content first so the table shows the question, then audio/voice.
		for (const placement of ['screen', 'replic', 'background']) {
			const items = byPlacement.get(placement);

			if (items && items.length > 0) {
				this.broadcastLines(['CONTENT2', placement, '0', '', ...items]);
				byPlacement.delete(placement);
			}
		}

		for (const [placement, items] of byPlacement) {
			this.broadcastLines(['CONTENT2', placement, '0', '', ...items]);
		}

		return mediaCount;
	}

	resolveContentUrl(item) {
		if (!item) {
			return '';
		}

		if (item.type === 'text') {
			return item.value;
		}

		if (!item.isRef) {
			// External absolute uri (http://..., https://...) or inline html markup.
			if (/^https?:\/\//i.test(item.value) || item.type === 'html' && item.value.trim().startsWith('<')) {
				return item.value;
			}
		}

		const fileName = String(item.value).replace(/^@/, '');
		const parsedPackage = this.parsedPackage;

		if (!parsedPackage) {
			return fileName;
		}

		const mediaKey = findMediaKey(parsedPackage.files, fileName);

		if (!mediaKey) {
			this.log(`Package ${parsedPackage.name} does not contain ${fileName}`);
			return '';
		}

		return this.contentService.getMediaUri(parsedPackage.hash, mediaKey);
	}

	// ------------------------------------------------------------ media wait

	/** Waits until every connected client has loaded the question media. */
	waitForMedia(onReady) {
		const current = this.currentQuestion;
		const hasMedia = current ? current.mediaSent > 0 : false;

		if (!hasMedia) {
			this.delay(300, onReady);
			return;
		}

		const pending = new Set(this.clients.keys());

		if (pending.size === 0) {
			this.delay(300, onReady);
			return;
		}

		const timeout = setTimeout(() => {
			if (this.mediaWait && this.mediaWait.onReady === onReady) {
				this.log('Media load timeout, continuing without all clients');
				this.finishMediaWait();
			}
		}, MEDIA_LOAD_TIMEOUT);

		this.mediaWait = { pending, onReady, timeout };
		this.phase = 'mediaLoading';
		this.log(`Waiting for media on ${pending.size} client(s)`);
	}

	onMediaLoaded(clientId) {
		const client = this.clients.get(clientId);

		if (client) {
			this.broadcast(`MEDIALOADED\n${client.name}`, { noLog: true });
		}

		if (!this.mediaWait) {
			return;
		}

		this.mediaWait.pending.delete(clientId);
		this.log(`Media loaded by ${client ? client.name : clientId}, ${this.mediaWait.pending.size} left`);

		if (this.mediaWait.pending.size === 0) {
			this.finishMediaWait();
		}
	}

	finishMediaWait() {
		const wait = this.mediaWait;
		if (!wait) {
			return;
		}

		this.mediaWait = null;
		clearTimeout(wait.timeout);
		this.log('Media wait finished');

		// Small delay so the last media frame is rendered before pressing starts.
		this.delay(300, wait.onReady);
	}

	// ------------------------------------------------------------ press phase

	startPressPhase() {
		const current = this.currentQuestion;
		if (!current) {
			return;
		}

		this.phase = 'press';
		current.presses = [];
		this.pressState = { pending: new Set(this.clients.keys()), windowOpen: true, timer: null };

		for (const player of this.players) {
			player.pressedAt = null;
		}

		this.broadcast(`PLAYERSTATE\n${PLAYER_STATE.None}\n${this.players.map((_, index) => index).join('\n')}`, { noLog: true });
		this.broadcastLines(['TRY']);
		this.log('Press phase started');

		const pressTime = Math.max(1, Number(this.timeSettings.timeForThinkingOnQuestion) || 5);
		this.runTimer(1, pressTime * 1000, null, () => this.endPressPhase(null));
	}

	onPress(clientId, deltaTime) {
		const current = this.currentQuestion;

		if (!current || this.phase !== 'press' || !this.pressState) {
			return;
		}

		const client = this.clients.get(clientId);

		if (!client || client.role !== ROLE_PLAYER) {
			return;
		}

		const player = this.players[client.index];

		if (!player || player.answered || player.hasPassed || player.pressedAt !== null) {
			return;
		}

		player.pressedAt = Number(deltaTime) || 0;
		current.presses.push({ index: client.index, clientId, deltaTime: player.pressedAt });

		if (!this.pressState.timer) {
			this.pressState.timer = setTimeout(() => this.resolvePresses(), PRESS_ACCEPT_WINDOW);
		}
	}

	resolvePresses() {
		const current = this.currentQuestion;
		const pressState = this.pressState;

		if (!current || !pressState) {
			return;
		}

		this.pressState = null;
		this.stopTimer(1);

		if (current.presses.length === 0) {
			this.endPressPhase(null);
			return;
		}

		// The client measures the delay from the TRY message, so the smallest
		// delay is the first person who pressed the button.
		const presses = [...current.presses].sort((a, b) => a.deltaTime - b.deltaTime);
		this.endPressPhase(presses[0].index);
	}

	endPressPhase(winnerIndex) {
		const current = this.currentQuestion;
		if (!current) {
			return;
		}

		this.pressState = null;
		this.stopTimer(1);

		if (winnerIndex === null || winnerIndex === undefined) {
			this.broadcastLines(['ENDTRY', 'A']);
			this.revealAnswer();
			this.delay(2500, () => this.finishQuestion());
			return;
		}

		this.broadcastLines(['ENDTRY', String(winnerIndex)]);
		this.askAnswerToPlayer(winnerIndex);
	}

	// -------------------------------------------------------------- answering

	askAnswerToPlayer(playerIndex) {
		const current = this.currentQuestion;
		const player = this.players[playerIndex];

		if (!current || !player || !player.clientId) {
			this.revealAnswer();
			this.delay(2000, () => this.finishQuestion());
			return;
		}

		current.answererIndex = playerIndex;
		this.phase = 'answering';
		this.setPlayerState([playerIndex], PLAYER_STATE.Answering);

		this.sendMessage(player.clientId, `ANSWER\n${current.answerType}`);

		const answerTime = current.question.type === QuestionTypes.Default || current.question.type === QuestionTypes.Simple
			? Number(this.timeSettings.timeForThinkingOnSpecial) || 25
			: Number(this.timeSettings.timeForPrintingAnswer) || 25;

		this.runTimer(2, answerTime * 1000, playerIndex, () => this.onAnswerTimeout(playerIndex));
	}

	onAnswerTimeout(playerIndex) {
		const current = this.currentQuestion;
		if (!current || this.phase !== 'answering') {
			return;
		}

		this.broadcastLines(['CANCEL']);
		this.setPlayerState([playerIndex], PLAYER_STATE.Lost);
		this.players[playerIndex].answered = true;

		if (current.isForAll) {
			this.collectForAllAnswers();
			return;
		}

		this.continueAfterWrongAnswer(playerIndex);
	}

	/** Handles ANSWER from a player. */
	onPlayerAnswer(clientId, answer) {
		const current = this.currentQuestion;
		const client = this.clients.get(clientId);

		if (!current || !client || client.role !== ROLE_PLAYER) {
			return;
		}

		const playerIndex = client.index;
		const player = this.players[playerIndex];

		if (!player) {
			return;
		}

		const text = String(answer || '').trim();

		if (current.isForAll) {
			if (!this.pendingAnswers) {
				return;
			}

			this.pendingAnswers.answers.set(playerIndex, text);
			this.pendingAnswers.pending.delete(clientId);
			player.answered = true;

			if (this.pendingAnswers.pending.size === 0) {
				this.clearTimer(2);
				this.collectForAllAnswers();
			}

			return;
		}

		if (this.phase !== 'answering' || current.answererIndex !== playerIndex) {
			return;
		}

		this.stopTimer(2);
		this.broadcastLines(['PLAYERANSWER', String(playerIndex), inlineText(text)]);
		player.answer = text;

		this.requestValidation(playerIndex, text);
	}

	/**
	 * Asks the human showman to validate an answer, or validates it automatically
	 * when the showman seat is computer-controlled.
	 */
	requestValidation(playerIndex, answer, onDone) {
		const current = this.currentQuestion;
		if (!current) {
			return;
		}

		const showmanConnected = this.showman.clientId && this.showman.isHuman;

		if (!showmanConnected) {
			const isRight = this.isAnswerRight(current.question, answer);
			this.applyAnswerResult(playerIndex, isRight, 1, { suppressFinish: !!onDone });
			if (onDone) {
				onDone(isRight);
			}
			return;
		}

		this.pendingValidation = { playerIndex, answer, onDone };
		this.sendMessage(this.showman.clientId, `ASK_VALIDATE\n${playerIndex}\n${inlineText(answer)}\n-`);

		const time = Number(this.timeSettings.timeForShowmanDecisions) || 30;
		this.runTimer(2, time * 1000, -1, () => {
			const validation = this.pendingValidation;
			if (!validation) {
				return;
			}

			this.log('Showman did not validate the answer in time, validating automatically');
			this.pendingValidation = null;
			const isRight = this.isAnswerRight(current.question, validation.answer);
			this.applyAnswerResult(validation.playerIndex, isRight, 1, { suppressFinish: !!validation.onDone });
			if (validation.onDone) {
				validation.onDone(isRight);
			}
		});
	}

	/** Handles ISRIGHT from the showman. */
	handleValidationResult(clientId, isRight, factor) {
		const validation = this.pendingValidation;
		const client = this.clients.get(clientId);

		if (!validation || !client || client.role !== ROLE_SHOWMAN) {
			return;
		}

		this.pendingValidation = null;
		this.stopTimer(2);
		this.applyAnswerResult(validation.playerIndex, isRight, Number(factor) || 1, { suppressFinish: !!validation.onDone });

		if (validation.onDone) {
			validation.onDone(isRight);
		}
	}

	isAnswerRight(question, answer) {
		const normalized = normalizeAnswer(answer);

		if (normalized.length === 0) {
			return false;
		}

		const rightAnswers = (question.right && question.right.answer) || [];

		for (const rightAnswer of rightAnswers) {
			// A right answer may contain several acceptable variants separated by "/".
			for (const variant of String(rightAnswer).split('/')) {
				const normalizedVariant = normalizeAnswer(variant);

				if (normalizedVariant.length === 0) {
					continue;
				}

				if (normalized === normalizedVariant) {
					return true;
				}

				if (normalizedVariant.length >= 3 && normalized.includes(normalizedVariant)) {
					return true;
				}

				if (normalized.length >= 4 && normalizedVariant.includes(normalized)) {
					return true;
				}
			}
		}

		return false;
	}

	applyAnswerResult(playerIndex, isRight, factor, options = {}) {
		const current = this.currentQuestion;
		const player = this.players[playerIndex];

		if (!current || !player) {
			return;
		}

		const price = Math.max(0, Math.round(current.price * (factor || 1)));
		const delta = current.isNoRisk && !isRight ? 0 : (isRight ? price : -price);

		if (isRight) {
			player.sum += delta;
			player.rightCount += 1;
			player.rightSum += Math.abs(delta);
			player.state = PLAYER_STATE.Right;
			this.broadcastLines(['RIGHTANSWER', String(playerIndex), inlineText(this.getRightAnswerText(current.question))]);
			this.broadcastAnswerContent(current.question);
			this.setPlayerState([playerIndex], PLAYER_STATE.Right);
		} else {
			player.sum += delta;
			player.wrongCount += 1;
			player.wrongSum += Math.abs(delta);
			player.state = PLAYER_STATE.Lost;
			this.setPlayerState([playerIndex], PLAYER_STATE.Lost);
		}

		this.broadcastLines(['PERSON', isRight ? '+' : '-', String(playerIndex), String(player.sum)]);
		this.broadcastSums();
		this.onChanged(this);

		if (options.suppressFinish) {
			return;
		}

		if (isRight) {
			this.delay(2000, () => this.finishQuestion(playerIndex));
			return;
		}

		if (current.isForAll) {
			this.collectForAllAnswers();
			return;
		}

		this.continueAfterWrongAnswer(playerIndex);
	}

	continueAfterWrongAnswer(playerIndex) {
		const current = this.currentQuestion;
		if (!current) {
			return;
		}

		current.answeredPlayers.add(playerIndex);

		const available = this.players
			.map((player, index) => ({ player, index }))
			.filter(item => item.player.clientId && !current.answeredPlayers.has(item.index) && item.player.isHuman);

		if (available.length === 0 || current.isStake) {
			this.revealAnswer();
			this.delay(2500, () => this.finishQuestion());
			return;
		}

		// The button becomes available to the remaining players again.
		this.delay(800, () => this.startPressPhase());
	}

	revealAnswer() {
		const current = this.currentQuestion;
		if (!current) {
			return;
		}

		const answerText = this.getRightAnswerText(current.question);
		this.broadcastLines(['RIGHTANSWER', '-1', inlineText(answerText)]);
		this.broadcastAnswerContent(current.question);
	}

	broadcastAnswerContent(question) {
		const answerContent = question.params && question.params.answer;

		if (answerContent && answerContent.items && answerContent.items.some(item => item.type !== 'text')) {
			this.sendContentItems(answerContent);
		}
	}

	getRightAnswerText(question) {
		const answers = (question.right && question.right.answer) || [];
		const answerContentText = getTextContent(question.params && question.params.answer);

		if (answers.length > 0) {
			return answers.join(' / ');
		}

		return answerContentText;
	}

	// ----------------------------------------------------------------- for all

	startForAllAnswers() {
		const current = this.currentQuestion;
		if (!current) {
			return;
		}

		this.phase = 'answering';
		const candidates = this.players.filter(player => player.clientId !== null);

		if (candidates.length === 0) {
			this.revealAnswer();
			this.delay(2000, () => this.finishQuestion());
			return;
		}

		this.pendingAnswers = {
			pending: new Set(candidates.map(player => player.clientId)),
			answers: new Map(),
			order: candidates.map(player => player.index),
		};

		for (const player of candidates) {
			this.sendMessage(player.clientId, `ANSWER\n${current.answerType}`);
		}

		const time = Number(this.timeSettings.timeForThinkingOnSpecial) || 25;
		this.runTimer(2, time * 1000, -2, () => this.collectForAllAnswers());
	}

	collectForAllAnswers() {
		const current = this.currentQuestion;
		const batch = this.pendingAnswers;

		if (!current) {
			return;
		}

		this.clearTimer(2);
		this.pendingAnswers = null;

		if (!batch) {
			this.finishQuestion();
			return;
		}

		const entries = [...batch.answers.entries()];
		for (const [playerIndex, answer] of entries) {
			this.broadcastLines(['PLAYERANSWER', String(playerIndex), inlineText(answer)]);
		}

		this.validateForAllAnswers(current, entries);
	}

	validateForAllAnswers(current, entries) {
		const queue = [...entries];

		const next = () => {
			if (queue.length === 0) {
				this.revealAnswer();
				this.delay(2500, () => this.finishQuestion());
				return;
			}

			const [playerIndex, answer] = queue.shift();

			this.requestValidation(playerIndex, answer, () => {
				this.delay(1500, next);
			});
		};

		next();
	}

	// ----------------------------------------------------------------- stakes

	requestStakes(reason, onComplete) {
		const current = this.currentQuestion;
		if (!current) {
			return;
		}

		const participants = this.players
			.map((player, index) => ({ player, index }))
			.filter(item => item.player.clientId !== null && item.player.isHuman);

		if (participants.length === 0) {
			onComplete();
			return;
		}

		const modes = 'Stake,Pass';
		const maximum = Math.max(1, ...participants.map(item => item.player.sum));

		this.pendingStakes = {
			pending: new Set(participants.map(item => item.player.clientId)),
			stakes: new Map(),
			modes,
			minimum: 1,
			maximum,
			step: 1,
			reason: reason === 'final' ? 'final' : 'question',
			onComplete,
			timer: null,
		};

		this.phase = 'stakes';

		for (const item of participants) {
			this.sendMessage(item.player.clientId, this.buildAskStakeMessage());
		}

		const time = reason === 'final'
			? Number(this.timeSettings.timeForChoosingFinalTheme) || 30
			: Number(this.timeSettings.timeForMakingStake) || 30;

		this.pendingStakes.timer = this.runTimer(2, time * 1000, null, () => this.completeStakes());
	}

	handleStake(clientId, mode, value) {
		const batch = this.pendingStakes;
		const client = this.clients.get(clientId);

		if (!batch || !client || client.role !== ROLE_PLAYER) {
			return;
		}

		const player = this.players[client.index];
		if (!player) {
			return;
		}

		let stakeType = 1; // StakeTypes.Sum
		let stakeValue = Number(value) || 0;

		if (mode === 'Pass') {
			stakeType = 2;
			stakeValue = 0;
		} else if (mode === 'AllIn') {
			stakeType = 3;
			stakeValue = Math.max(1, player.sum);
		}

		if (stakeType === 1) {
			stakeValue = Math.min(Math.max(batch.minimum, stakeValue), Math.max(batch.maximum, batch.minimum));
		}

		batch.stakes.set(client.index, { type: stakeType, value: stakeValue });
		batch.pending.delete(clientId);

		if (batch.pending.size === 0) {
			this.completeStakes();
		}
	}

	completeStakes() {
		const batch = this.pendingStakes;

		if (!batch) {
			return;
		}

		this.pendingStakes = null;
		this.clearTimer(2);

		const stakes = [...batch.stakes.entries()].filter(([, stake]) => stake.type !== 2);

		for (const [playerIndex, stake] of batch.stakes) {
			this.broadcastLines(['PERSONSTAKE', String(playerIndex), String(stake.type), String(stake.value)]);
		}

		if (stakes.length === 0) {
			this.log('Everybody passed the stake question');
			this.broadcastLines(['RIGHTANSWER', '-1', inlineText(this.getRightAnswerText(this.currentQuestion.question))]);
			this.delay(2000, () => this.finishQuestion());
			return;
		}

		stakes.sort((a, b) => b[1].value - a[1].value || a[0] - b[0]);
		const [winnerIndex, stake] = stakes[0];

		this.currentQuestion.price = stake.value;
		this.currentQuestion.stakeWinner = winnerIndex;
		this.players[winnerIndex].stake = stake.value;
		this.players[winnerIndex].stakeType = stake.type;

		if (batch.reason === 'final') {
			this.startFinalAnswers();
			return;
		}

		batch.onComplete();
	}

	startStakeAnswer() {
		const current = this.currentQuestion;
		if (!current || current.stakeWinner === undefined) {
			return;
		}

		this.broadcastLines(['QUESTION', String(current.price)]);
		this.setPlayerState([current.stakeWinner], PLAYER_STATE.Answering);
		this.askAnswerToPlayer(current.stakeWinner);
	}

	// ------------------------------------------------------------------ final

	beginFinalRound() {
		const theme = this.round.themes[0];
		const question = theme && theme.questions[0];

		if (!question) {
			this.endRound('empty');
			return;
		}

		this.currentQuestion = {
			themeIndex: 0,
			questionIndex: 0,
			theme,
			question,
			price: question.price,
			answererIndex: -1,
			answerType: question.params.answerType || '',
			answeredPlayers: new Set(),
			presses: [],
			isFinal: true,
		};

		this.questionLog = [];
		const themeInfo = theme.info || { authors: [], sources: [], comments: '' };

		this.broadcastLines([
			'THEME',
			theme.name,
			'-',
			escapeText(themeInfo.comments || ''),
			String(themeInfo.authors.length),
			...themeInfo.authors.map(author => inlineText(author)),
			String(themeInfo.sources.length),
			...themeInfo.sources.map(source => inlineText(source)),
		]);

		this.requestStakes('final', () => this.startFinalAnswers());
	}

	startFinalAnswers() {
		const current = this.currentQuestion;
		if (!current) {
			return;
		}

		this.broadcastLines(['QUESTION', String(current.price)]);
		this.broadcastLines(['QTYPE', current.question.type || '', 'False', 'False']);
		current.mediaSent = this.sendContentItems(current.question.params.question);
		this.phase = 'mediaLoading';

		this.waitForMedia(() => {
			this.broadcastLines(['FINALTHINK']);

			const participants = this.players.filter(player => player.clientId !== null);
			this.pendingAnswers = {
				pending: new Set(participants.map(player => player.clientId)),
				answers: new Map(),
				order: participants.map(player => player.index),
			};

			for (const player of participants) {
				this.sendMessage(player.clientId, `ANSWER\n${current.answerType}`);
			}

			const time = Number(this.timeSettings.timeForFinalThinking) || 45;
			this.runTimer(2, time * 1000, -2, () => this.collectFinalAnswers());
		});
	}

	collectFinalAnswers() {
		const batch = this.pendingAnswers;
		this.pendingAnswers = null;
		this.clearTimer(2);

		if (!batch) {
			this.finishQuestion();
			return;
		}

		for (const [playerIndex, answer] of batch.answers) {
			this.broadcastLines(['PLAYERANSWER', String(playerIndex), inlineText(answer)]);
		}

		const current = this.currentQuestion;
		const entries = [...batch.answers.entries()];

		for (const [playerIndex, answer] of entries) {
			const player = this.players[playerIndex];
			if (!player) {
				continue;
			}

			const stakeAmount = player.stake || 0;
			const price = stakeAmount > 0 ? stakeAmount : current.price;
			const isRight = this.isAnswerRight(current.question, answer);
			const delta = isRight ? price : -price;

			player.sum += delta;

			if (isRight) {
				player.rightCount += 1;
				player.rightSum += price;
			} else {
				player.wrongCount += 1;
				player.wrongSum += price;
			}

			this.setPlayerState([playerIndex], isRight ? PLAYER_STATE.Right : PLAYER_STATE.Wrong);
			this.broadcastLines(['PERSON', isRight ? '+' : '-', String(playerIndex), String(player.sum)]);
		}

		this.broadcastSums();
		this.revealAnswer();
		this.delay(4000, () => this.finishQuestion());
	}

	// --------------------------------------------------------- question end

	finishQuestion(bestPlayerIndex) {
		if (this.phase === 'lobby') {
			return;
		}

		const current = this.currentQuestion;
		this.currentQuestion = null;
		this.phase = 'betweenQuestions';
		this.stopAllTimers();
		this.pendingAnswers = null;
		this.pendingStakes = null;
		this.pendingValidation = null;

		this.broadcastLines(['QUESTION_END']);
		this.resetPlayerQuestionState();
		this.questionLog = [];

		// The player who answered correctly chooses the next question.
		const nextChooser = bestPlayerIndex !== undefined && bestPlayerIndex >= 0 && this.players[bestPlayerIndex]
			? bestPlayerIndex
			: this.chooserIndex;

		this.onChanged(this);

		if (this.round && this.round.type === 'final') {
			this.delay(NEXT_QUESTION_DELAY, () => this.endRound('final'));
			return;
		}

		const remainingQuestions = this.countRemainingQuestions(this.round);
		if (remainingQuestions === 0) {
			this.delay(NEXT_QUESTION_DELAY, () => this.endRound('empty'));
			return;
		}

		this.delay(NEXT_QUESTION_DELAY, () => this.chooseNextChooser(nextChooser));
	}

	countRemainingQuestions(round) {
		if (!round || !round.themes) {
			return 0;
		}

		let total = 0;
		for (const theme of round.themes) {
			total += theme.questions.length;
		}

		let played = 0;
		for (const theme of this.table) {
			played += theme.prices.filter(price => price < 0).length;
		}

		return Math.max(0, total - played);
	}

	endRound(reason) {
		if (this.roundIndex < 0) {
			return;
		}

		this.phase = 'roundEnd';
		this.stopAllTimers();
		this.currentQuestion = null;
		this.questionLog = [];

		this.broadcastLines(['STOP']);
		this.broadcastSums();

		this.resetPlayerRoundState();

		const nextRound = this.roundIndex + 1;

		this.onChanged(this);

		if (nextRound >= this.parsedPackage.rounds.length) {
			this.delay(2500, () => this.finishGame());
			return;
		}

		this.delay(2500, () => this.beginRound(nextRound));
	}

	finishGame() {
		this.phase = 'finished';
		this.stage = STAGE.After;
		this.stageName = this.name;
		this.stopAllTimers();
		this.currentQuestion = null;

		this.broadcastLines(['STAGE', STAGE.After, this.name, String(this.parsedPackage ? this.parsedPackage.rounds.length : 0), '']);
		this.broadcastSums();

		const winnerIndex = this.getWinnerIndex();
		if (winnerIndex >= 0) {
			this.broadcastLines(['WINNER', String(winnerIndex)]);
		}

		const statistics = [];
		for (const player of this.players) {
			statistics.push(
				player.name,
				String(player.rightCount),
				String(player.wrongCount),
				String(player.rightSum),
				String(player.wrongSum)
			);
		}

		if (statistics.length > 0) {
			this.broadcastLines(['GAME_STATISTICS', ...statistics]);
		}

		this.isStarted = false;
		this.onChanged(this);
	}

	getWinnerIndex() {
		let winnerIndex = -1;
		let bestSum = -Infinity;

		this.players.forEach((player, index) => {
			if (player.clientId !== null && player.sum > bestSum) {
				bestSum = player.sum;
				winnerIndex = index;
			}
		});

		return winnerIndex;
	}

	resetPlayerRoundState() {
		for (const player of this.players) {
			player.state = PLAYER_STATE.None;
			player.answer = '';
			player.answered = false;
			player.pressedAt = null;
			player.stake = 0;
			player.stakeType = 0;
		}
	}

	resetPlayerQuestionState() {
		for (const player of this.players) {
			player.state = PLAYER_STATE.None;
			player.answer = '';
			player.answered = false;
			player.pressedAt = null;
			player.hasPassed = false;
		}

		const indices = this.players.map((_, index) => index);
		if (indices.length > 0) {
			this.broadcastLines(['PLAYERSTATE', PLAYER_STATE.None, ...indices.map(String)], { noLog: true });
		}
	}

	setPlayerState(indices, state) {
		for (const index of indices) {
			const player = this.players[index];
			if (player) {
				player.state = state;
			}
		}

		if (indices.length > 0) {
			this.broadcastLines(['PLAYERSTATE', state, ...indices.map(String)], { noLog: true });
		}
	}

	// ------------------------------------------------------------ lobby msgs

	/**
	 * Handles a system message from a client (see messageProcessor.ts on the
	 * client side for the opposite direction).
	 */
	handleSystemMessage(clientId, text) {
		const args = String(text).split('\n');
		const command = args[0];
		const client = this.clients.get(clientId);

		if (!client) {
			return;
		}

		switch (command) {
			case 'INFO':
				this.sendSnapshot(clientId);
				break;

			case 'READY':
				this.handleReady(client, args);
				break;

			case 'START':
				this.start();
				break;

			case 'CHOICE':
				this.onChoice(clientId, Number(args[1]), Number(args[2]));
				break;

			case 'I':
				this.onPress(clientId, Number(args[1]));
				break;

			case 'ANSWER':
				this.onPlayerAnswer(clientId, args[1] || '');
				break;

			case 'PASS':
				this.handlePass(client);
				break;

			case 'ISRIGHT':
				this.handleValidationResult(clientId, args[1] === '+', args[2]);
				break;

			case 'SET_STAKE':
				this.handleStake(clientId, args[1], args[2]);
				break;

			case 'SETCHOOSER':
				this.handleSetChooser(client, args);
				break;

			case 'SETJOINMODE':
				this.handleSetJoinMode(client, args);
				break;

			case 'PIN':
				this.sendMessage(clientId, `PIN\n${this.pin}`);
				break;

			case 'MEDIALOADED':
				this.onMediaLoaded(clientId);
				break;

			case 'MEDIA_PRELOAD_PROGRESS':
				this.broadcast(`MEDIA_PRELOAD_PROGRESS\n${client.name}\n${Number(args[1]) || 0}`, { noLog: true });
				break;

			case 'PAUSE':
				if (args[1] === '+') {
					this.pauseTimers();
				} else {
					this.resumeTimers();
				}
				break;

			case 'START_TIMER':
				break;

			case 'MOVE':
				this.handleMove(client, args);
				break;

			case 'CHANGE':
				this.handleChange(client, args);
				break;

			case 'TOGGLE':
				this.handleToggle(client, args);
				break;

			case 'AVATAR':
				this.broadcast(`AVATAR\n${client.name}\n${args[1]}\n${args[2]}`);
				break;

			case 'LEADERBOARD':
				this.broadcastLines(['LEADERBOARD', ...this.players.flatMap(player => [player.name, String(player.sum)])]);
				break;

			case 'SETHOST':
				this.handleSetHost(client, args);
				break;

			case 'MOVEABLE':
			case 'CONFIG':
			case 'APELLATE':
			case 'REPORT':
			case 'MARK':
			case 'BAN':
			case 'UNBAN':
			case 'DELETE':
			case 'SELECT_PLAYER':
			case 'VALIDATE':
			case 'ANSWER_VERSION':
			case 'ORAL_ANSWER':
				// Not needed for a local game (or not implemented yet).
				break;

			default:
				this.log(`Unknown system message from ${client.name}: ${command}`);
				break;
		}
	}

	handleReady(client, args) {
		const seat = this.findSeatByName(client.name);

		if (!seat) {
			return;
		}

		seat.isReady = args[1] === '+';
		this.broadcastLines(['READY', seat.name, seat.isReady ? '+' : '-']);
		this.onChanged(this);
	}

	handleSetJoinMode(client, args) {
		const mode = ['AnyRole', 'OnlyViewer', 'Forbidden'].indexOf(args[1]);
		this.joinMode = mode < 0 ? 0 : mode;
		this.broadcastLines(['SETJOINMODE', args[1], '+']);
		this.onChanged(this);
	}

	handleSetChooser(client, args) {
		const index = Number(args[1]);

		if (Number.isInteger(index) && this.players[index]) {
			this.chooserIndex = index;
			this.broadcastLines(['SETCHOOSER', String(index), this.phase === 'choosing' ? '+' : '-', '+', '-']);

			const chooser = this.players[index];
			if (this.phase === 'choosing' && chooser.clientId) {
				this.sendMessage(chooser.clientId, 'CHOOSE');
			}
		}
	}

	handleSetHost(client, args) {
		const name = args[1] || client.name;
		if (this.findSeatByName(name)) {
			this.hostName = name;
			this.broadcastLines(['HOSTNAME', name]);
		}
	}

	/** Tells everybody that a player cannot press the button any more. */
	handlePass(client) {
		if (client.role !== ROLE_PLAYER || (this.phase !== 'press' && this.phase !== 'answering')) {
			return;
		}

		const player = this.players[client.index];

		if (!player || player.answered || player.hasPassed) {
			return;
		}

		player.hasPassed = true;
		player.pressedAt = null;

		if (this.currentQuestion && this.currentQuestion.presses) {
			this.currentQuestion.presses = this.currentQuestion.presses.filter(press => press.index !== client.index);
		}

		// PASS <player index> is the message the client understands (PASS is
		// also a request, but the answer for it is the same message).
		this.broadcastLines(['PASS', String(client.index)]);

		// Nobody can press any more: finish the press phase right away instead
		// of waiting for the timer.
		if (this.phase === 'press' && this.pressState) {
			const canStillPress = this.players.some(seat => seat.clientId && !seat.answered && !seat.hasPassed);

			if (!canStillPress) {
				this.stopTimer(1);
				this.resolvePresses();
			}
		}
	}

	/**
	 * Changes a player score on behalf of the showman (CHANGE message).
	 *
	 * The format matches the reference SI server: CHANGE, <player number
	 * starting from 1>, <new sum>. Everybody receives PLAYER_SCORE_CHANGED with
	 * a zero-based player index plus the new sums, so all clients stay in sync.
	 */
	handleChange(client, args) {
		// The reference server trusts only the showman, but the client shows the
		// score editor to the host, so the host is accepted too.
		if (client.role !== ROLE_SHOWMAN && client.name !== this.hostName) {
			return;
		}

		if (args.length < 3) {
			return;
		}

		const playerNumber = Number(args[1]);
		const sum = Number(args[2]);

		if (!Number.isInteger(playerNumber) || !Number.isInteger(sum)) {
			return;
		}

		const playerIndex = playerNumber - 1;
		const player = this.players[playerIndex];

		if (!player) {
			return;
		}

		player.sum = sum;

		this.broadcastLines(['PLAYER_SCORE_CHANGED', String(playerIndex), String(sum)]);
		this.broadcastSums();
		this.log(`Sum change: ${playerIndex} = ${sum}`);
	}

	handleMove(client, args) {
		if (client.role !== ROLE_SHOWMAN && client.name !== this.hostName) {
			return;
		}

		// MOVE 1 = next (showman), MOVE 3 = move to round index.
		if (args[1] === '3') {
			const roundIndex = Number(args[2]);
			if (Number.isInteger(roundIndex) && this.parsedPackage && roundIndex >= 0 && roundIndex < this.parsedPackage.rounds.length) {
				this.stopAllTimers();
				this.beginRound(roundIndex);
			}
			return;
		}

		if (this.phase === 'lobby' || this.phase === 'finished') {
			this.start();
			return;
		}

		// A question is being read or played: "next" skips it and returns to
		// the table, exactly like the reference server does on MOVE Next.
		if (this.currentQuestion) {
			this.log('Question skipped by the showman');
			this.cancelPendingDelay();
			this.finishQuestion();
			return;
		}

		if (this.phase === 'choosing' || this.phase === 'betweenQuestions') {
			this.endRound('manual');
		}
	}

	/** Cancels a scheduled action (used when the showman interrupts the flow). */
	cancelPendingDelay() {
		if (this.startDelayTimer) {
			clearTimeout(this.startDelayTimer);
			this.startDelayTimer = null;
		}
	}

	handleToggle(client, args) {
		const themeIndex = Number(args[1]);
		const questionIndex = Number(args[2]);
		const theme = this.table[themeIndex];

		if (!theme) {
			return;
		}

		const currentPrice = theme.prices[questionIndex];
		if (currentPrice === undefined) {
			return;
		}

		const newPrice = currentPrice < 0 && this.round && this.round.themes[themeIndex]
			? this.round.themes[themeIndex].questions[questionIndex].price
			: -1;

		theme.prices[questionIndex] = newPrice;
		this.broadcastLines(['TOGGLE', String(themeIndex), String(questionIndex), String(newPrice)]);
	}

	// --------------------------------------------------------------- timing

	delay(ms, callback) {
		const timer = setTimeout(() => {
			this.startDelayTimer = null;

			if (this.disposed) {
				return;
			}

			try {
				callback();
			} catch (error) {
				this.log(`Delayed action failed: ${error.stack || error}`);
			}
		}, ms);

		this.startDelayTimer = timer;
		return timer;
	}

	// ------------------------------------------------------------ lobby info

	getProgress() {
		return {
			current: this.questionCounters.played,
			total: this.questionCounters.total,
		};
	}

	/**
	 * Persons of the game as reported to the lobby.
	 *
	 * Free seats are reported too (IsOnline: false): the client enables the
	 * "Player"/"Showman" buttons only when such a seat exists, so hiding empty
	 * seats makes a room unjoinable for everyone except viewers.
	 * Computer-controlled seats are always reported as occupied.
	 */
	getPersons() {
		const persons = [];

		const addSeat = seat => {
			const isOnline = !!seat.clientId || !seat.isHuman;

			persons.push({
				IsOnline: isOnline,
				Name: isOnline ? seat.name : '',
				Role: SERVER_ROLE[seat.role],
			});
		};

		addSeat(this.showman);
		this.players.forEach(addSeat);

		// Viewers are unlimited: only the connected ones are worth reporting.
		for (const viewer of this.viewers) {
			if (viewer.clientId) {
				persons.push({ IsOnline: true, Name: viewer.name, Role: SERVER_ROLE.viewer });
			}
		}

		return persons;
	}

	/** Public game information for the lobby (GameInfo contract). */
	getGameInfo(hostUri) {
		const progress = this.getProgress();

		return {
			HostUri: hostUri,
			GameID: this.id,
			GameName: this.name || this.packageInfo && this.packageInfo.uri || '',
			Language: (this.settings.appSettings && this.settings.appSettings.culture) || 'ru-RU',
			Mode: 'Tv',
			Owner: this.owner,
			PackageName: this.parsedPackage ? this.parsedPackage.name : '',
			PasswordRequired: !!this.password,
			Persons: this.getPersons(),
			ProgressCurrent: progress.current,
			ProgressTotal: progress.total,
			RealStartTime: (this.realStartTime || this.createdAt).toISOString(),
			Rules: this.getRoundRules(),
			Stage: this.stage,
			StageName: this.stageName,
			Started: this.isStarted,
			StartTime: this.createdAt.toISOString(),
		};
	}

	/** Releases all resources when the game is deleted. */
	dispose() {
		this.disposed = true;
		this.stopAllTimers();
		this.clearTimer(0);
		this.clearTimer(1);
		this.clearTimer(2);

		if (this.startDelayTimer) {
			clearTimeout(this.startDelayTimer);
		}

		if (this.mediaWait) {
			clearTimeout(this.mediaWait.timeout);
			this.mediaWait = null;
		}

		if (this.pressState && this.pressState.timer) {
			clearTimeout(this.pressState.timer);
		}
	}
}

function createPin() {
	return Math.floor(100000 + Math.random() * 900000);
}

module.exports = {
	Game,
	STAGE,
	PLAYER_STATE,
	SERVER_ROLE,
	ANY_NAME,
	GAME_CLIENT,
	escapeText,
	inlineText,
	normalizeAnswer,
	createPin,
};
