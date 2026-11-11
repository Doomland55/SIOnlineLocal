import SIContentClient, { SIContentServiceError } from 'sicontent-client';
import SIStorageClient from 'sistorage-client';
import DataContext from '../model/DataContext';
import State from '../state/State';
import { AppDispatch } from '../state/store';
import { getFullCulture } from '../utils/StateHelpers';
import SIStorageInfo from '../client/contracts/SIStorageInfo';
import {
	computerAccountsChanged,
	serverInfoChanged,
	avatarLoadEnd,
	avatarLoadStart,
	userErrorChanged,
	avatarLoadError,
	setProxyAvailable } from '../state/commonSlice';
import { setStorages } from '../state/siPackagesSlice';
import Constants from '../model/enums/Constants';
import getServerInfo from '../client/GameServerLocator';
import getErrorMessage from '../utils/ErrorHelpers';
import { changeAvatar } from '../state/userSlice';
import WellKnownSIContentServiceErrorCode from 'sicontent-client/dist/models/WellKnownSIContentServiceErrorCode';
import localization from '../model/resources/localization';

function createStorageClientFromInfo(storageInfo: SIStorageInfo): SIStorageClient {
	return new SIStorageClient({
		serviceUri: storageInfo.serviceUri,
	});
}

async function uploadAvatarAsync(appDispatch: AppDispatch, dataContext: DataContext) {
	if (typeof localStorage === 'undefined') {
		return;
	}

	const base64 = localStorage.getItem(Constants.AVATAR_KEY);
	const fileName = localStorage.getItem(Constants.AVATAR_NAME_KEY);

	if (!base64 || !fileName) {
		return;
	}

	try {
		appDispatch(avatarLoadStart());

		const bin = window.atob(base64);
		const buffer = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) {
			buffer[i] = bin.charCodeAt(i);
		}

		const { contentClients } = dataContext;

		if (!contentClients || contentClients.length === 0) {
			console.log('No SIContent service available for avatar upload');
			appDispatch(avatarLoadEnd());
			return;
		}

		const contentIndex = Math.floor(Math.random() * contentClients.length);
		const contentClient = contentClients[contentIndex];

		const avatarUri2 = await contentClient.uploadAvatarIfNotExistAsync(fileName, new Blob([buffer]));

		const fullAvatarUri2 = avatarUri2.startsWith('/')
			? contentClient.options.serviceUri + avatarUri2.substring(1)
			: avatarUri2;

		appDispatch(avatarLoadEnd());
		appDispatch(changeAvatar(fullAvatarUri2));
	} catch (err) {
		const errorMessage = getErrorMessage(err);

		const userError = (err as SIContentServiceError).errorCode === WellKnownSIContentServiceErrorCode.FileTooLarge
			? localization.fileIsTooBig
			: errorMessage;

		appDispatch(userErrorChanged(localization.avatarLoadError + ': ' + userError) as any);
		appDispatch(avatarLoadError(errorMessage));
	}
}

async function loadHostInfoAsync(appDispatch: AppDispatch, dataContext: DataContext, culture: string) {
	const [hostInfo, computerAccounts] = await Promise.all([
		dataContext.gameClient.getGameHostInfoAsync(culture),
		dataContext.gameClient.getComputerAccountsAsync(culture)
	]);

	// eslint-disable-next-line no-param-reassign
	dataContext.contentUris = hostInfo.contentPublicBaseUrls;

	const { contentInfos } = hostInfo;
	let storageInfos = hostInfo.storageInfos || [];

	if (storageInfos.length === 0 && culture !== 'en-US') {
		try {
			const englishHostInfo = await dataContext.gameClient.getGameHostInfoAsync('en-US');
			storageInfos = englishHostInfo.storageInfos || [];
		} catch (e) {
			console.warn('Failed to fetch English host info for storages', e);
		}
	}

	if (contentInfos && contentInfos.length > 0) {
		dataContext.contentClients = contentInfos.map(info => new SIContentClient({
			serviceUri: info.serviceUri,
		}));
	} else {
		throw new Error('No SIContent service found');
	}

	await initializeStoragesAsync(appDispatch, dataContext, storageInfos);

	appDispatch(serverInfoChanged({
		serverName: hostInfo.name,
		serverLicense: hostInfo.license,
		maxPackageSizeMb: hostInfo.maxPackageSizeMb,
		siHosts: hostInfo.siHosts,
	}));

	appDispatch(computerAccountsChanged(computerAccounts));

	if (typeof localStorage !== 'undefined') {
		localStorage.setItem(Constants.LICENSE_TEXT_KEY, hostInfo.license);
	}
}

async function initializeStoragesAsync(appDispatch: AppDispatch, dataContext: DataContext, serverStorageInfos: SIStorageInfo[]) {
	const storageInfos = [...serverStorageInfos];

	const storageClients = storageInfos.map(createStorageClientFromInfo);

	const hostStorage = dataContext.host.getStorage();

	if (hostStorage && hostStorage.storageClient && hostStorage.storageInfo) {
		storageClients.push(hostStorage.storageClient);
		storageInfos.push(hostStorage.storageInfo);
	}

	dataContext.storageClients = storageClients;
	appDispatch(setStorages(storageInfos));
}

const SAME_ORIGIN_PROBE_TIMEOUT_MS = 3000;

/**
 * Detects a SIGame server served from the same origin as the client.
 *
 * A locally started server hosts both the web client and the API, so players
 * just open http://<host>:<port>/ in a browser and must be connected to that
 * very server instead of the ones from the public discovery list.
 */
async function hasSameOriginGameServerAsync(): Promise<boolean> {
	if (typeof window === 'undefined' || typeof fetch === 'undefined') {
		return false;
	}

	const abortController = new AbortController();
	const timeoutId = globalThis.setTimeout(() => abortController.abort(), SAME_ORIGIN_PROBE_TIMEOUT_MS);

	try {
		const response = await fetch('/api/v1/info/host', {
			signal: abortController.signal,
			headers: { Accept: 'application/json' },
		});

		if (!response.ok) {
			return false;
		}

		// Single page application servers answer unknown paths with index.html,
		// so the content type is what tells a real game server apart.
		return (response.headers.get('content-type') || '').includes('json');
	} catch {
		return false;
	} finally {
		globalThis.clearTimeout(timeoutId);
	}
}

let serverInfoPromise: Promise<void> | null = null;

export function ensureServerInfoLoadedAsync(
	appDispatch: AppDispatch,
	getState: () => State,
	dataContext: DataContext
): Promise<void> {
	if (!serverInfoPromise) {
		serverInfoPromise = loadServerInfoAsync(appDispatch, getState, dataContext);
	}

	return serverInfoPromise;
}

async function loadServerInfoAsync(
	appDispatch: AppDispatch,
	getState: () => State,
	dataContext: DataContext
) {
	const state = getState();

	// Pre-initialize storages with an empty list to ensure that host-provided storages
	// (like Steam Workshop) are available even before server info is loaded or in offline mode.
	if (!dataContext.storageClients || dataContext.storageClients.length === 0) {
		await initializeStoragesAsync(appDispatch, dataContext, []);
	}

	const { serverDiscoveryUri, serverUri: configuredServerUri } = dataContext.config;

	// An explicit server uri skips the discovery step entirely (used by the
	// local server and by custom deployments).
	if (configuredServerUri) {
		const uri = configuredServerUri.replace(/\/+$/, '');
		dataContext.serverUri = uri;
		dataContext.gameClient.setServerUri(uri);
		appDispatch(setProxyAvailable(false));
	} else if (await hasSameOriginGameServerAsync()) {
		// Served by a local server: keep using the current origin.
		dataContext.serverUri = '';
		dataContext.gameClient.setServerUri('');
		appDispatch(setProxyAvailable(false));
	} else if (serverDiscoveryUri) {
		try {
			const { uri, proxyUri: serverProxyUri } = await getServerInfo(serverDiscoveryUri);
			dataContext.serverUri = uri;
			dataContext.proxyUri = serverProxyUri;
			dataContext.gameClient.setServerUri(uri);
			appDispatch(setProxyAvailable(!!serverProxyUri));
		} catch (error) {
			console.error('Failed to fetch server info: ' + getErrorMessage(error));
		}
	}

	// Empty dataContext.serverUri URI could also be fine (means window uri)

	const requestCulture = getFullCulture(state);

	await loadHostInfoAsync(appDispatch, dataContext, requestCulture);
	await uploadAvatarAsync(appDispatch, dataContext);
}
