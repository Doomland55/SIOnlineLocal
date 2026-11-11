import fs from 'fs';
import path from 'path';
import { GameCreationResultCode, GameInfoModel, LobbyGameMode, LobbyGameStage, PersonInfoModel, RunGameResponseModel } from '../api/models';
import { requestBaseUrl } from '../api/requestContext';
import { Game, GameObserver } from './game';
import { PackageLibrary } from './library';
import { loadPackage, LoadedPackage } from './package';
import { GamePerson, GamePhase, GameSession, isEmptySlotName, MAX_PLAYER_COUNT, PersonRole } from './session';

export interface LobbyOptions {
	/**
	 * Default public server base url (used in HostUri of games).
	 * Games report the url the client has used to reach the server, so players on other
	 * machines by IP always receive addresses that work for them.
	 */
	publicBaseUrl: string;

	/** Returns the server base url for a client (session-level override). */
	getRequestBaseUrl?: () => string | undefined;

	/** Name of the server. */
	serverName: string;

	/** Default player name for the showman slot when it is not filled. */
	defaultShowmanName: string;

	/** Language of the games. */
	language: string;

	/** Bot names used to fill automatic games. */
	botNames: string[];

	/** Default game time settings (seconds). */
	timeSettings?: Record<string, number>;

	/** Logger. */
	log: (message: string) => void;
}

/** Number of bots that fill an automatic game. */
const AUTOMATIC_GAME_BOT_COUNT = 5;

/** Observes all games and provides lobby-level operations. */
export class Lobby implements GameObserver {
	private readonly games = new Map<number, Game>();

	private nextGameId = 1;

	/** Listeners of lobby events. */
	private readonly listeners = new Set<LobbyListener>();

	constructor(
		private readonly library: PackageLibrary,
		private readonly options: LobbyOptions,
		private readonly uploadsDir: string,
	) {
		fs.mkdirSync(uploadsDir, { recursive: true });
	}

	/** Adds a lobby listener (sionline hub connections). */
	addListener(listener: LobbyListener): void {
		this.listeners.add(listener);

		for (const game of this.games.values()) {
			listener.onGameCreated(game.id, this.buildGameInfo(game));
		}
	}

	removeListener(listener: LobbyListener): void {
		this.listeners.delete(listener);
	}

	/** Returns all games. */
	getGames(): Game[] {
		return [...this.games.values()];
	}

	/** Returns a game by id. */
	getGame(id: number): Game | null {
		return this.games.get(id) ?? null;
	}

	/** Returns a game by pin. */
	getGameByPin(pin: number): Game | null {
		for (const game of this.games.values()) {
			if (game.pin === pin) {
				return game;
			}
		}

		return null;
	}

	/** Returns the base url that is currently used for the given client. */
	private getBaseUrl(): string {
		return this.options.getRequestBaseUrl?.()
			?? requestBaseUrl.getStore()
			?? this.options.publicBaseUrl;
	}

	/** Creates a game from a local package file and adds it to the lobby. */
	async createGameFromFile(
		filePath: string,
		gameName: string,
		showmanName: string,
		playerNames: string[],
	): Promise<Game> {
		const loaded = await this.library.load(filePath);
		return this.createGame(loaded, gameName, showmanName, playerNames);
	}

	/**
	 * Creates a game from an already loaded package.
	 *
	 * `playerNames` are the seats that the game starts with: the showman seat is always present,
	 * every name takes a player seat and `emptySlots` free seats are added for other players.
	 * Free seats are visible in the lobby, so live players could see where they can join.
	 */
	createGame(
		loaded: LoadedPackage,
		gameName: string,
		showmanName: string,
		playerNames: string[],
		isAutomatic = false,
		emptySlots = 0,
	): Game {
		const id = this.nextGameId;
		this.nextGameId += 1;

		const game = new Game(
			id,
			gameName || loaded.package.name,
			loaded,
			isAutomatic,
			showmanName,
			this,
			this.getBaseUrl(),
		);

		// The showman seat is a placeholder until a live client takes it: the server acts as the showman,
		// so another player could join the game as the showman (or take any free seat)
		game.session.showman.name = showmanName;
		game.session.showman.isHuman = false;
		game.session.showman.isBot = true;
		game.session.showman.isConnected = false;

		playerNames
			.filter(name => !isEmptySlotName(name))
			.forEach(name => {
				game.session.players.push(this.createPerson(name));
			});

		// Free seats that other players could take; the table size must stay within the game limits
		const freeSlots = Math.max(0, Math.min(
			Math.max(0, emptySlots),
			MAX_PLAYER_COUNT - game.session.players.length,
		));

		for (let index = 0; index < freeSlots; index += 1) {
			game.session.players.push(this.createPerson(GameSession.EMPTY_NAME));
		}

		// At least one seat must stay free before the game starts: players join an existing game,
		// and the lobby only shows the "join as player" option when a free seat is visible
		if (game.session.phase === GamePhase.Before
			&& game.session.players.length < MAX_PLAYER_COUNT
			&& !game.session.players.some(player => isEmptySlotName(player.name))) {
			game.session.players.push(this.createPerson(GameSession.EMPTY_NAME));
		}

		game.setServerTimeSettings(this.options.timeSettings);

		this.games.set(id, game);
		this.notifyGameCreated(game);
		this.options.log(`Создана игра ${id} «${game.session.name}» (пакет ${loaded.fileName})`);

		return game;
	}

	private createPerson(name: string): GamePerson {
		return {
			name,
			role: PersonRole.Player,
			isMale: false,
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

	/** Loads an uploaded package and creates a game from it. */
	async createGameFromUpload(
		data: Buffer,
		fileName: string,
		gameName: string,
		showmanName: string,
		playerNames: string[],
	): Promise<RunGameResponseModel> {
		const uploadDir = this.uploadsDir;
		const filePath = path.join(uploadDir, `${Date.now()}-${path.basename(fileName) || 'package.siq'}`);

		fs.writeFileSync(filePath, data);

		try {
			const loaded = await loadPackage(filePath, path.basename(filePath), path.join(this.uploadsDir, 'media'));
			const game = this.createGame(loaded, gameName, showmanName, playerNames);

			return this.successResponse(game);
		} catch (e) {
			this.options.log(`Не удалось создать игру из загруженного пакета: ${(e as Error).message}`);
			fs.rmSync(filePath, { force: true });
			return this.errorResponse(GameCreationResultCode.BadPackage);
		}
	}

	/** Creates an automatic game using the first available package of the library. */
	async createAutomaticGame(playerName: string): Promise<RunGameResponseModel> {
		const loaded = await this.library.getDefaultPackage();

		if (!loaded) {
			return this.errorResponse(GameCreationResultCode.NoPackage);
		}

		// The creator of an automatic game is a player: the showman is the server (bot) one
		const game = this.createGame(loaded, loaded.package.name, this.options.defaultShowmanName, [], true);

		// Automatic games are filled with bots so that the game can be played alone,
		// but a free seat is always kept for a live player
		for (const botName of this.options.botNames) {
			if (game.session.players.length >= AUTOMATIC_GAME_BOT_COUNT) {
				break;
			}

			const bot = this.createPerson(botName);
			bot.isBot = true;
			bot.isReady = true;
			bot.isMale = Math.random() > 0.5;
			game.session.players.push(bot);
		}

		// A live player that has created the automatic game must have a seat to take
		if (!game.session.players.some(player => isEmptySlotName(player.name))) {
			game.session.players.push(this.createPerson(GameSession.EMPTY_NAME));
		}

		return this.successResponse(game);
	}

	private successResponse(game: Game): RunGameResponseModel {
		return {
			isSuccess: true,
			hostUri: this.getBaseUrl(),
			gameId: game.id,
			isHost: false,
			errorType: GameCreationResultCode.Ok,
		};
	}

	private errorResponse(code: GameCreationResultCode): RunGameResponseModel {
		return {
			isSuccess: false,
			hostUri: this.getBaseUrl(),
			gameId: -1,
			isHost: false,
			errorType: code,
		};
	}

	/** Removes a game. */
	removeGame(id: number): void {
		const game = this.games.get(id);

		if (!game) {
			return;
		}

		game.dispose();
		this.games.delete(id);

		for (const listener of this.listeners) {
			listener.onGameDeleted(id);
		}
	}

	/** Builds lobby game info. */
	buildGameInfo(game: Game): GameInfoModel {
		const { session } = game;
		const persons: PersonInfoModel[] = [];

		// Empty seats are reported too: the web client shows a role as available when it has an offline person,
		// so without them the "join as player" button is disabled even if there are free seats
		const appendPerson = (person: GamePerson) => {
			persons.push({
				IsOnline: person.isConnected || (person.isBot && person.role !== PersonRole.Showman),
				Name: person.name.trim() ? person.name : '',
				Role: person.role,
			});
		};

		// The server drives the showman seat: it stays available for a live player until someone takes it
		if (!session.showman.name.trim() || session.showman.isHuman) {
			appendPerson(session.showman);
		} else {
			persons.push({
				IsOnline: false,
				Name: session.showman.name,
				Role: PersonRole.Showman,
			});
		}

		session.players.forEach(appendPerson);
		session.viewers.filter(viewer => viewer.isConnected).forEach(appendPerson);

		const totalQuestions = session.packageInfo.package.rounds
			.reduce((total, round) => total + round.themes.reduce((sum, theme) => sum + theme.questions.length, 0), 0);

		const playedQuestions = session.themes
			.reduce((total, theme) => total + theme.prices.filter(price => price < 0).length, 0);

		return {
			HostUri: this.getBaseUrl(),
			GameID: game.id,
			GameName: game.session.name,
			Language: this.options.language,
			Mode: 'Tv' as LobbyGameMode,
			Owner: session.showman.name.trim() ? session.showman.name : session.name,
			PackageName: session.packageInfo.package.name,
			PasswordRequired: false,
			Persons: persons,
			ProgressCurrent: playedQuestions,
			ProgressTotal: totalQuestions,
			RealStartTime: game.createdAt.toISOString(),
			Rules: '',
			Stage: this.getLobbyStage(game),
			StageName: session.roundName,
			Started: session.phase !== GamePhase.Before,
			StartTime: game.createdAt.toISOString(),
		};
	}

	private getLobbyStage(game: Game): LobbyGameStage {
		switch (game.session.phase) {
			case GamePhase.Before:
				return 'Created';

			case GamePhase.Round:
				return 'Round';

			case GamePhase.Final:
				return 'Final';

			case GamePhase.Finished:
				return 'Finished';

			default:
				return 'Created';
		}
	}

	/** Game observer implementation: notifies lobby listeners about game changes. */
	onGameChanged(game: Game): void {
		const info = this.buildGameInfo(game);

		for (const listener of this.listeners) {
			listener.onGameChanged(game.id, info);
		}
	}

	log(message: string): void {
		this.options.log(message);
	}

	private notifyGameCreated(game: Game): void {
		const info = this.buildGameInfo(game);

		for (const listener of this.listeners) {
			listener.onGameCreated(game.id, info);
		}
	}

	/** Notifies listeners about changed persons of a game. */
	onGamePersonsChanged(game: Game): void {
		const info = this.buildGameInfo(game);

		for (const listener of this.listeners) {
			listener.onGamePersonsChanged?.(game.id, info.Persons);
		}
	}

	/** Returns game info for the lobby slice. */
	getGamesSlice(fromId: number): { Data: GameInfoModel[]; IsLastSlice: boolean } {
		const data = this.getGames()
			.filter(game => game.id > fromId)
			.sort((a, b) => a.id - b.id)
			.map(game => this.buildGameInfo(game));

		return { Data: data, IsLastSlice: true };
	}
}

/** Lobby events listener. */
export interface LobbyListener {
	onGameCreated(gameId: number, info: GameInfoModel): void;

	onGameChanged(gameId: number, info: GameInfoModel): void;

	onGameDeleted(gameId: number): void;

	onGamePersonsChanged?(gameId: number, persons: PersonInfoModel[]): void;
}

export default Lobby;
