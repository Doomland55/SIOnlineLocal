/**
 * Local server integration test.
 *
 * Runs the real web client code (Redux store, ClientController, GameClient,
 * REST and SignalR clients) against the built-in local server, and plays a
 * real game from the generated .siq package: create game, upload package,
 * join, start, choose a question, press, answer and receive points.
 *
 * This is the closest thing to a browser test that can run headless: it
 * validates the actual message formats the client expects.
 *
 * Disabled by default. Run with:
 *   RUN_LOCAL_SERVER_TEST=1 npx jest test/LocalServer.test.ts --runInBand
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import { Action, AnyAction, applyMiddleware, createStore } from 'redux';
import { withExtraArgument } from 'redux-thunk';
import JSZip from 'jszip';
import SIContentClient from 'sicontent-client';
import State, { initialState } from '../src/state/State';
import reducer from '../src/state/reducer';
import DataContext from '../src/model/DataContext';
import IHost, { FullScreenMode } from '../src/host/IHost';
import SIStorageClient from 'sistorage-client';
import SIStorageInfo from '../src/client/contracts/SIStorageInfo';
import AuthorizationMode from '../src/client/contracts/AuthorizationMode';
import GameServerClient from '../src/client/GameServerClient';
import SIHostClient from '../src/client/SIHostClient';
import GameClient from '../src/client/game/GameClient';
import actionCreators from '../src/logic/actionCreators';
import onlineActionCreators from '../src/state/online/onlineActionCreators';
import { INavigationState } from '../src/state/uiSlice';
import Path from '../src/model/enums/Path';
import { navigate } from '../src/utils/Navigator';
import { changeLogin } from '../src/state/userSlice';
import {
	setName,
	setPackageData,
	setPackageType,
	setPlayersCount,
	setRole,
} from '../src/state/gameSlice';
import PackageType from '../src/model/enums/PackageType';
import Role from '../src/client/models/Role';
import { newGame } from '../src/state/online2Slice';
import { pressGameButton, sendAnswer, DecisionType } from '../src/state/room2Slice';
import { onMediaLoaded, selectQuestion, startGame } from '../src/state/serverActions';
import GameStage from '../src/model/enums/GameStage';

const { LocalGameServer } = require('../server/src/server');

class TestHost implements IHost {
	getRandomValue: () => number;

	constructor() {
		this.getRandomValue = () => Math.floor(Math.random() * 1000000);
	}

	isDesktop(): boolean {
		return false;
	}

	async initAsync(): Promise<void> {
		// No-op for testing.
	}

	onReady(): void {
		// No-op for testing.
	}

	isLicenseAccepted(): boolean {
		return true;
	}

	acceptLicense(): void {
		// No-op for testing.
	}

	loadNavigationState() {
		return null;
	}

	saveNavigationState(): void {
		// No-op for testing.
	}

	isFullScreenSupported(): boolean {
		return false;
	}

	detectFullScreen(): FullScreenMode {
		return FullScreenMode.Undefined;
	}

	async setFullScreen(): Promise<boolean> {
		return Promise.resolve(false);
	}

	copyToClipboard(): void {
		// No-op for testing.
	}

	copyUriToClipboard(): void {
		// No-op for testing.
	}

	openLink(): void {
		// No-op for testing.
	}

	getSupportedAuthModes(): AuthorizationMode[] {
		return [];
	}

	getAuthToken(): string | null {
		return null;
	}

	async getAuthorizationData(): Promise<null> {
		return null;
	}

	getStorage(): { storageClient?: SIStorageClient; storageInfo?: SIStorageInfo; } {
		return {};
	}

	async getPackageData(): Promise<[File, string] | null> {
		return Promise.resolve(null);
	}

	exitApp(): void {
		// No-op for testing.
	}

	async clearGameLog(): Promise<boolean> {
		return Promise.resolve(true);
	}

	async addGameLog(): Promise<boolean> {
		return Promise.resolve(true);
	}

	async openGameLog(): Promise<boolean> {
		return Promise.resolve(true);
	}

	getPackageSource(): string | undefined {
		return undefined;
	}

	getAlternativePackageSource(): string | undefined {
		return undefined;
	}
}

async function buildPackage(): Promise<Buffer> {
	const zip = new JSZip();

	zip.file(
		'Images/pixel.png',
		Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
			'base64'
		)
	);

	zip.file('content.xml', `<?xml version="1.0" encoding="utf-8"?>
<package name="Пакет для теста" version="5">
	<rounds>
		<round name="Раунд 1">
			<themes>
				<theme name="Тема 1">
					<questions>
						<question price="100">
							<params>
								<param name="question" type="content">
									<item type="text" placement="screen">Первый вопрос</item>
									<item type="image" placement="screen" isRef="True">Images/pixel.png</item>
								</param>
							</params>
							<right><answer>Верный ответ</answer></right>
						</question>
						<question price="200">
							<params>
								<param name="question" type="content">
									<item type="text" placement="screen">Второй вопрос</item>
								</param>
							</params>
							<right><answer>Верный ответ</answer></right>
						</question>
					</questions>
				</theme>
			</themes>
		</round>
	</rounds>
</package>`);

	return zip.generateAsync({ type: 'nodebuffer' });
}

function waitFor(
	condition: () => boolean,
	timeout = 20000,
	interval = 50
): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();

		const check = () => {
			if (condition()) {
				resolve();
			} else if (Date.now() - startedAt > timeout) {
				reject(new Error('Timeout waiting for condition'));
			} else {
				setTimeout(check, interval);
			}
		};

		check();
	});
}

const shouldRun = process.env.RUN_LOCAL_SERVER_TEST === '1';

(shouldRun ? describe : describe.skip)('Local game server', () => {
	let server: any;
	let baseUrl = '';
	let store: any;
	let dataContext: DataContext;
	let hostClient: SIHostClient | null = null;
	let playedQuestions = 0;
	let lastPrice = 0;
	let answered = 0;

	jest.setTimeout(120000);

	beforeAll(async () => {
		const os = require('os');
		const path = require('path');
		const fs = require('fs');

		const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigame-local-test-'));

		server = new LocalGameServer({
			port: 0,
			host: '127.0.0.1',
			dataDir,
			log: (message: string) => {
				if (process.env.LOCAL_SERVER_TEST_VERBOSE) {
					console.log(`[server] ${message}`);
				}
			},
		});

		const port = await server.start();
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterAll(async () => {
		// Close the SignalR connections first: both clients are configured to
		// reconnect automatically and would keep the process alive otherwise.
		try {
			if (hostClient) {
				await hostClient.disconnectAsync();
			}

			if (dataContext) {
				await dataContext.gameClient.disconnect();
			}

			// The room connection is created lazily when a game is joined, and
			// GameClient owns it, so it is disconnected through its inner client.
			const gameClientHost = (dataContext?.game as unknown as {
				gameServerClient?: { disconnectAsync(): Promise<void> };
			} | undefined)?.gameServerClient;

			await gameClientHost?.disconnectAsync();
		} catch (error) {
			// Teardown is best effort.
		}

		if (server) {
			await server.stop();
		}
	});

	it('plays a game end-to-end through the real client code', async () => {
		const gameClient = new GameServerClient(baseUrl);
		hostClient = new SIHostClient();

		dataContext = {
			config: {
				siStatisticsServiceUri: '',
				appRegistryServiceUri: '',
				serverUri: baseUrl,
			},
			serverUri: baseUrl,
			gameClient,
			game: new GameClient(hostClient),
			contentUris: null,
			contentClients: [new SIContentClient({ serviceUri: baseUrl })],
			storageClients: [],
			host: new TestHost() as unknown as IHost,
		};

		store = createStore<State, AnyAction, Record<string, unknown>, Record<string, unknown>>(
			reducer,
			{ ...initialState },
			applyMiddleware(withExtraArgument(dataContext))
		);

		let lastActionAt = 0;
		let lastContentSignature = '';

		// In the browser the media is reported loaded by the content components.
		// Here there is no DOM, so the test plays their role: once the question
		// content reaches the store, MEDIALOADED is sent to the server.
		const reportMediaLoaded = () => {
			const { table } = store.getState();
			const signature = JSON.stringify(table.content || []);

			if (signature !== lastContentSignature && (table.content || []).length > 0) {
				lastContentSignature = signature;
				store.dispatch(onMediaLoaded() as unknown as Action);
				return true;
			}

			if ((table.content || []).length === 0) {
				lastContentSignature = '';
			}

			return false;
		};

		// Record-only subscriber. It must never dispatch: reactions that dispatch
		// re-enter the store and never settle.
		store.subscribe(() => {
			const state: State = store.getState();

			if (state.room2.stage.isGameStarted
				&& state.room.stage.currentPrice > 0
				&& state.room.stage.currentPrice !== lastPrice) {
				lastPrice = state.room.stage.currentPrice;
				playedQuestions += 1;
			}
		});

		// The player side is automated by polling the state, which keeps the
		// client in charge of the protocol (press, answer, choose).
		const driver = setInterval(() => {
			const state: State = store.getState();

			if (!state.room2.stage.isGameStarted) {
				return;
			}

			if (reportMediaLoaded()) {
				return;
			}

			if (process.env.LOCAL_SERVER_TEST_VERBOSE && Date.now() - lastActionAt > 1000) {
				process.stdout.write(
					`[client] stage=${state.room.stage.name} decision=${DecisionType[state.room2.stage.decisionType]}`
					+ ` canPress=${state.table.canPress} buttonEnabled=${state.room2.isGameButtonEnabled}`
					+ ` price=${state.room.stage.currentPrice} content=${(state.table.content || []).length}`
					+ ` sum=${state.room2.persons.players[0]?.sum}\n`
				);
			}

			if (Date.now() - lastActionAt < 300) {
				return;
			}

			if (state.room2.stage.decisionType === DecisionType.Choose) {
				const themeIndex = state.table.roundInfo.findIndex(
					(theme: any) => theme.questions.some((price: number) => price >= 0)
				);

				if (themeIndex >= 0) {
					const questionIndex = state.table.roundInfo[themeIndex].questions
						.findIndex((price: number) => price >= 0);

					store.dispatch(selectQuestion({ themeIndex, questionIndex }) as unknown as Action);
					lastActionAt = Date.now();
					return;
				}
			}

			if (state.table.canPress) {
				if (process.env.LOCAL_SERVER_TEST_VERBOSE) {
					process.stdout.write('[client] pressing\n');
				}

				store.dispatch(pressGameButton() as unknown as Action);

				if (process.env.LOCAL_SERVER_TEST_VERBOSE) {
					process.stdout.write('[client] press dispatched\n');
				}

				lastActionAt = Date.now();
				return;
			}

			if (state.room2.stage.decisionType === DecisionType.Answer) {
				answered += 1;

				if (process.env.LOCAL_SERVER_TEST_VERBOSE) {
					process.stdout.write('[client] answering\n');
				}

				store.dispatch(sendAnswer('Верный ответ') as unknown as Action);
				lastActionAt = Date.now();
			}
		}, 100);

		// Initialize the application without login/license dialogs.
		store.dispatch(actionCreators.initStageSkipLoginLicenseAsync(
			{ path: Path.Root } as INavigationState,
			store.dispatch
		) as unknown as Action);

		store.dispatch(changeLogin('Тестовый игрок'));
		store.dispatch(navigate({ navigation: { path: Path.Lobby }, saveState: false }) as unknown as Action);
		await waitFor(() => store.getState().ui.navigation.path === Path.Lobby, 15000);

		// The lobby must be connected to the local server through SignalR.
		expect(store.getState().common.isSIHostConnected).toBe(true);

		const packageBuffer = await buildPackage();
		const packageFile = new File([new Uint8Array(packageBuffer)], 'local-test.siq');

		store.dispatch(newGame());
		store.dispatch(setName('Тестовая игра'));
		store.dispatch(setRole(Role.Player));
		store.dispatch(setPlayersCount(1));
		store.dispatch(setPackageType(PackageType.File));
		store.dispatch(setPackageData({ name: 'local-test.siq', data: packageFile as unknown as File }));

		store.dispatch(onlineActionCreators.createNewGame(false, store.dispatch, 'Тестовый игрок') as unknown as Action);

		await waitFor(() => store.getState().ui.navigation.path === Path.Room, 30000);

		// The client must be in the room with the package name and its own seat.
		const roomState = store.getState();
		expect(roomState.room2.name).toBe('Тестовый игрок');
		expect(roomState.room2.persons.players.length).toBe(1);

		try {
			store.dispatch(startGame() as unknown as Action);

			// Round table with the package questions must reach the client.
			await waitFor(() => store.getState().room2.stage.isGameStarted, 20000);
			await waitFor(() => store.getState().table.roundInfo.length > 0, 20000);

			// Play at least one question: press the button, answer and get points.
			await waitFor(() => playedQuestions >= 1, 60000);
			await waitFor(() => store.getState().room2.persons.players[0].sum > 0, 30000);

			const finalState = store.getState();
			expect(finalState.room2.persons.players[0].sum).toBeGreaterThan(0);
			expect(answered).toBeGreaterThan(0);
			expect(finalState.room.stage.name).not.toBe(GameStage.Before);
		} finally {
			clearInterval(driver);
		}
	});
});
