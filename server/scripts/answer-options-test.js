/* eslint-disable no-console */
/**
 * Проверка вопроса с вариантами ответов (select): `LAYOUT ANSWER_OPTIONS`, показ вариантов A–D,
 * выбор варианта игроком и зачисление очков. Использует настоящую клиентскую библиотеку SignalR.
 *
 * Запуск: node server/scripts/answer-options-test.js http://localhost:8080
 */
const assert = require('assert');
const signalR = require('@microsoft/signalr');
const msgPack = require('@microsoft/signalr-protocol-msgpack');

const baseUrl = (process.argv[2] ?? process.env.SI_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const gameClient = '@';

const messages = [];
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

async function waitFor(prefix, timeout = 30000) {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeout) {
		const index = messages.findIndex(text => text.startsWith(prefix));

		if (index >= 0) {
			const [message] = messages.splice(index, 1);
			return message;
		}

		// eslint-disable-next-line no-await-in-loop
		await sleep(100);
	}

	throw new Error(`не дождались ${prefix}; получены: ${[...new Set(messages.map(text => text.split('\n')[0]))].join(', ')}`);
}

async function waitForSums(expected, timeout) {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeout) {
		const index = messages.findIndex(text => text.startsWith('SUMS') && text.split('\n')[1] === String(expected));

		if (index >= 0) {
			const [message] = messages.splice(index, 1);
			return message;
		}

		// eslint-disable-next-line no-await-in-loop
		await sleep(100);
	}

	throw new Error(`игроку не начислено ${expected}; SUMS: ${messages.filter(text => text.startsWith('SUMS')).join(' | ')}`);
}

async function main() {
	const created = await fetch(`${baseUrl}/api/v1/games/auto?player=${encodeURIComponent('Выбирающий')}`, { method: 'POST' })
		.then(response => response.json());

	assert.ok(created.isSuccess, 'автоматическая игра должна создаться');

	const connection = new signalR.HubConnectionBuilder()
		.withUrl(`${baseUrl}/sihost`)
		.withHubProtocol(new msgPack.MessagePackHubProtocol())
		.configureLogging(signalR.LogLevel.None)
		.build();

	connection.on('Receive', message => messages.push(message.Text ?? JSON.stringify(message)));

	const userName = 'Выбирающий';
	const send = text => connection.invoke('SendMessage', { Text: text, IsSystem: true, Sender: userName, Receiver: gameClient });

	await connection.start();

	assert.strictEqual(
		await connection.invoke('JoinGame2', { GameId: created.gameId, UserName: userName, Role: 'Player', Sex: 'Male', Pin: null }),
		'Success',
	);

	// The creator of an automatic game plays, it must not take the showman seat
	const info = await waitFor('CONNECTED');
	assert.ok(info.startsWith('CONNECTED\nplayer'), `игрок должен занять место игрока, получено: ${info}`);

	await send('READY\n+');
	await waitFor('CHOOSE', 40000);

	const table = (await waitFor('TABLO2')).split('\n').slice(1);
	console.log(`  table: ${table.filter(cell => cell).join(', ')}`);

	// The "Ответы" theme holds the only question with answer options
	const questionIndex = 0;
	const hasOptionsTheme = messages.some(text => text.startsWith('THEME\nОтветы'));

	if (!hasOptionsTheme) {
		await connection.stop();
		console.log('\nAnswer options test skipped: the default package has no options question.');
		return;
	}

	await send(`CHOICE\n1\n${questionIndex}`);

	const layout = await waitFor('LAYOUT', 10000);
	const layoutArgs = layout.split('\n');

	assert.strictEqual(layoutArgs[1], 'ANSWER_OPTIONS', 'клиент должен получить раскладку с вариантами ответов');
	console.log(`  layout: ${layoutArgs[2]} + ${layoutArgs.length - 3} варианта ответа`);
	assert.strictEqual(layoutArgs.length - 3, 4, 'должно быть 4 варианта ответа');

	// The screen content comes first, then the four options in the selected order
	await waitFor('CONTENT2', 10000);

	const optionMessages = [];

	for (let index = 0; index < 4; index += 1) {
		// eslint-disable-next-line no-await-in-loop
		optionMessages.push(await waitFor('CONTENT2', 10000));
	}

	const options = optionMessages.map(text => text.split('\n'));

	options.forEach(option => {
		assert.strictEqual(option[1], 'screen', 'варианты показываются в общем экране');
		assert.ok(option[3].length === 1, `у варианта должна быть метка A–D, получено: ${option[3]}`);
	});

	console.log(`  options: ${options.map(option => `${option[3]}=${option[6]}`).join(', ')}`);

	await waitFor('TRY', 20000);
	await send('I\n100');
	await waitFor('ENDTRY', 10000);
	await waitFor('ANSWER', 10000);

	// The player picks the option by its label
	await send('ANSWER\nA');

	const rightAnswer = await waitFor('RIGHTANSWER', 10000);

	assert.strictEqual(rightAnswer.split('\n')[2], 'A', 'сервер должен отметить правильный вариант ответа');

	// Sums are broadcast with every circle of the game, so the awarded sum is checked on the player
	const sums = await waitForSums(100, 10000);
	console.log(`  right answer: ${rightAnswer.split('\n').slice(1).join(' ')}`);
	console.log(`  sums: ${sums.split('\n').slice(1).join(', ')}`);

	await waitFor('QUESTION_END', 10000);
	await connection.stop();
	console.log('\nAnswer options test passed.');
}

main().catch(error => {
	console.error('\nAnswer options test failed:');
	console.error(error);
	process.exit(1);
});
