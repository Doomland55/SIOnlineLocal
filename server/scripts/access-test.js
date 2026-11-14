/* eslint-disable no-console */
/** Checks REST-created access settings through the SignalR join endpoint. */
const assert = require('assert');
const signalR = require('@microsoft/signalr');
const msgPack = require('@microsoft/signalr-protocol-msgpack');

const baseUrl = (process.argv[2] ?? process.env.SI_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');

async function main() {
	const packages = await fetch(`${baseUrl}/api/v1/packages`).then(response => response.json());
	assert.ok(packages.length);
	const created = await fetch(`${baseUrl}/api/v1/games`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			gameSettings: {
				humanPlayerName: 'Host', networkGameName: 'Access test', networkGamePassword: 'secret',
				networkVoiceChat: '', isPrivate: false, allowViewers: false,
				showman: { name: 'Host', isHuman: true }, players: [{ name: 'Player', isHuman: true }],
				viewers: [], appSettings: { timeSettings: {} },
			},
			packageInfo: { type: 1, uri: packages[0].uri, contentServiceUri: null, secret: null, source: null },
			computerAccounts: [],
		}),
	}).then(response => response.json());
	assert.ok(created.isSuccess, JSON.stringify(created));

	const connection = new signalR.HubConnectionBuilder().withUrl(`${baseUrl}/sihost`)
		.withHubProtocol(new msgPack.MessagePackHubProtocol()).configureLogging(signalR.LogLevel.None).build();
	await connection.start();
	try {
		const info = await connection.invoke('TryGetGameInfo', created.gameId);
		assert.strictEqual(info.PasswordRequired, true);
		const request = { GameId: created.gameId, UserName: 'Player', Role: 'Player', Sex: 'Male' };
		assert.strictEqual(await connection.invoke('JoinGame2', { ...request, Password: 'wrong' }), 'WrongPassword');
		assert.strictEqual(await connection.invoke('JoinGame2', { ...request, Role: 'Viewer', Password: 'secret' }), 'ForbiddenRole');
		assert.strictEqual(await connection.invoke('JoinGame2', { ...request, Password: 'secret' }), 'Success');
		console.log('Access settings test passed.');
	} finally {
		await connection.stop();
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
