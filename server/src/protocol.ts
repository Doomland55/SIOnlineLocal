/**
 * Primitives of the SIGame client protocol.
 *
 * The web client receives game state as newline (or custom separator) separated string commands
 * that are delivered inside `Message` objects over the `sihost` hub. This module contains
 * the message names and helpers to build those strings.
 */

/** Separator used between message arguments. */
export const ARGS_SEPARATOR = '\n';

/** Names of the messages that the server sends to the web client. */
export const GameMessage = {
	Answer: 'ANSWER',
	AnswerDeviation: 'ANSWER_DEVIATION',
	Answers: 'ANSWERS',
	AskReview: 'ASK_REVIEW',
	AskSelectPlayer: 'ASK_SELECT_PLAYER',
	AskStake: 'ASK_STAKE',
	AskValidate: 'ASK_VALIDATE',
	AtomHint: 'ATOM_HINT',
	Avatar: 'AVATAR',
	Banned: 'BANNED',
	BannedList: 'BANNEDLIST',
	Cancel: 'CANCEL',
	Choice: 'CHOICE',
	Choose: 'CHOOSE',
	Config: 'CONFIG',
	Connected: 'CONNECTED',
	Content: 'CONTENT',
	Content2: 'CONTENT2',
	ContentAppend: 'CONTENT_APPEND',
	ContentShape: 'CONTENT_SHAPE',
	ContentState: 'CONTENT_STATE',
	Disconnected: 'DISCONNECTED',
	EndTry: 'ENDTRY',
	FinalThink: 'FINALTHINK',
	GameClosed: 'GAME_CLOSED',
	GameError: 'GAME_ERROR',
	GameMetadata: 'GAMEMETADATA',
	GameStatistics: 'GAME_STATISTICS',
	GameThemes: 'GAMETHEMES',
	HostName: 'HOSTNAME',
	Info: 'INFO2',
	Layout: 'LAYOUT',
	Leaderboard: 'LEADERBOARD',
	MediaLoaded: 'MEDIALOADED',
	MediaPreloaded: 'MEDIA_PRELOADED',
	MediaPreloadProgress: 'MEDIA_PRELOAD_PROGRESS',
	Options2: 'OPTIONS2',
	OralAnswer: 'ORAL_ANSWER',
	Out: 'OUT',
	Package: 'PACKAGE',
	PackageAuthors: 'PACKAGE_AUTHORS',
	PackageComments: 'PACKAGE_COMMENTS',
	PackageDate: 'PACKAGE_DATE',
	PackageRestrictions: 'PACKAGE_RESTRICTIONS',
	PackageSources: 'PACKAGE_SOURCES',
	Pass: 'PASS',
	Pause: 'PAUSE',
	Person: 'PERSON',
	PersonFinalAnswer: 'PERSONFINALANSWER',
	PersonFinalStake: 'PERSONFINALSTAKE',
	PersonStake: 'PERSONSTAKE',
	Pin: 'PIN',
	PlayerAnswer: 'PLAYER_ANSWER',
	PlayerAppellating: 'PLAYER_APPELLATING',
	PlayerCount: 'PLAYER_COUNT',
	PlayerScoreChanged: 'PLAYER_SCORE_CHANGED',
	PlayerState: 'PLAYER_STATE',
	QType: 'QTYPE',
	Question: 'QUESTION',
	QuestionAnswers: 'QUESTION_ANSWERS',
	QuestionAuthors: 'QUESTION_AUTHORS',
	QuestionCaption: 'QUESTIONCAPTION',
	QuestionComments: 'QUESTION_COMMENTS',
	QuestionEnd: 'QUESTION_END',
	QuestionPriceRange: 'QUESTION_PRICE_RANGE',
	QuestionSources: 'QUESTION_SOURCES',
	Ready: 'READY',
	Replic: 'REPLIC',
	Resume: 'RESUME',
	RightAnswer: 'RIGHTANSWER',
	RightAnswerStart: 'RIGHT_ANSWER_START',
	RoundAuthors: 'ROUND_AUTHORS',
	RoundComments: 'ROUND_COMMENTS',
	RoundContent: 'ROUNDCONTENT',
	RoundEnd: 'ROUND_END',
	RoundsNames: 'ROUNDSNAMES',
	RoundSources: 'ROUND_SOURCES',
	RoundThemes2: 'ROUND_THEMES2',
	RoundThemesComments: 'ROUND_THEMES_COMMENTS',
	SetChooser: 'SETCHOOSER',
	SetJoinMode: 'SETJOINMODE',
	ShowmanComments: 'SHOWMAN_COMMENTS',
	ShowmanReplic: 'SHOWMAN_REPLIC',
	ShowTable: 'SHOWTABLO',
	Stage: 'STAGE',
	StageInfo: 'STAGE_INFO',
	Stop: 'STOP',
	Sums: 'SUMS',
	Table: 'TABLO2',
	Theme: 'THEME',
	ThemeComments: 'THEME_COMMENTS',
	ThemeInfo: 'THEME_INFO',
	Timer: 'TIMER',
	TimerGameStart: 'TIMER_GAME_START',
	Toggle: 'TOGGLE',
	Try: 'TRY',
	UserError: 'USER_ERROR',
	Validation2: 'VALIDATION2',
	Winner: 'WINNER',
} as const;

/** Names of the messages the server receives from the web client. */
export const ClientMessage = {
	Answer: 'ANSWER',
	AnswerVersion: 'ANSWER_VERSION',
	Apellate: 'APELLATE',
	Atom: 'ATOM',
	Avatar: 'AVATAR',
	Ban: 'BAN',
	Change: 'CHANGE',
	Choice: 'CHOICE',
	Config: 'CONFIG',
	Delete: 'DELETE',
	I: 'I',
	Info: 'INFO',
	IsRight: 'ISRIGHT',
	Leaderboard: 'LEADERBOARD',
	Mark: 'MARK',
	MediaLoaded: 'MEDIALOADED',
	MediaPreloadProgress: 'MEDIA_PRELOAD_PROGRESS',
	Move: 'MOVE',
	Moveable: 'MOVEABLE',
	Pass: 'PASS',
	Pause: 'PAUSE',
	Pin: 'PIN',
	Ready: 'READY',
	Report: 'REPORT',
	SelectPlayer: 'SELECT_PLAYER',
	SetChooser: 'SETCHOOSER',
	SetHost: 'SETHOST',
	SetJoinMode: 'SETJOINMODE',
	SetOptions: 'SET_OPTIONS',
	SetStake: 'SET_STAKE',
	Start: 'START',
	Toggle: 'TOGGLE',
	Unban: 'UNBAN',
	Validate: 'VALIDATE',
} as const;

/** Game stages reported in the `STAGE` message. */
export const GameStage = {
	Before: 'Before',
	Begin: 'Begin',
	Round: 'Round',
	After: 'After',
} as const;

export type GameStageValue = typeof GameStage[keyof typeof GameStage];

/** Game module column names used in package relative media urls. */
export const MediaCategory = {
	audio: 'Audio',
	video: 'Video',
	html: 'Html',
	image: 'Images',
} as const;

/** Builds a protocol message from its name and arguments. */
export function buildMessage(name: string, ...args: unknown[]): string {
	if (args.length === 0) {
		return name;
	}

	return [name, ...args.map(arg => (arg === null || arg === undefined ? '' : String(arg)))].join(ARGS_SEPARATOR);
}

/** Escapes text so that it could be transferred as a single protocol argument. */
export function escapeNewLines(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
}

/** Marker used by the client to replace with the real content host. */
export const SERVER_HOST_PLACEHOLDER = '<SERVERHOST>';
