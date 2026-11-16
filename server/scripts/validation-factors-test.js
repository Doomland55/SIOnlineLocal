/* eslint-disable no-console */
/**
 * Проверка оценок ведущего и правил вопросов на живом сервере.
 *
 * 1. Устная игра: ведущий получает `ASK_VALIDATE` с пустым ответом и `+`, а `VALIDATE` с коэффициентом
 *    `0.5` / `2` начисляет половину или двойную цену вопроса (и снимает её при неправильном ответе).
 * 2. Вопрос с вариантами ответов проверяется сервером: игрок получает `ANSWER select`, ведущий не получает
 *    `ASK_VALIDATE`, а выбор варианта сразу начисляет очки.
 * 3. Если ведущий выходит из игры, все получают `PAUSE +`, игра замирает, а после возвращения ведущего
 *    приходит `PAUSE -`.
 *
 * Запуск: node server/scripts/validation-factors-test.js http://localhost:8080
 */
const assert = require('assert');
const signalR = require('@microsoft/signalr');
const msgPack = require('@microsoft/signalr-protocol-msgpack');

const baseUrl = (process.argv[2] ?? process.env.SI_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const gameClient = '@';

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

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

async function join(gameId, userName, role) {
	const client = await connect();

	assert.strictEqual(
		await client.connection.invoke('JoinGame2', { GameId: gameId, UserName: userName, Role: role, Sex: 'Male', Pin: null }),
		'Success',
		`${userName} должен присоединиться как ${role}`,
	);

	return client;
}

/** Starts a game with a live showman and one player. */
async function createGame(showmanName, playerName) {
	const created = await fetch(`${baseUrl}/api/v1/games/auto?player=${encodeURIComponent(showmanName)}`, { method: 'POST' })
		.then(response => response.json());

	assert.ok(created.isSuccess, 'игра должна создаться');

	const showman = await join(created.gameId, showmanName, 'Showman');
	await waitFor(showman.messages, text => text.startsWith('CONNECTED'), 15000, 'подключения ведущего');

	const player = await join(created.gameId, playerName, 'Player');
	await waitFor(player.messages, text => text.startsWith('CONNECTED'), 15000, 'подключения игрока');

	await showman.send('SET_OPTIONS\nOral\ntrue');
	await waitFor(player.messages, text => text.startsWith('OPTIONS2') && text.includes('Oral'), 15000, 'включения устной игры');

	await player.send('READY\n+');
	await waitFor(showman.messages, text => text.startsWith('CHOOSE'), 40000, 'выбора вопроса');
	await waitFor(player.messages, text => text.startsWith('TABLO2'), 20000, 'таблицы');

	return { gameId: created.gameId, showman, player };
}

async function main() {
	// 1. The host halves and doubles the price of a spoken answer
	{
		const { showman, player } = await createGame('Ведущий1', 'Игрок1');

		await showman.send('CHOICE\n0\n0');
		await waitFor(player.messages, text => text === 'TRY', 30000, 'фазы нажатия кнопки');
		await player.send('I\n0');

		const ask = await waitFor(showman.messages, text => text.startsWith('ASK_VALIDATE'), 20000, 'проверки устного ответа');
		assert.strictEqual(ask, 'ASK_VALIDATE\n0\n\n+', 'ведущему должны прийти все шесть решений');
		console.log('  oral game: the host gets the full set of decisions');

		await showman.send('VALIDATE\n\n+\n0.5');
		const half = await waitFor(player.messages, text => text.startsWith('PERSON\n+'), 20000, 'половины цены');
		assert.strictEqual(half, 'PERSON\n+\n0\n50', `половина цены вопроса не начислена: ${half}`);
		console.log('  ×0.5 awards a half of the question price');

		await waitFor(player.messages, text => text.startsWith('QUESTION_END'), 30000, 'окончания вопроса');
		await showman.connection.stop();
		await player.connection.stop();
	}

	// 2. A question with answer options is checked by the server itself
	{
		const { showman, player } = await createGame('Ведущий2', 'Игрок2');

		// The "Ответы" theme holds the only question with answer options
		await showman.send('CHOICE\n1\n0');
		await waitFor(player.messages, text => text.startsWith('LAYOUT') && text.includes('ANSWER_OPTIONS'), 20000, 'раскладки вариантов');
		await waitFor(player.messages, text => text === 'TRY', 30000, 'фазы нажатия кнопки');

		await player.send('I\n0');
		const ask = await waitFor(player.messages, text => text.startsWith('ANSWER'), 20000, 'запроса варианта ответа');
		assert.strictEqual(ask, 'ANSWER\nselect', 'игрок должен выбрать вариант, а не печатать ответ');
		assert.ok(!showman.messages.some(text => text.startsWith('ASK_VALIDATE')), 'ведущий не должен оценивать вариант');

		await player.send('ANSWER\nA');
		const right = await waitFor(player.messages, text => text.startsWith('RIGHTANSWER'), 20000, 'правильного ответа');
		assert.ok(right.length > 0, 'правильный вариант должен быть показан');
		const award = await waitFor(player.messages, text => text.startsWith('PERSON\n+'), 20000, 'начисления очков за вариант');
		assert.ok(award.length > 0, 'очки за верный вариант должны начисляться сервером');
		console.log('  answer options: the server awards the right option without the host');

		await showman.connection.stop();
		await player.connection.stop();
	}

	// 3. The game is paused when the host leaves and resumed when the host is back
	{
		const { gameId, showman, player } = await createGame('Ведущий3', 'Игрок3');

		await showman.send('CHOICE\n0\n0');
		await waitFor(player.messages, text => text === 'TRY', 30000, 'фазы нажатия кнопки');

		await showman.connection.stop();
		const pause = await waitFor(player.messages, text => text.startsWith('PAUSE'), 20000, 'паузы после выхода ведущего');
		assert.strictEqual(pause.split('\n')[1], '+', `игра должна встать на паузу: ${pause}`);
		console.log('  the game is paused when the host leaves');

		const again = await join(gameId, 'Ведущий3', 'Showman');
		const resume = await waitFor(player.messages, text => text.startsWith('PAUSE'), 20000, 'возобновления после возвращения ведущего');
		assert.strictEqual(resume.split('\n')[1], '-', `игра должна продолжиться: ${resume}`);
		console.log('  the game is resumed when the host is back');

		await again.connection.stop();
		await player.connection.stop();
	}

	console.log('\nValidation factors test passed.');
}

main().catch(error => {
	console.error('\nValidation factors test failed:');
	console.error(error);
	process.exit(1);
});
