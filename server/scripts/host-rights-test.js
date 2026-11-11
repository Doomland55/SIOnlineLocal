/* eslint-disable no-console */
/**
 * Проверка прав управляющего игрой и синхронизации выходов.
 *
 * 1. Управляющим считается живой игрок, а не серверная заглушка ведущего: клиент получает
 *    `HOSTNAME` с именем этого игрока (иначе он не покажет правила и переходы по раундам).
 * 2. Правила игры, отправленные управляющим (`SET_OPTIONS`), принимаются и рассылаются
 *    остальным в виде `OPTIONS2`.
 * 3. Переход к произвольному раунду (`MOVE 3 <index>`) выполняется управляющим.
 * 4. После выхода игрока остальные получают `DISCONNECTED` с его именем.
 *
 * Запуск: node server/scripts/host-rights-test.js http://localhost:8080
 */
const assert = require('assert');
const signalR = require('@microsoft/signalr');
const msgPack = require('@microsoft/signalr-protocol-msgpack');

const baseUrl = (process.argv[2] ?? process.env.SI_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const gameClient = '@';

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

/** Client with a collected list of incoming game messages. */
async function connect() {
	const messages = [];
	const connection = new signalR.HubConnectionBuilder()
		.withUrl(`${baseUrl}/sihost`)
		.withHubProtocol(new msgPack.MessagePackHubProtocol())
		.configureLogging(signalR.LogLevel.None)
		.build();

	connection.on('Receive', message => messages.push(message.Text ?? JSON.stringify(message)));
	await connection.start();

	const send = text => connection.invoke('SendMessage', { Text: text, IsSystem: true, Sender: connection.userName, Receiver: gameClient });

	return { connection, messages, send };
}

async function waitFor(messages, predicate, timeout = 20000, description = '') {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeout) {
		const index = messages.findIndex(predicate);

		if (index >= 0) {
			const [message] = messages.splice(index, 1);
			return message;
		}

		// eslint-disable-next-line no-await-in-loop
		await sleep(100);
	}

	throw new Error(`не дождались ${description}; получены: ${[...new Set(messages.map(text => text.split('\n')[0]))].join(', ')}`);
}

async function main() {
	const created = await fetch(`${baseUrl}/api/v1/games/auto?player=${encodeURIComponent('Хозяин')}`, { method: 'POST' })
		.then(response => response.json());

	assert.ok(created.isSuccess, 'автоматическая игра должна создаться');

	const host = await connect();
	host.connection.userName = 'Хозяин';

	assert.strictEqual(
		await host.connection.invoke('JoinGame2', { GameId: created.gameId, UserName: 'Хозяин', Role: 'Player', Sex: 'Male', Pin: null }),
		'Success',
	);

	// 1. The live player is the manager, the server showman placeholder is not
	const hostName = await waitFor(
		host.messages,
		text => text.startsWith('HOSTNAME'),
		15000,
		'HOSTNAME',
	);

	assert.strictEqual(hostName.split('\n')[1], 'Хозяин', `управляющим должен быть живой игрок, получено: ${hostName}`);

	// 2. Game rules are accepted from the manager and are broadcast to everybody
	host.messages.length = 0;
	await host.send('SET_OPTIONS\nOral\ntrue');

	const option = await waitFor(
		host.messages,
		text => text.startsWith('OPTIONS2') && text.includes('Oral'),
		10000,
		'OPTIONS2 для Oral',
	);

	assert.deepStrictEqual(option.split('\n').slice(1), ['Хозяин', 'Oral', 'true'], `некорректное подтверждение правила: ${option}`);

	// 3. The manager can jump to any round
	host.messages.length = 0;
	await host.send('SET_OPTIONS\nReadingSpeed\n25');
	const readingSpeed = await waitFor(host.messages, text => text.startsWith('OPTIONS2') && text.includes('ReadingSpeed'), 10000, 'OPTIONS2 для ReadingSpeed');
	assert.strictEqual(readingSpeed.split('\n')[3], '25', `скорость чтения не применилась: ${readingSpeed}`);

	await host.send('READY\n+');
	await waitFor(host.messages, text => text.startsWith('TABLO2') || text.startsWith('THEME'), 20000, 'начала раунда');

	host.messages.length = 0;
	await host.send('MOVE\n3\n1');
	const roundNames = await waitFor(
		host.messages,
		text => text.startsWith('ROUNDSNAMES') && text.split('\n').length > 2,
		15000,
		'перехода к раунду 1',
	);

	assert.ok(roundNames.split('\n').length > 2, `раунд не переключился: ${roundNames}`);

	// 4. Leaving the game is visible to the other clients
	const other = await connect();
	other.connection.userName = 'Гость';

	assert.strictEqual(
		await other.connection.invoke('JoinGame2', { GameId: created.gameId, UserName: 'Гость', Role: 'Viewer', Sex: 'Female', Pin: null }),
		'Success',
	);

	// A viewer must see the host in the room
	const persons = await waitFor(other.messages, text => text.startsWith('INFO2'), 15000, 'INFO2');
	assert.ok(persons.includes('Хозяин'), `гость не видит участника, получено: ${persons}`);

	other.messages.length = 0;
	await host.connection.stop();

	const disconnected = await waitFor(other.messages, text => text.startsWith('DISCONNECTED'), 15000, 'DISCONNECTED');
	assert.strictEqual(disconnected, 'DISCONNECTED\nХозяин', `некорректное сообщение о выходе: ${disconnected}`);

	// The remaining clients get fresh scores and ready flags of the seats that are left
	await waitFor(other.messages, text => text.startsWith('SUMS'), 15000, 'обновлённых SUMS');

	// The freed seat could be taken by another player, even in the middle of the game
	const newcomer = await connect();
	newcomer.connection.userName = 'Новый';

	assert.strictEqual(
		await newcomer.connection.invoke('JoinGame2', { GameId: created.gameId, UserName: 'Новый', Role: 'Player', Sex: 'Female', Pin: null }),
		'Success',
		'освободившееся место должно быть доступно другому игроку',
	);

	await newcomer.connection.stop();
	await other.connection.stop();
	console.log('Host rights test passed.');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
