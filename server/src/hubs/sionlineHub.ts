import { HubConnection } from '../signalr/hubConnection';
import { GameInfoModel, PersonInfoModel, SliceModel } from '../api/models';
import { Lobby, LobbyListener } from '../game/lobby';
import { requestBaseUrl } from '../api/requestContext';

/** `sionline` hub: the lobby game list. */
export class SIOnlineHub {
	/** Listener of every active connection. */
	private readonly listeners = new Map<HubConnection, LobbyListener>();

	constructor(private readonly lobby: Lobby) { }

	/** Returns hub methods. */
	get methods() {
		return {
			GetGamesSlice: (connection: HubConnection, fromId: number): SliceModel<GameInfoModel> => {
				this.attach(connection);

				// The game host uri must be the one the client has used to reach the server
				const baseUrl = connection.baseUrl;

				return baseUrl
					? requestBaseUrl.run(baseUrl, () => this.lobby.getGamesSlice(fromId ?? 0))
					: this.lobby.getGamesSlice(fromId ?? 0);
			},
		};
	}

	/** Handles a client disconnect. */
	onClosed(connection: HubConnection): void {
		const listener = this.listeners.get(connection);

		if (listener) {
			this.lobby.removeListener(listener);
			this.listeners.delete(connection);
		}
	}

	private attach(connection: HubConnection): void {
		if (this.listeners.has(connection)) {
			return;
		}

		const listener: LobbyListener = {
			onGameCreated: (_gameId, info) => connection.send('GameCreated', info),

			onGameChanged: (_gameId, info) => connection.send('GameChanged', info),

			onGameDeleted: gameId => connection.send('GameDeleted', gameId),

			onGamePersonsChanged: (_gameId, persons: PersonInfoModel[]) => {
				connection.send('GamePersonsChanged', _gameId, persons);
			},
		};

		this.listeners.set(connection, listener);
		this.lobby.addListener(listener);
	}
}

export default SIOnlineHub;
