/* eslint-disable no-console */
/**
 * Проверка правил игры в середине партии и поведения раунда (живой ведущий + живые игроки).
 *
 * 1. Правила, изменённые ведущим во время игры (`SET_OPTIONS`), применяются и рассылаются всем:
 *    игрок тоже получает `OPTIONS2`; имя `TimeForBlockingButton` доходит до клиента как известное
 *    ему `ButtonBlocking`.
 * 2. Устная игра (`Oral`): после нажатия ведущий видит ответ пакета и сразу оценивает устный ответ;
 *    поле ввода игроку не отправляется.
 * 3. Если все игроки нажали «пас», вопрос завершается и показывается правильный ответ.
 * 4. Таблица раунда сохраняет исходную размерность: сыгранные вопросы скрываются (цена -1),
 *    темы не исчезают из `ROUND_THEMES2` / `THEME` / `TABLO2`.
 * 5. Аватар, отправленный игроком, рассылается остальным участникам.
 *
 * Запуск: node server/scripts/midgame-rules-test.js http://localhost:8080
 */
const assert = require('assert');
const signalR = require('@microsoft/signalr');
const msgPack = require('@microsoft/signalr-protocol-msgpack');

const baseUrl = (process.argv[2] ?? process.env.SI_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const gameClient = '@';

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

/** Client with a collected list of incoming game messages. */
async function connect(userName) {
	const messages = [];
	const connection = new signalR.HubConnectionBuilder()
		.withUrl(`${baseUrl}/sihost`)
		.withHubProtocol(new msgPack.MessagePackHubProtocol())
		.configureLogging(signalR.LogLevel.None)
		.build();

	connection.on('Receive', message => messages.push(message.Text ?? JSON.stringify(message)));
	await connection.start();

	const send = text => connection.invoke('SendMessage', { Text: text, IsSystem: true, Sender: userName, Receiver: gameClient });

	return { connection, messages, send, userName };
}

async function waitFor(messages, predicate, timeout = 25000, description = '') {
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

/** Creates a game with a live showman and the given live player seats. */
async function createGame(showmanName, playerNames, appSettings = {}) {
	const packages = await fetch(`${baseUrl}/api/v1/packages`).then(response => response.json());

	assert.ok(packages.length > 0, 'в библиотеке должен быть хотя бы один пакет');

	const created = await fetch(`${baseUrl}/api/v1/games`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			gameSettings: {
				humanPlayerName: showmanName,
				networkGameName: `Проверка ${Date.now() % 100000}`,
				networkGamePassword: '',
				networkVoiceChat: '',
				isPrivate: false,
				allowViewers: true,
				showman: { name: showmanName, isHuman: true },
				players: playerNames.map(name => ({ name, isHuman: true })),
				viewers: [],
				appSettings: { readingSpeed: 20, timeSettings: {}, ...appSettings },
			},
			packageInfo: { type: 1, uri: packages[0].uri, contentServiceUri: null, secret: null, source: null },
			computerAccounts: [],
		}),
	}).then(response => response.json());

	assert.ok(created.isSuccess, `игра должна создаться: ${JSON.stringify(created)}`);
	return created.gameId;
}

async function join(client, gameId, role) {
	assert.strictEqual(
		await client.connection.invoke('JoinGame2', {
			GameId: gameId,
			UserName: client.userName,
			Role: role,
			Sex: 'Male',
			Pin: null,
		}),
		'Success',
		`вход ${client.userName} должен пройти успешно`,
	);
}

/** Joins as the showman, starts the game and waits for the round table. */
async function startGame(host, gameId) {
	await join(host, gameId, 'Showman');
	await host.send('START');
	await waitFor(host.messages, text => text.startsWith('STAGE') && text.includes('Round'), 25000, 'начала раунда');
}

/** Joins as a player and lets the game start. */
async function joinPlayer(player, gameId) {
	await join(player, gameId, 'Player');
	await player.send('READY\n+');
}

/**
 * The question of the round table is selected and the game starts playing it.
 * The right to choose belongs to a player (the chooser), the showman only sees the table.
 */
async function playQuestion(host, player, themeIndex, questionIndex) {
	await player.send(`CHOICE\n${themeIndex}\n${questionIndex}`);

	try {
		await waitFor(player.messages, text => text.startsWith('QUESTION\n'), 6000, 'вопроса от игрока');
		return;
	} catch {
		// The chooser is not the player this time (e.g. the server has no chooser set yet)
	}

	await host.send(`CHOICE\n${themeIndex}\n${questionIndex}`);
	await waitFor(player.messages, text => text.startsWith('QUESTION\n'), 25000, 'вопроса от ведущего');
}

async function main() {
	const showmanName = 'Ведущий';
	const playerName = 'Игрок';
	const gameId = await createGame(showmanName, [playerName], { oral: true, falseStart: true, readingSpeed: 33, timeSettings: { partialImageTime: 7 } });

	const host = await connect(showmanName);
	const player = await connect(playerName);

	try {
		await startGame(host, gameId);
		await joinPlayer(player, gameId);

		// Creation rules are sent through the real REST + SignalR path to late joiners.
		const initial = await waitFor(player.messages, text => text.startsWith('OPTIONS2') && text.includes('Oral'), 15000, 'начальных правил');
		for (const pair of ['Oral\ntrue', 'FalseStart\ntrue', 'ReadingSpeed\n33', 'PartialImage\n7']) {
			assert.ok(initial.includes(pair), `начальное правило ${pair} отсутствует: ${initial}`);
		}
		console.log('  initial game rules reach the joined player');

		// 1. Rules changed during the game reach every participant under the names the client knows
		player.messages.length = 0;
		await host.send('SET_OPTIONS\nOral\ntrue');
		const oral = await waitFor(player.messages, text => text.startsWith('OPTIONS2') && text.includes('Oral'), 15000, 'правила Oral у игрока');
		assert.ok(oral.includes('\nВедущий\nOral\ntrue'), `правило не дошло до игрока: ${oral}`);

		player.messages.length = 0;
		await host.send('SET_OPTIONS\nTimeForBlockingButton\n7');
		const blocking = await waitFor(player.messages, text => text.startsWith('OPTIONS2'), 15000, 'времени блокировки кнопки');
		assert.ok(blocking.includes('\nButtonBlocking\n7'), `время блокировки кнопки пришло под неизвестным клиенту именем: ${blocking}`);
		console.log('  rules changed in the middle of the game reach every client');

		// 2. The player speaks; the host sees the solution and judges immediately after the press.
		player.messages.length = 0;
		host.messages.length = 0;
		await playQuestion(host, player, 0, 0);
		await waitFor(player.messages, text => text === 'TRY', 25000, 'фазы нажатия кнопки');
		const answers = await waitFor(host.messages, text => text.startsWith('QUESTION_ANSWERS\n'), 15000, 'правильных ответов ведущему');
		assert.ok(answers.includes('\n4'), `ведущий должен видеть правильный ответ: ${answers}`);
		assert.ok(!player.messages.some(text => text.startsWith('QUESTION_ANSWERS\n')), 'ответ не должен утечь игроку');
		await player.send('I\n0');
		const askValidate = await waitFor(host.messages, text => text.startsWith('ASK_VALIDATE'), 20000, 'проверки устного ответа');
		assert.strictEqual(askValidate, 'ASK_VALIDATE\n0\n\n-');
		assert.ok(!player.messages.some(text => text.startsWith('ANSWER\n')), 'поле ответа не должно появляться');
		assert.ok(!player.messages.some(text => text.startsWith('PERSON\n')), 'очки до проверки не начисляются');
		await host.send('VALIDATE\n\n+\n1');
		await waitFor(player.messages, text => text.startsWith('PERSON\n+'), 20000, 'присуждения очка после проверки');
		console.log('  oral game: host sees answer and decides immediately; player has no text input');

		await host.send('SET_OPTIONS\nOral\nfalse');
		await waitFor(host.messages, text => text.startsWith('OPTIONS2') && text.includes('Oral'), 15000, 'выключения устной игры');

		// 3. All players pass: the question is finished
		await waitFor(host.messages, text => text.startsWith('QUESTION_END'), 25000, 'окончания вопроса');
		player.messages.length = 0;
		host.messages.length = 0;
		await waitFor(host.messages, text => text === 'CHOOSE\n1', 25000, 'выбора вопроса ведущим');
		await host.send('CHOICE\n0\n1');
		await waitFor(player.messages, text => text.startsWith('QUESTION\n'), 25000, 'вопроса, выбранного ведущим');
		await waitFor(player.messages, text => text === 'TRY', 25000, 'фазы нажатия кнопки');

		player.messages.length = 0;
		await player.send('PASS');
		await waitFor(player.messages, text => text.startsWith('RIGHTANSWER'), 25000, 'правильного ответа после паса');
		console.log('  all players passed -> question finished');

		// 4. The table keeps its shape: the played question is hidden, the theme stays in place
		const table = await waitFor(host.messages, text => text.startsWith('TABLO2'), 20000, 'таблицы раунда');
		const tableValues = table.split('\n').slice(1);
		const themeCount = tableValues.filter(value => value.length === 0).length;

		assert.strictEqual(themeCount, 3, `в таблице должно остаться 3 темы, получено: ${table}`);
		assert.ok(tableValues.includes('-1'), `сыгранный вопрос должен скрываться ценой -1: ${table}`);
		console.log(`  table keeps ${themeCount} themes, played questions are hidden with -1`);
	} finally {
		await host.connection.stop();
		await player.connection.stop();
	}

	// 5. Avatars are relayed to the other participants
	const avatarGameId = await createGame('АватарныйВедущий', ['АватарныйИгрок']);
	const avatarHost = await connect('АватарныйВедущий');
	const avatarPlayer = await connect('АватарныйИгрок');
	const lateViewer = await connect('ПозднийЗритель');

	try {
		await join(avatarHost, avatarGameId, 'Showman');
		await join(avatarPlayer, avatarGameId, 'Player');

		avatarHost.messages.length = 0;
		await avatarPlayer.send('AVATAR\nimage\ndata:image/png;base64,iVBORw0KGgo=');

		const avatar = await waitFor(avatarHost.messages, text => text.startsWith('AVATAR'), 15000, 'аватара другого участника');
		assert.strictEqual(avatar, 'AVATAR\nАватарныйИгрок\nimage\ndata:image/png;base64,iVBORw0KGgo=');
		await join(lateViewer, avatarGameId, 'Viewer');
		const existingAvatar = await waitFor(lateViewer.messages, text => text.startsWith('AVATAR\nАватарныйИгрок\n'), 15000, 'аватара для нового участника');
		assert.strictEqual(existingAvatar, avatar);
		console.log('  avatar is relayed and restored for a late joiner');
	} finally {
		await avatarHost.connection.stop();
		await avatarPlayer.connection.stop();
		await lateViewer.connection.stop();
	}

	console.log('Midgame rules test passed.');
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
