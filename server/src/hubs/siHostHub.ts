import { HubConnection } from '../signalr/hubConnection';
import { GameInfoModel, JoinGameRequestModel, JoinGameResult, JoinGameResultValue, MessageModel, PersonInfoModel } from '../api/models';
import { Game } from '../game/game';
import { Lobby } from '../game/lobby';
import { GamePhase, GameSession, PersonRole } from '../game/session';
import { requestBaseUrl } from '../api/requestContext';

/** Marker of the game client receiver (all messages to the game go through it). */
const GAME_CLIENT = '@';

interface JoinState {
	gameId: number;
	personName: string;
}

/** `sihost` hub: joining games and exchanging game messages. */
export class SIHostHub {
	/** Join info per connection. */
	private readonly joins = new Map<HubConnection, JoinState>();

	/** Game per connection. */
	private readonly games = new Map<HubConnection, Game>();

	constructor(
		private readonly lobby: Lobby,
		private readonly log: (message: string) => void,
	) { }

	/** Returns hub methods. */
	get methods() {
		return {
			TryGetGameInfo: (connection: HubConnection, gameId: number): GameInfoModel | null => {
				const game = this.lobby.getGame(gameId);
				return game ? this.withBaseUrl(connection, () => this.lobby.buildGameInfo(game)) : null;
			},

			JoinGame2: (connection: HubConnection, request: JoinGameRequestModel): JoinGameResultValue => {
				const result = this.join(connection, request);

				if (result === JoinGameResult.Success) {
					this.log(`[sihost] ${request.UserName} присоединился к игре ${request.GameId} как ${request.Role}`);
				}

				return result;
			},

			SendMessage: (connection: HubConnection, message: MessageModel): void => {
				this.onMessage(connection, message);
			},
		};
	}

	/** Handles a client disconnect. */
	onClosed(connection: HubConnection): void {
		const game = this.games.get(connection);

		if (game) {
			game.detachConnection(connection);
			this.lobby.onGamePersonsChanged(game);
		}

		this.games.delete(connection);
		this.joins.delete(connection);
	}

	/** Returns the game of a connection. */
	getGame(connection: HubConnection): Game | null {
		return this.games.get(connection) ?? null;
	}

	/** Returns the person name of a connection. */
	getPersonName(connection: HubConnection): string | null {
		return this.joins.get(connection)?.personName ?? null;
	}

	private join(connection: HubConnection, request: JoinGameRequestModel): JoinGameResultValue {
		if (!request || typeof request.GameId !== 'number') {
			return JoinGameResult.CommonJoinError;
		}

		const game = this.lobby.getGame(request.GameId) ?? this.lobby.getGameByPin(request.Pin ?? -1);

		if (!game) {
			return JoinGameResult.GameNotFound;
		}

		const userName = (request.UserName ?? '').trim();

		if (!userName) {
			return JoinGameResult.InvalidUserName;
		}

		// Returning to the game after a page reload or a temporary connection loss.
		// A person could ask for another role (e.g. a showman becomes a player), then a new seat is taken.
		const existing = this.findPerson(game, userName);
		const existingRole = existing
			? (existing.role === PersonRole.Showman ? 'Showman' : 'Player')
			: null;

		if (existing && (existingRole === request.Role || request.Role === 'Viewer')) {
			if (existing.isConnected && this.isConnectedElsewhere(game, userName, connection)) {
				return JoinGameResult.NameIsOccupied;
			}

			return this.attach(connection, game, existing.name);
		}

		// A person that moves from the showman seat to a player seat (or vice versa) leaves the old seat
		const previousRole = existing?.role ?? null;

		switch (request.Role) {
			case 'Showman': {
				const showman = game.session.showman;

				if (showman.name.trim() && showman.name !== GameSession.EMPTY_NAME) {
					return JoinGameResult.ForbiddenRole;
				}

				showman.name = userName;
				showman.isHuman = true;
				showman.isBot = false;
				showman.isMale = request.Sex !== 'Female';
				showman.isReady = true;

				this.freePreviousSeat(game, userName, previousRole);

				return this.attach(connection, game, userName);
			}

			case 'Player': {
				const index = game.session.players.findIndex(player => !player.name.trim() || player.name === GameSession.EMPTY_NAME);

				if (index < 0) {
					return JoinGameResult.NoFreePlace;
				}

				const player = game.session.players[index];
				player.name = userName;
				player.isHuman = true;
				player.isBot = false;
				player.isMale = request.Sex !== 'Female';
				player.isReady = false;

				this.freePreviousSeat(game, userName, previousRole);

				return this.attach(connection, game, userName);
			}

			case 'Viewer': {
				const viewer = game.session.viewers.find(person => person.name === userName);

				if (viewer) {
					return this.attach(connection, game, userName);
				}

				game.session.viewers.push({
					name: userName,
					role: PersonRole.Viewer,
					isMale: request.Sex !== 'Female',
					isHuman: true,
					isConnected: false,
					isBot: false,
					isReady: true,
					sum: 0,
					stake: 0,
					state: 'None',
					answer: '',
				});

				return this.attach(connection, game, userName);
			}

			default:
				return JoinGameResult.InvalidRole;
		}
	}

	/** Runs an action with the server url that the given client has used. */
	private withBaseUrl<T>(connection: HubConnection, action: () => T): T {
		return connection.baseUrl ? requestBaseUrl.run(connection.baseUrl, action) : action();
	}

	/** Releases the seat that a person has occupied before joining another role. */
	private freePreviousSeat(game: Game, name: string, role: PersonRole | null): void {
		if (role === null) {
			return;
		}

		if (role === PersonRole.Showman) {
			const showman = game.session.showman;

			if (showman.name === name) {
				showman.name = GameSession.EMPTY_NAME;
				showman.isHuman = false;
				showman.isConnected = false;
			}

			return;
		}

		const player = game.session.players.find(item => item.name === name);

		if (player) {
			player.name = GameSession.EMPTY_NAME;
			player.isHuman = false;
			player.isConnected = false;
			player.isReady = false;
			player.sum = 0;
		}
	}

	private findPerson(game: Game, name: string) {
		const person = game.session.findPerson(name);
		return person && person.name === name ? person : null;
	}

	private isConnectedElsewhere(game: Game, name: string, connection: HubConnection): boolean {
		const current = game.getConnection(name);
		return current !== null && current !== (connection as unknown as never);
	}

	private attach(connection: HubConnection, game: Game, personName: string): JoinGameResultValue {
		const previous = this.games.get(connection);

		if (previous && previous !== game) {
			previous.detachConnection(connection);
		}

		this.joins.set(connection, { gameId: game.id, personName });
		this.games.set(connection, game);
		connection.userName = personName;

		game.attachConnection(personName, connection, connection.baseUrl ?? undefined);
		game.setConnected(personName, true);
		game.sendFullState(personName);
		this.lobby.onGameChanged(game);

		if (game.session.phase !== GamePhase.Before) {
			// Player reconnected in the middle of a game
			game.onReconnect(personName);
		}

		return JoinGameResult.Success;
	}

	private onMessage(connection: HubConnection, message: MessageModel): void {
		if (!message) {
			return;
		}

		const game = this.games.get(connection);
		const join = this.joins.get(connection);

		if (!game || !join) {
			return;
		}

		if (message.Receiver === GAME_CLIENT) {
			game.handleClientMessage(join.personName, message.Text ?? '');
			return;
		}

		// Chat message
		if (message.IsSystem === false) {
			for (const person of game.session.persons) {
				if (!person.isHuman || !person.isConnected) {
					continue;
				}

				const target = game.getConnection(person.name);

				if (target) {
					target.send('Receive', {
						IsSystem: false,
						Sender: join.personName,
						Text: message.Text,
					});
				}
			}
		}
	}
}

export default SIHostHub;
