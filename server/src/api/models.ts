/** Models of the SIGame server REST API and lobby hub. */

/** Game stages reported by the lobby. */
export type LobbyGameStage = 'Created' | 'Started' | 'Round' | 'Final' | 'Finished';

/** Game types reported by the lobby. */
export type LobbyGameMode = 'Tv' | 'Sport' | 'Quiz' | 'TurnTaking';

/** Person info inside a game list item. */
export interface PersonInfoModel {
	IsOnline: boolean;
	Name: string;
	Role: 'Viewer' | 'Player' | 'Showman';
}

/** Game info as seen by the lobby. Field names are PascalCase because of the server protocol. */
export interface GameInfoModel {
	HostUri: string;
	GameID: number;
	GameName: string;
	Language: string;
	Mode: LobbyGameMode;
	Owner: string;
	PackageName: string;
	PasswordRequired: boolean;
	Persons: PersonInfoModel[];
	ProgressCurrent: number;
	ProgressTotal: number;
	RealStartTime: string;
	Rules: string;
	Stage: LobbyGameStage;
	StageName: string;
	Started: boolean;
	StartTime: string;
}

/** Slice of lobby games. */
export interface SliceModel<T> {
	Data: T[];
	IsLastSlice: boolean;
}

/** Result codes of a game creation. */
export const enum GameCreationResultCode {
	Ok = 0,
	NoPackage = 1,
	TooMuchGames = 2,
	ServerUnderMaintainance = 3,
	BadPackage = 4,
	GameNameCollision = 5,
	InternalServerError = 6,
	ServerNotReady = 7,
	YourClientIsObsolete = 8,
	UnknownError = 9,
	JoinError = 10,
	WrongGameSettings = 11,
	TooManyGamesByAddress = 12,
}

/** Result of a game run request. */
export interface RunGameResponseModel {
	isSuccess: boolean;
	hostUri: string;
	gameId: number;
	isHost: boolean;
	errorType: GameCreationResultCode;
}

/** Content service info. */
export interface SIContentInfoModel {
	serviceUri: string;
	region: string;
}

/** Storage service info. */
export interface SIStorageInfoModel {
	id: string;
	serviceUri: string;
	name: string;
	randomPackagesSupported: boolean;
	identifiersSupported: boolean;
	maximumPageSize: number;
	uri: string;
	packageProperties: string[];
	facets: string[];
	limitedApi?: boolean;
	emptyMessage?: string;
}

/** Server info. */
export interface HostInfoModel {
	name: string;
	host: string;
	siHosts: Record<string, string>;
	port: number;
	contentPublicBaseUrls: string[] | null;
	license: string;
	maxPackageSizeMb: number;
	contentInfos: SIContentInfoModel[];
	storageInfos: SIStorageInfoModel[];
}

/** Package descriptor sent by the web client when a game is created. */
export interface PackageInfoModel {
	type: number;
	uri: string;
	contentServiceUri: string | null;
	secret: string | null;
	source: string | null;
}

/** Account settings of a person. */
export interface AccountSettingsModel {
	name: string;
	isHuman?: boolean;
	isMale?: boolean;
}

/** Game settings sent by the web client. */
export interface GameSettingsModel {
	humanPlayerName: string;
	networkGameName: string;
	networkGamePassword: string;
	networkVoiceChat: string;
	isPrivate: boolean;
	allowViewers: boolean;
	showman: AccountSettingsModel;
	players: AccountSettingsModel[];
	viewers: AccountSettingsModel[];
	appSettings?: {
		readingSpeed?: number;
		timeSettings?: Record<string, number>;
		culture?: string;
		useApellations?: boolean;
		playAllQuestionsInFinalRound?: boolean;
		[key: string]: unknown;
	};
}

/** Game run request. */
export interface RunGameRequestModel {
	gameSettings: GameSettingsModel;
	packageInfo: PackageInfoModel;
	computerAccounts: unknown[];
}

/** Automatic game run request. */
export interface RunAutoGameRequestModel {
	culture: string;
}

/** Game by pin response. */
export interface GameByPinResponseModel {
	hostUri: string;
	gameId: number;
}

/** Join game request. */
export interface JoinGameRequestModel {
	GameId: number;
	UserName: string;
	Role: 'Viewer' | 'Player' | 'Showman';
	Sex: 'Male' | 'Female';
	AuthorizationMode?: string;
	Password?: string | null;
	Pin?: number | null;
}

/** Join game results. */
export const JoinGameResult = {
	Success: 'Success',
	InvalidRole: 'InvalidRole',
	InvalidUserName: 'InvalidUserName',
	GameNotFound: 'GameNotFound',
	InternalServerError: 'InternalServerError',
	Forbidden: 'Forbidden',
	CommonJoinError: 'CommonJoinError',
	WrongPassword: 'WrongPassword',
	NameIsOccupied: 'NameIsOccupied',
	ForbiddenRole: 'ForbiddenRole',
	NoFreePlace: 'FreePlaceNotFound',
} as const;

export type JoinGameResultValue = typeof JoinGameResult[keyof typeof JoinGameResult];

/** Message transferred through the `sihost` hub. */
export interface MessageModel {
	IsSystem: boolean;
	Sender: string;
	Receiver?: string;
	Text: string;
}
