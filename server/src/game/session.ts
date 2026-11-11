import { LoadedPackage } from './package';

/** Role of a person inside a game. */
export enum PersonRole {
	Showman = 'Showman',
	Player = 'Player',
	Viewer = 'Viewer',
}

/** Connection state of a game person. */
export interface GamePerson {
	/** Unique person name inside the game. */
	name: string;

	role: PersonRole;

	isMale: boolean;

	/** True for live web clients, false for bots and free slots. */
	isHuman: boolean;

	/** True when a client is currently connected. */
	isConnected: boolean;

	/** True for bots that are controlled by the server. */
	isBot: boolean;

	/** Ready flag (before the game starts). */
	isReady: boolean;

	/** Player score. */
	sum: number;

	/** Current player stake. */
	stake: number;

	/** Current player state (see PlayerStates). */
	state: string;

	/** Player answer to the current question. */
	answer: string;
}

/** A theme of the round table. */
export interface ThemeState {
	name: string;

	comments: string;

	/** Question prices; -1 means the question is already played. */
	prices: number[];
}

/** Game phase. */
export enum GamePhase {
	/** Waiting for players in the room. */
	Before = 'Before',

	/** Round is being played. */
	Round = 'Round',

	/** Final round. */
	Final = 'Final',

	/** Game is finished. */
	Finished = 'Finished',
}

const ANY_NAME = ' ';

/** Default bot names. */
export const DEFAULT_BOT_NAMES = ['Иннокентий', 'Александра', 'Борис', 'Василиса', 'Григорий', 'Дарья'];

/** Returns true for an empty slot name. */
export function isEmptySlotName(name: string): boolean {
	return name.trim().length === 0 || name === ANY_NAME;
}

/** A participant of the game plus service data. */
export class GameSession {
	public readonly players: GamePerson[] = [];

	public showman: GamePerson;

	public viewers: GamePerson[] = [];

	public phase: GamePhase = GamePhase.Before;

	/** Round index in the package. */
	public roundIndex = -1;

	/** Current round name. */
	public roundName = '';

	/** Round themes. */
	public themes: ThemeState[] = [];

	/** Selected theme and question indexes. */
	public themeIndex = -1;

	public questionIndex = -1;

	/** Chooser (player that selects a question). */
	public chooserIndex = -1;

	/** Person that has pressed the button and answers the current question. */
	public answererIndex = -1;

	/** Players that answer the current question (final round). */
	public answerers: number[] = [];

	/** Current price of the question. */
	public currentPrice = 0;

	/** True while the question is being played. */
	public isQuestionPlaying = false;

	/** True after the right answer has been shown. */
	public isQuestionAnswerShown = false;

	constructor(
		public readonly id: number,
		public readonly name: string,
		public readonly packageInfo: LoadedPackage,
		public readonly isAutomatic: boolean,
	) {
		this.showman = {
			name: '',
			role: PersonRole.Showman,
			isMale: true,
			isHuman: false,
			isConnected: false,
			isBot: false,
			isReady: false,
			sum: 0,
			stake: 0,
			state: 'None',
			answer: '',
		};
	}

	/** Returns all persons (showman, players, viewers). */
	get persons(): GamePerson[] {
		return [this.showman, ...this.players, ...this.viewers];
	}

	/** Returns main game persons (showman and players). */
	get mainPersons(): GamePerson[] {
		return [this.showman, ...this.players];
	}

	/** Returns a person by name. */
	findPerson(name: string): GamePerson | null {
		return this.persons.find(person => person.name === name) ?? null;
	}

	/** Returns true when a person with such name exists in the game. */
	hasPerson(name: string): boolean {
		return this.findPerson(name) !== null;
	}

	/** Returns index of a player by name. */
	getPlayerIndex(name: string): number {
		return this.players.findIndex(player => player.name === name);
	}

	/** Returns the current question (if the game is running). */
	get currentQuestion() {
		if (this.roundIndex < 0 || this.themeIndex < 0 || this.questionIndex < 0) {
			return null;
		}

		const round = this.packageInfo.package.rounds[this.roundIndex];
		return round?.themes[this.themeIndex]?.questions[this.questionIndex] ?? null;
	}

	/** Returns the current round. */
	get currentRound() {
		return this.packageInfo.package.rounds[this.roundIndex] ?? null;
	}

	/** Returns question prices for the current round. */
	get currentPrices(): number[][] {
		return this.themes.map(theme => theme.prices);
	}

	/** Number of connected humans. */
	get connectedHumans(): number {
		return this.mainPersons.filter(person => person.isHuman && person.isConnected).length;
	}

	/**
	 * Returns true when every occupied main slot that is currently played by a live client is ready.
	 * Disconnected players and server-controlled showman do not block the game start.
	 */
	get allReady(): boolean {
		const required = this.mainPersons.filter(person => person.isHuman && person.isConnected);

		return required.length > 0 && required.every(person => person.isReady);
	}

	/** Replaces the showman or player slot name with a new one. */
	static readonly EMPTY_NAME = ANY_NAME;
}
