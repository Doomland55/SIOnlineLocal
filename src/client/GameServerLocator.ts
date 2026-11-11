import ServerInfo from './contracts/ServerInfo';
import localization from '../model/resources/localization';

// This is a backup server discovery URI. If the main one fails, we can try this one.
const alternativeServerDiscoveryUri = 'https://server2.vladimirkhil.com/api/si/servers/';

async function getServerInfoFromUri(serverDiscoveryUri: string): Promise<ServerInfo> {
	// Using random number to prevent serverUri caching
	const serverUrisResponse = await fetch(`${serverDiscoveryUri}?r=${Math.random()}`); // throwing TypeError here is ok

	if (!serverUrisResponse.ok) {
		throw new Error(localization.formatString(
			localization.serverDiscoveryBroken,
			serverUrisResponse.status.toString(),
			await serverUrisResponse.text()) as string);
	}

	const serverUris = (await serverUrisResponse.json()) as ServerInfo[];

	if (!serverUris || serverUris.length === 0) {
		throw new Error(localization.serverUrisBroken);
	}

	return serverUris[0];
}

/** Whether the discovery uri points to the same origin (a local server). */
function isLocalDiscoveryUri(uri: string): boolean {
	return !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(uri);
}

/**
 * Retrieves the game server address.
 *
 * A relative discovery uri means the client is served by a local server
 * (see server/cli.js): in that case only that server is used, so the client can
 * never silently fall back to a public server when the local one is down.
 * Absolute uris keep the previous behaviour with the well-known backup server.
 */
export default async function getServerInfo(serverDiscoveryUri: string): Promise<ServerInfo> {
	if (isLocalDiscoveryUri(serverDiscoveryUri)) {
		return await getServerInfoFromUri(serverDiscoveryUri);
	}

	try {
		return await getServerInfoFromUri(serverDiscoveryUri);
	} catch (primaryError) {
		if (serverDiscoveryUri === alternativeServerDiscoveryUri) {
			throw primaryError;
		}

		try {
			return await getServerInfoFromUri(alternativeServerDiscoveryUri);
		} catch (alternativeError) {
			const alternativeMessage = alternativeError instanceof Error ? alternativeError.message : String(alternativeError);
			const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
			const errorMessage = localization.formatString(
				localization.serverDiscoveryDoubleError,
				alternativeServerDiscoveryUri,
				alternativeMessage,
				serverDiscoveryUri,
				primaryMessage
			) as string;

			throw new Error(errorMessage);
		}
	}
}
