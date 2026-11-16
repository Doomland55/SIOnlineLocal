/** Defines an automatic game run request. */
export default interface RunAutoGameRequest {
	/** Game culture. */
	culture: string;

	/** Name of the player who starts the game. The server falls back to a generated one when it is missing. */
	playerName?: string;
}