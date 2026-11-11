/* eslint-disable no-console */
/**
 * Проверка мест и ролей в лобби. Ловит две типовые проблемы локального сервера:
 *
 * 1. в игре оказывалось фиксированно 6 столов, даже если при создании указали 3 игрока;
 * 2. свободные места не были видны в лобби (кнопка «подключиться игроком» неактивна),
 *    а место ведущего было занято заглушкой, поэтому вход ведущим отклонялся.
 *
 * Запуск: node server/scripts/seats-test.js http://localhost:8080
 */
const assert = require('assert');
const signalR = require('@microsoft/signalr');
const msgPack = require('@microsoft/signalr-protocol-msgpack');

const baseUrl = (process.argv[2] ?? process.env.SI_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const ANY_NAME = ' ';

function createConnection() {
	const connection = new signalR.HubConnectionBuilder()
		.withUrl(`${baseUrl}/sihost`)
		.withHubProtocol(new msgPack.MessagePackHubProtocol())
		.configureLogging(signalR.LogLevel.None)
		.build();

	connection.on('Receive', () => { });

	return connection;
}

async function getGame(gameId) {
	const connection = new signalR.HubConnectionBuilder()
		.withUrl(`${baseUrl}/sionline`)
		.withHubProtocol(new msgPack.MessagePackHubProtocol())
		.configureLogging(signalR.LogLevel.None)
		.build();

	await connection.start();

	try {
		const slice = await connection.invoke('GetGamesSlice', 0);
		const game = slice.Data.find(item => item.GameID === gameId);

		assert.ok(game, `игра #${gameId} должна быть в лобби`);

		return game;
	} finally {
		await connection.stop();
	}
}

async function main() {
	// Создаём игру так же, как это делает веб-клиент: три живых места и один бот
	const created = await fetch(`${baseUrl}/api/v1/games`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			gameSettings: {
				humanPlayerName: 'Игрок 1',
				networkGameName: 'Проверка мест',
				showman: { name: ANY_NAME, isHuman: true },
				players: [
					{ name: 'Игрок 1', isHuman: true },
					{ name: ANY_NAME, isHuman: true },
					{ name: ANY_NAME, isHuman: true },
					{ name: 'Иннокентий', isHuman: false },
				],
				viewers: [],
				appSettings: { timeSettings: {} },
			},
			packageInfo: {
				type: 1,
				uri: '/packages/test-package.siq',
				contentServiceUri: null,
				secret: null,
				source: null,
			},
			computerAccounts: [],
		}),
	}).then(response => response.json());

	assert.ok(created.isSuccess, `игра должна создаться: ${JSON.stringify(created)}`);
	console.log(`  game #${created.gameId} created`);

	const game = await getGame(created.gameId);
	const playerSeats = game.Persons.filter(person => person.Role === 'Player');

	assert.ok(game.Persons.length < 7, `в игре не должно быть фиксированных 6 столов: ${JSON.stringify(game.Persons)}`);
	assert.ok(playerSeats.length >= 3, 'все указанные игроки должны получить место');

	const freeSeats = game.Persons.filter(person => !person.IsOnline);

	assert.ok(
		freeSeats.some(person => person.Role === 'Player'),
		`в лобби должно быть видно свободное место игрока: ${JSON.stringify(game.Persons)}`,
	);
	assert.ok(
		freeSeats.some(person => person.Role === 'Showman'),
		`место ведущего должно быть доступно, пока его не занял живой игрок: ${JSON.stringify(game.Persons)}`,
	);

	console.log(`  seats: ${game.Persons.map(person => `${person.Role}${person.IsOnline ? '*' : ''}`).join(', ')}`);

	// Вход на место ведущего и на свободное место игрока
	const showmanConnection = createConnection();
	const playerConnection = createConnection();

	await showmanConnection.start();
	await playerConnection.start();

	const join = (connection, userName, role) => connection.invoke('JoinGame2', {
		GameId: created.gameId,
		UserName: userName,
		Role: role,
		Sex: 'Male',
		Pin: null,
	});

	assert.strictEqual(await join(showmanConnection, 'Живой ведущий', 'Showman'), 'Success', 'вход ведущим должен работать');
	assert.strictEqual(await join(playerConnection, 'Второй игрок', 'Player'), 'Success', 'вход игроком должен работать');
	console.log('  join as showman: Success, join as player: Success');

	const afterJoin = await getGame(created.gameId);

	assert.ok(
		afterJoin.Persons.some(person => person.Name === 'Живой ведущий' && person.IsOnline),
		'ведущий должен быть отмечен онлайн',
	);
	assert.ok(
		afterJoin.Persons.some(person => person.Name === 'Второй игрок' && person.IsOnline),
		'второй игрок должен быть отмечен онлайн',
	);

	// Занятое место больше нельзя взять другим именем
	const thirdConnection = createConnection();

	await thirdConnection.start();
	assert.strictEqual(
		await join(thirdConnection, 'Третий ведущий', 'Showman'),
		'ForbiddenRole',
		'занятое место ведущего должно быть недоступно',
	);
	console.log('  occupied showman seat is protected');

	await thirdConnection.stop();
	await playerConnection.stop();
	await showmanConnection.stop();
	console.log('\nSeats test passed.');
}

main().catch(error => {
	console.error('\nSeats test failed:');
	console.error(error);
	process.exit(1);
});
