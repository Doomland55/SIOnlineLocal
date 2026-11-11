/* eslint-disable no-console */
/**
 * Проверка сервера настоящей клиентской библиотекой `@microsoft/signalr` с MessagePack-протоколом —
 * той же, что использует веб-клиент в браузере. В отличие от `smoke-test.js` (самописный msgpack-клиент),
 * этот скрипт ловит несовместимости с реальным SignalR-клиентом: negotiate, кадры, типы аргументов,
 * keep-alive, переподключение после разрыва связи.
 *
 * Запуск: node server/scripts/signalr-client-test.js http://localhost:8080
 */
const assert = require('assert');
const signalR = require('@microsoft/signalr');
const msgPack = require('@microsoft/signalr-protocol-msgpack');

const baseUrl = (process.argv[2] ?? process.env.SI_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const gameClient = '@';
const everyone = '*';

const received = [];
const chat = [];

function createConnection() {
	const connection = new signalR.HubConnectionBuilder()
		.withUrl(`${baseUrl}/sihost`)
		.withHubProtocol(new msgPack.MessagePackHubProtocol())
		.configureLogging(signalR.LogLevel.Error)
		.build();

	connection.on('Receive', message => {
		received.push(message.Text ?? JSON.stringify(message));

		if (message.IsSystem === false) {
			chat.push(message);
		}
	});

	return connection;
}

async function waitFor(prefix, timeout = 30000) {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeout) {
		const message = received.find(text => text.startsWith(prefix));

		if (message) {
			received.splice(received.indexOf(message), 1);
			return message;
		}

		// eslint-disable-next-line no-await-in-loop
		await new Promise(resolve => { setTimeout(resolve, 100); });
	}

	throw new Error(`не дождались ${prefix}; получены: ${received.map(text => text.split('\n')[0]).join(', ')}`);
}

async function sendMessage(connection, text, receiver = gameClient, userName = '', isSystem = true) {
	return connection.invoke('SendMessage', {
		Text: text,
		IsSystem: isSystem,
		Sender: userName,
		Receiver: receiver,
	});
}

async function main() {
	const autoGame = await fetch(`${baseUrl}/api/v1/games/auto?player=${encodeURIComponent('Хозяин')}`, { method: 'POST' })
		.then(response => response.json());

	assert.ok(autoGame.isSuccess, 'автоматическая игра должна создаться');
	console.log(`  automatic game: #${autoGame.gameId}`);

	const gameId = autoGame.gameId;
	const userName = `SignalR ${Date.now() % 100000}`;
	let connection = createConnection();

	await connection.start();
	console.log('  connected to sihost');

	// The same call the client makes after connecting to a game server
	const info = await connection.invoke('TryGetGameInfo', gameId);
	assert.ok(info, 'TryGetGameInfo должен вернуть игру');
	console.log(`  TryGetGameInfo: #${info.GameID ?? info.gameId} «${info.GameName ?? info.gameName}»`);

	const joinRequest = {
		GameId: gameId,
		UserName: userName,
		Role: 'Player',
		Sex: 'Male',
		Pin: null,
	};

	const joinResult = await connection.invoke('JoinGame2', joinRequest);
	assert.strictEqual(joinResult, 'Success', `JoinGame2 должен вернуть Success, получено ${joinResult}`);
	console.log('  JoinGame2: Success');

	const metadata = await waitFor('GAMEMETADATA');
	assert.ok(metadata.includes(userName) === false, 'в GAMEMETADATA передаётся игра и пакет');

	const hostName = (await waitFor('HOSTNAME')).split('\n')[1];
	assert.strictEqual(hostName, userName, 'живой игрок автоматической игры должен получить права ведущего');
	console.log(`  HOSTNAME: ${hostName} (права на управление игрой)`);

	await waitFor('INFO2');
	console.log('  INFO2 received');

	await sendMessage(connection, 'READY\n+', gameClient, userName);
	await waitFor('STAGE\nBegin');
	console.log('  READY -> game started');

	await waitFor('ROUNDSNAMES');
	const roundContent = await waitFor('ROUNDCONTENT');
	console.log('  round table received');

	// Media preloading goes through the same http server that serves the client
	const mediaUri = roundContent.split('\n').slice(1).find(uri => uri.startsWith('http'));

	if (mediaUri) {
		const mediaResponse = await fetch(mediaUri);

		assert.strictEqual(mediaResponse.status, 200, `медиа ${mediaUri} должно быть доступно`);
		console.log(`  media downloadable: ${mediaUri} (${(await mediaResponse.arrayBuffer()).byteLength} B)`);
	}

	// Pausing requires management rights: the only human player must have them even though the showman is a bot
	await sendMessage(connection, 'PAUSE\n+', gameClient, userName);
	await waitFor('PAUSE\n+');
	console.log('  PAUSE forwarded');

	await sendMessage(connection, 'PAUSE\n-', gameClient, userName);
	await waitFor('PAUSE\n-');
	console.log('  RESUME forwarded');

	// Chat is delivered through the same `Receive` callback with `IsSystem = false`
	// Chat messages are the ones with `IsSystem = false`
	await sendMessage(connection, 'Привет из теста', everyone, userName, false);
	await new Promise(resolve => { setTimeout(resolve, 500); });
	assert.strictEqual(chat[0]?.Text, 'Привет из теста', 'чат должен дойти до игрока');
	console.log('  chat delivered');

	// Moving to the next round is what the "next" button of the side panel does
	await sendMessage(connection, 'MOVE\n1', gameClient, userName);
	await waitFor('STAGE\nRound');
	console.log('  MOVE -> next round');

	// The pin code is shown to the host so that other players could join
	await sendMessage(connection, 'PIN', gameClient, userName);
	const pin = await waitFor('PIN');
	assert.ok(settingsNumber(pin) >= 100000, 'пин должен быть шестизначным');
	console.log(`  PIN: ${settingsNumber(pin)}`);

	// A reload of the page reconnects with the same name and must get the full state back
	await connection.stop();
	received.length = 0;
	connection = createConnection();
	await connection.start();

	const reconnectResult = await connection.invoke('JoinGame2', joinRequest);
	assert.strictEqual(reconnectResult, 'Success', 'переподключение должно вернуть Success');
	await waitFor('GAMEMETADATA');
	await waitFor('STAGE\nRound');
	console.log('  reconnect -> full state restored');

	await connection.stop();
	console.log('\nSignalR client test passed.');
}

function settingsNumber(message) {
	return parseInt(message.split('\n')[1], 10);
}

main().catch(error => {
	console.error('\nSignalR client test failed:');
	console.error(error);
	process.exit(1);
});
