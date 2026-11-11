'use strict';

/**
 * End-to-end smoke test for the local server.
 *
 * Starts a real server instance, uploads a generated .siq package through the
 * SIContent API, creates a game, joins it with three SignalR clients
 * (showman + two players) and plays a full question: press, answer, validation,
 * scores. It also checks media streaming (HTTP Range) and the mid-question
 * snapshot for a joining client.
 *
 * Run with: node server/test/smoke.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');
const { LocalGameServer } = require('../src/server');
const { encodeValue, decodeValue } = require('../src/msgpack');

const RECORD_SEPARATOR = '\u001e';

function encodeVarint(value) {
	const bytes = [];
	let remaining = value;

	do {
		let byte = remaining & 0x7f;
		remaining = Math.floor(remaining / 128);
		if (remaining > 0) {
			byte |= 0x80;
		}
		bytes.push(byte);
	} while (remaining > 0);

	return Buffer.from(bytes);
}

function frame(message) {
	const payload = encodeValue(message);
	return Buffer.concat([encodeVarint(payload.length), payload]);
}

function delay(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Minimal SignalR MessagePack client (mirrors what @microsoft/signalr does). */
class TestClient {
	constructor(baseUrl, name) {
		this.baseUrl = baseUrl;
		this.name = name;
		this.messages = [];
		this.chat = [];
		this.waiters = [];
		this.nextInvocationId = 1;
		this.pendingInvocations = new Map();
		this.autoMediaLoaded = true;
	}

	async connect(hub = 'sihost') {
		const negotiateUrl = `${this.baseUrl}/${hub}/negotiate?negotiateVersion=1`;
		const response = await fetch(negotiateUrl, { method: 'POST' });
		assert.strictEqual(response.status, 200, 'negotiate must succeed');

		const negotiation = await response.json();
		assert.ok(negotiation.connectionToken, 'negotiate must return a token');

		const wsUrl = `${this.baseUrl.replace('http://', 'ws://')}/${hub}/connect?id=${negotiation.connectionToken}`;
		this.ws = new WebSocket(wsUrl);
		this.ws.binaryType = 'arraybuffer';

		await new Promise((resolve, reject) => {
			this.ws.onopen = () => resolve();
			this.ws.onerror = event => reject(new Error(`WebSocket error: ${event.message || 'unknown'}`));
		});

		this.ws.onmessage = event => {
			if (typeof event.data === 'string') {
				// SignalR handshake response: {} + record separator.
				if (event.data.includes('{}') && this.onHandshake) {
					this.onHandshake();
				}
				return;
			}

			const buffer = Buffer.from(event.data);

			// The binary transfer format sends the handshake reply as a binary frame too.
			if (!this.handshakeDone && buffer.toString('utf8').startsWith('{}\u001e')) {
				this.handshakeDone = true;
				if (this.onHandshake) {
					this.onHandshake();
				}
				return;
			}

			this.handshakeDone = true;
			this.onData(buffer);
		};

		// SignalR handshake.
		const handshakeResponse = new Promise(resolve => {
			this.onHandshake = resolve;
		});

		this.ws.send(`{"protocol":"messagepack","version":1}${RECORD_SEPARATOR}`);
		await withTimeout(handshakeResponse, 5000, 'handshake');

		return this;
	}

	onData(buffer) {
		let offset = 0;

		while (offset < buffer.length) {
			let length = 0;
			let shift = 0;
			let byte;

			do {
				byte = buffer[offset++];
				length += (byte & 0x7f) * (2 ** shift);
				shift += 7;
			} while (byte & 0x80);

			const { value } = decodeValue(buffer.subarray(offset, offset + length));
			offset += length;

			this.onMessage(value);
		}
	}

	onMessage(message) {
		const type = message[0];

		if (type === 1) {
			// [1, headers, invocationId, target, arguments]
			const target = message[3];
			const args = message[4] || [];

			if (target === 'Receive') {
				const message = args[0] || {};
				const text = message.Text;

				if (typeof text !== 'string') {
					return;
				}

				if (message.IsSystem === false) {
					this.chat.push({ sender: message.Sender, text });
				} else {
					this.onSystemMessage(text);
				}
			}

			return;
		}

		if (type === 3) {
			// [3, headers, invocationId, resultKind, resultOrError]
			const invocationId = message[2];
			const resultKind = message[3];
			const completion = this.pendingInvocations.get(invocationId);

			if (completion) {
				this.pendingInvocations.delete(invocationId);

				if (resultKind === 3) {
					completion.resolve(message[4]);
				} else if (resultKind === 1) {
					completion.reject(new Error(String(message[4])));
				} else {
					completion.resolve(undefined);
				}
			}
		}
	}

	onSystemMessage(text) {
		this.messages.push(text);

		// Emulate the web client: report media as loaded when the content arrives.
		if (this.autoMediaLoaded && text.startsWith('CONTENT2')) {
			const hasMedia = /\n(image|audio|video|html)\n/.test(text);
			if (hasMedia) {
				setTimeout(() => {
					this.send('MEDIALOADED');
				}, 30);
			}
		}

		for (const waiter of [...this.waiters]) {
			if (waiter.predicate(text)) {
				this.waiters.splice(this.waiters.indexOf(waiter), 1);
				waiter.resolve(text);
			}
		}
	}

	invoke(target, ...args) {
		const invocationId = String(this.nextInvocationId++);

		return new Promise((resolve, reject) => {
			this.pendingInvocations.set(invocationId, { resolve, reject });
			this.ws.send(frame([1, {}, invocationId, target, args]));
		});
	}

	send(text) {
		this.ws.send(frame([1, {}, null, 'SendMessage', [{ Text: text, IsSystem: true, Sender: this.name, Receiver: '@' }]]));
	}

	/** Remembers the position of the last message (see waitFor's `from`). */
	mark() {
		return this.messages.length;
	}

	waitFor(predicate, timeoutMs = 5000, description = 'message', from = 0) {
		const existing = this.messages.slice(from).find(predicate);

		if (existing) {
			return Promise.resolve(existing);
		}

		const offset = from - this.messages.length;
		const adjusted = from > 0
			? text => this.messages.length > from && predicate(text)
			: predicate;

		return withTimeout(new Promise(resolve => {
			this.waiters.push({ predicate: adjusted, resolve });
		}), timeoutMs, `${this.name}: ${description}`);
	}

	waitForStart(prefix, timeoutMs = 5000, from = 0) {
		return this.waitFor(text => text.split('\n')[0] === prefix, timeoutMs, `message ${prefix}`, from);
	}

	close() {
		try {
			this.ws.close();
		} catch {
			// ignore
		}
	}
}

function withTimeout(promise, timeoutMs, description) {
	return Promise.race([
		promise,
		delay(timeoutMs).then(() => {
			throw new Error(`Timeout while waiting for ${description}`);
		}),
	]);
}

async function buildPackage() {
	const zip = new JSZip();

	// 1x1 transparent PNG.
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
		'base64'
	);

	zip.file('Images/pixel.png', png);

	// Real packages reference media names in a different letter case, with
	// spaces and cyrillic letters. The server must find such files anyway.
	zip.file('Images/Логотип пака.png', png);

	zip.file('content.xml', `<?xml version="1.0" encoding="utf-8"?>
<package name="Тестовый пакет" version="5" id="1" date="2024-01-01" publisher="local" language="ru" logo="images/ЛОГОТИП ПАКА.png">
	<info>
		<authors><author>Локальный сервер</author></authors>
		<sources><source>Автотест</source></sources>
	</info>
	<rounds>
		<round name="Первый раунд">
			<themes>
				<theme name="Тема A">
					<questions>
						<question price="100">
							<params>
								<param name="question" type="content">
									<item type="text" placement="screen">Простой вопрос с картинкой</item>
									<item type="image" placement="screen" isRef="True">Images/pixel.png</item>
								</param>
								<param name="answer" type="content">
									<item type="text" placement="screen">Правильный ответ</item>
								</param>
							</params>
							<right><answer>Правильный ответ</answer></right>
						</question>
						<question price="200">
							<params>
								<param name="question" type="content">
									<item type="text" placement="screen">Вопрос без медиа</item>
								</param>
							</params>
							<right><answer>Ответ номер два</answer></right>
						</question>
					</questions>
				</theme>
				<theme name="Тема Б">
					<questions>
						<question price="300">
							<params>
								<param name="question" type="content">
									<item type="text" placement="screen">Третий вопрос</item>
								</param>
							</params>
							<right><answer>Третий ответ</answer></right>
						</question>
						<question price="400">
							<params>
								<param name="question" type="content">
									<item type="text" placement="screen">Четвёртый вопрос</item>
								</param>
							</params>
							<right><answer>Четвёртый ответ</answer></right>
						</question>
					</questions>
				</theme>
			</themes>
		</round>
	</rounds>
</package>`);

	return zip.generateAsync({ type: 'nodebuffer' });
}

async function uploadPackage(baseUrl, buffer) {
	const form = new FormData();
	form.append('file', new Blob([buffer]), 'test.siq');

	const response = await fetch(`${baseUrl}/api/v1/content/packages`, {
		method: 'POST',
		body: form,
		headers: { 'Content-MD5': 'test' },
	});

	assert.strictEqual(response.status, 200, `upload must succeed, got ${response.status}`);
	return (await response.text()).trim();
}

async function createGame(baseUrl, packageUri) {
	const gameSettings = {
		humanPlayerName: 'Ведущий',
		networkGameName: 'Локальный тест',
		networkGamePassword: '',
		networkVoiceChat: '',
		isPrivate: false,
		allowViewers: true,
		showman: { name: 'Ведущий', isHuman: true, isMale: true },
		// The web client sends placeholders for free seats (Constants.ANY_NAME = ' ').
		players: [
			{ name: ' ', isHuman: true, isMale: true },
			{ name: ' ', isHuman: true, isMale: false },
		],
		viewers: [],
		appSettings: {
			culture: 'ru-RU',
			timeSettings: {
				timeForChoosingQuestion: 30,
				timeForThinkingOnQuestion: 3,
				timeForPrintingAnswer: 10,
				timeForGivingACat: 30,
				timeForMakingStake: 10,
				timeForThinkingOnSpecial: 10,
				timeOfRound: 600,
				timeForChoosingFinalTheme: 10,
				timeForFinalThinking: 10,
				timeForShowmanDecisions: 10,
				timeForRightAnswer: 2,
				timeForBlockingButton: 3,
				partialImageTime: 3,
				imageTime: 5,
				buttonsAccepting: 300,
			},
		},
	};

	const response = await fetch(`${baseUrl}/api/v1/games`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			gameSettings,
			packageInfo: {
				type: 0,
				uri: packageUri,
				contentServiceUri: `${baseUrl}/`,
				secret: null,
				source: null,
			},
			computerAccounts: [],
		}),
	});

	assert.strictEqual(response.status, 200, 'game creation must succeed');
	const result = await response.json();
	assert.strictEqual(result.isSuccess, true, `game creation failed: ${JSON.stringify(result)}`);

	return result;
}

const trace = message => {
	if (process.env.TRACE) {
		console.log(`… ${message}`);
	}
};

async function main() {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigame-local-'));
	const server = new LocalGameServer({
		port: 0,
		host: '127.0.0.1',
		dataDir,
		log: message => {
			if (process.env.VERBOSE) {
				console.log(`[server] ${message}`);
			}
		},
	});

	const port = await server.start();
	const baseUrl = `http://127.0.0.1:${port}`;
	const checks = [];

	const check = (name, fn) => {
		checks.push({ name, fn });
	};

	try {
		// ------------------------------------------------------------------
		// HTTP level
		// ------------------------------------------------------------------
		const discovery = await (await fetch(`${baseUrl}/api/si/servers`)).json();
		assert.ok(discovery.length === 1 && discovery[0].uri === `${baseUrl}/`, 'discovery returns the local server uri');

		const hostInfo = await (await fetch(`${baseUrl}/api/v1/info/host`)).json();
		assert.ok(hostInfo.contentInfos[0].serviceUri === baseUrl, 'host info exposes the local content service');
		assert.deepStrictEqual(hostInfo.storageInfos, [], 'no package storages in local mode');

		const packageBuffer = await buildPackage();
		const packageUri = await uploadPackage(baseUrl, packageBuffer);
		assert.ok(packageUri.startsWith('content/packages/'), `unexpected package uri: ${packageUri}`);
		console.log('✔ discovery, host info, package upload');

		// Media must be downloadable, with Range support for video seeking.
		const created = await createGame(baseUrl, packageUri);
		const gameId = created.gameId;
		assert.strictEqual(created.isSuccess, true);

		const packageHash = packageUri.split('/')[2];
		const mediaUrl = `${baseUrl}/media/${packageHash}/${encodeURIComponent('Images/pixel.png')}`;
		const mediaResponse = await fetch(mediaUrl);
		assert.strictEqual(mediaResponse.status, 200, 'media must be served');
		assert.strictEqual(mediaResponse.headers.get('content-type'), 'image/png');

		const ranged = await fetch(mediaUrl, { headers: { Range: 'bytes=0-3' } });
		assert.strictEqual(ranged.status, 206, 'range request must return 206');
		assert.match(ranged.headers.get('content-range') || '', /^bytes 0-3\/\d+$/, 'partial content range is returned');

		// Media with directories, spaces and cyrillic letters is addressable
		// with plain path separators and with percent-encoded ones.
		const plainPathUrl = `${baseUrl}/media/${packageHash}/Images/${encodeURIComponent('Логотип пака.png')}`;
		const plainPathResponse = await fetch(plainPathUrl);
		assert.strictEqual(plainPathResponse.status, 200, 'media in a subdirectory must be served');
		assert.strictEqual(plainPathResponse.headers.get('content-type'), 'image/png');

		const encodedPathResponse = await fetch(
			`${baseUrl}/media/${packageHash}/${encodeURIComponent('Images/логотип ПАКА.png')}`
		);
		assert.strictEqual(encodedPathResponse.status, 200, 'media names are matched case-insensitively');

		const missingResponse = await fetch(`${baseUrl}/media/${packageHash}/absent.png`);
		assert.strictEqual(missingResponse.status, 404, 'missing media is reported as 404');
		console.log('✔ media streaming with Range support');

		// The lobby reports free seats (IsOnline: false). The web client enables
		// the "Player"/"Showman" buttons only when such a seat exists, so an
		// empty seat must be visible before anyone joins.
		const lobby = await new TestClient(baseUrl, 'Наблюдатель').connect('sionline');
		const slice = await lobby.invoke('GetGamesSlice', 0);
		const listedGame = (slice.Data || []).find(game => game.GameID === gameId);
		assert.ok(listedGame, 'created game is listed in the lobby');

		const freeShowman = listedGame.Persons.filter(person => person.Role === 'Showman' && person.IsOnline === false);
		const freePlayers = listedGame.Persons.filter(person => person.Role === 'Player' && person.IsOnline === false);

		assert.strictEqual(freeShowman.length, 1, 'a free showman seat is reported');
		assert.strictEqual(freePlayers.length, 2, 'free player seats are reported');
		assert.strictEqual(listedGame.Persons.filter(person => person.IsOnline).length, 0, 'nobody is online yet');
		console.log('✔ lobby reports free seats so players can join');

		// ------------------------------------------------------------------
		// Game level
		// ------------------------------------------------------------------
		trace('connecting showman');
		const showman = await new TestClient(baseUrl, 'Ведущий').connect();
		trace('connecting player 1');
		const player1 = await new TestClient(baseUrl, 'Игрок 1').connect();
		trace('connecting player 2');
		const player2 = await new TestClient(baseUrl, 'Игрок 2').connect();
		trace('connected');

		const joinShowman = await showman.invoke('JoinGame2', {
			GameId: gameId, UserName: 'Ведущий', Role: 'Showman', Sex: 'Male', Pin: null,
		});
		assert.strictEqual(joinShowman, 'Success', 'showman must join');

		const join1 = await player1.invoke('JoinGame2', {
			GameId: gameId, UserName: 'Игрок 1', Role: 'Player', Sex: 'Male', Pin: null,
		});
		assert.strictEqual(join1, 'Success', 'player 1 must join');

		const join2 = await player2.invoke('JoinGame2', {
			GameId: gameId, UserName: 'Игрок 2', Role: 'Player', Sex: 'Female', Pin: null,
		});
		assert.strictEqual(join2, 'Success', 'player 2 must join');

		// Once the seats are taken the lobby must not advertise them as free.
		const updatedSlice = await lobby.invoke('GetGamesSlice', 0);
		const updatedGame = (updatedSlice.Data || []).find(game => game.GameID === gameId);
		assert.ok(updatedGame, 'game is still listed after joining');
		assert.strictEqual(
			updatedGame.Persons.filter(person => person.Role === 'Showman' && person.IsOnline).length,
			1,
			'the connected showman is reported as online',
		);
		assert.strictEqual(
			updatedGame.Persons.filter(person => person.Role === 'Player' && person.IsOnline).length,
			2,
			'both players are reported as online',
		);
		assert.strictEqual(
			updatedGame.Persons.filter(person => !person.IsOnline).length,
			0,
			'no free seats remain after joining',
		);
		lobby.close();
		console.log('✔ lobby seats are updated after joining');

		await player1.waitForStart('INFO2', 3000);
		const packageInfoMessage = await player1.waitForStart('PACKAGE', 3000);
		assert.ok(packageInfoMessage.includes('Тестовый пакет'), 'package name must be announced');

		// The client decides whether it may start the game, move to the next
		// round and edit the scores by comparing its own name with HOSTNAME.
		// Without this message the showman has no host rights at all.
		const hostNameMessage = await player1.waitForStart('HOSTNAME', 3000);
		assert.strictEqual(hostNameMessage.split('\n')[1], 'Ведущий', 'the game creator is reported as the host');

		// The package logo is sent only when the file is really inside the
		// archive, otherwise the client waits forever for a broken image.
		const logoLine = packageInfoMessage.split('\n');
		assert.strictEqual(logoLine.length > 3, true, 'package logo uri is sent');
		assert.ok(/^<SERVERHOST>\/media\//.test(logoLine[3]), `unexpected logo uri: ${logoLine[3]}`);
		const logoResponse = await fetch(`${baseUrl}${logoLine[3].replace('<SERVERHOST>', '')}`);
		assert.strictEqual(logoResponse.status, 200, 'the announced package logo must be downloadable');

		// Duplicate name must be rejected.
		const duplicate = await new TestClient(baseUrl, 'Игрок 1').connect();
		const duplicateJoin = await duplicate.invoke('JoinGame2', {
			GameId: gameId, UserName: 'Игрок 1', Role: 'Player', Sex: 'Male', Pin: null,
		});
		assert.strictEqual(duplicateJoin, 'NameIsOccupied', 'duplicate names are rejected');
		duplicate.close();
		console.log('✔ join flow, INFO2 snapshot, duplicate name protection');

		// Start the game.
		showman.send('START');
		await player1.waitForStart('STAGE', 5000, 'stage');
		const tableMessage = await player1.waitForStart('TABLO2', 5000);
		assert.ok(tableMessage.includes('100'), 'table must contain question prices');

		const chooserMessage = await player1.waitForStart('SETCHOOSER', 5000);
		assert.strictEqual(chooserMessage.split('\n')[1], '0', 'first player becomes the chooser');
		await player1.waitForStart('CHOOSE', 3000);
		console.log('✔ round started, table and chooser are synchronized');

		// Choose the first question.
		player1.send('CHOICE\n0\n0');

		await player1.waitForStart('CHOICE', 3000);
		const contentMessage = await player1.waitForStart('CONTENT2', 5000);
		assert.ok(contentMessage.includes('/media/'), 'question media must point to the local content service');
		assert.ok(contentMessage.includes('<SERVERHOST>/media/'), 'media urls use the <SERVERHOST> placeholder');

		// A client joining in the middle of a question must receive the full state.
		const late = await new TestClient(baseUrl, 'Опоздавший').connect();
		const lateJoin = await late.invoke('JoinGame2', {
			GameId: gameId, UserName: 'Опоздавший', Role: 'Player', Sex: 'Male', Pin: null,
		});
		assert.strictEqual(lateJoin, 'Success', 'late client must join as a player');
		await late.waitForStart('INFO2', 3000);
		const lateContent = await late.waitForStart('CONTENT2', 3000);
		assert.strictEqual(lateContent, contentMessage, 'late client must see the same question content');
		late.close();
		console.log('✔ late join receives the current question content');

		// Press phase.
		await player1.waitForStart('TRY', 15000);
		await delay(80);
		player2.send('I\n20');
		player1.send('I\n60');

		const endTry = await player1.waitForStart('ENDTRY', 3000);
		assert.strictEqual(endTry.split('\n')[1], '1', 'the first press wins (player 2)');

		await player2.waitForStart('ANSWER', 3000);
		player2.send('ANSWER\nПравильный ответ');

		const askValidate = await showman.waitForStart('ASK_VALIDATE', 3000);
		assert.ok(askValidate.includes('Правильный ответ'), 'showman receives the answer to validate');

		const afterValidation = player1.mark();
		showman.send('ISRIGHT\n+\n1');

		const person = await player1.waitForStart('PERSON', 3000, afterValidation);
		assert.deepStrictEqual(person.split('\n').slice(1), ['+', '1', '100'], 'player 2 receives 100 points');

		const sums = await player1.waitForStart('SUMS', 3000, afterValidation);
		assert.deepStrictEqual(sums.split('\n').slice(1), ['0', '100'], 'sums are broadcast');

		// The showman can correct a player score (CHANGE, player number from 1).
		const afterScores = player1.mark();
		showman.send('CHANGE\n2\n250');

		const scoreChanged = await player1.waitForStart('PLAYER_SCORE_CHANGED', 3000, afterScores);
		assert.deepStrictEqual(
			scoreChanged.split('\n').slice(1),
			['1', '250'],
			'the score change is broadcast with a zero-based player index',
		);

		const sumsAfterChange = await player1.waitForStart('SUMS', 3000, afterScores);
		assert.deepStrictEqual(sumsAfterChange.split('\n').slice(1), ['0', '250'], 'sums follow the manual change');

		// A player must not be able to rewrite the scores.
		const afterIllegalChange = player1.mark();
		player1.send('CHANGE\n1\n9999');
		await delay(300);
		assert.ok(
			!player1.messages.slice(afterIllegalChange).some(text => text.startsWith('PLAYER_SCORE_CHANGED')),
			'players cannot change scores',
		);
		console.log('✔ showman changes scores, players cannot');

		const afterQuestion = player1.mark();
		await player1.waitForStart('QUESTION_END', 6000, afterQuestion);
		console.log('✔ press order, answer, showman validation, scores');

		// The winner chooses the next question.
		const nextChooser = await player1.waitForStart('SETCHOOSER', 6000, afterQuestion);
		const chooserIndex = nextChooser.split('\n')[1];
		const nextPlayer = chooserIndex === '1' ? player2 : player1;
		await nextPlayer.waitForStart('CHOOSE', 3000);
		nextPlayer.send('CHOICE\n0\n1');

		const secondQuestion = nextPlayer.mark();
		await nextPlayer.waitForStart('TRY', 5000, secondQuestion);

		// A player may pass: everybody is told, and the question continues for
		// the players who can still press.
		const otherPlayerIndex = chooserIndex === '1' ? 0 : 1;
		const otherPlayer = otherPlayerIndex === 0 ? player1 : player2;
		otherPlayer.send('PASS');

		const passMessage = await nextPlayer.waitForStart('PASS', 3000, secondQuestion);
		assert.strictEqual(passMessage.split('\n')[1], String(otherPlayerIndex), 'the passed player is announced');

		nextPlayer.send('I\n10');
		await nextPlayer.waitForStart('ANSWER', 3000, secondQuestion);
		nextPlayer.send('ANSWER\nневерно');

		const showmanMark = showman.mark();
		await showman.waitForStart('ASK_VALIDATE', 3000, showmanMark);
		showman.send('ISRIGHT\n-\n1');

		const afterInvalid = player1.mark();
		const wrongSum = await player1.waitForStart('PERSON', 3000, afterInvalid);
		assert.strictEqual(wrongSum.split('\n')[1], '-', 'wrong answer is reported');
		console.log('✔ wrong answer path');

		// ------------------------------------------------------------------
		// PIN based join (invite link flow)
		// ------------------------------------------------------------------
		const pinResponse = await fetch(`${baseUrl}/api/v1/games?pin=1`);
		assert.strictEqual(pinResponse.status, 404, 'unknown pin must return 404');
		console.log('✔ pin lookup for unknown games');

		// ------------------------------------------------------------------
		// Chat
		// ------------------------------------------------------------------
		player1.ws.send(frame([1, {}, null, 'SendMessage', [{ Text: 'Привет!', IsSystem: false, Sender: 'Игрок 1', Receiver: '*' }]]));

		const chatDeadline = Date.now() + 3000;
		while (player2.chat.length === 0 && Date.now() < chatDeadline) {
			// eslint-disable-next-line no-await-in-loop
			await delay(50);
		}

		assert.strictEqual(player2.chat.length, 1, 'chat is delivered to other clients');
		assert.strictEqual(player2.chat[0].text, 'Привет!');
		console.log('✔ chat is broadcast to the room');

		showman.close();
		player1.close();
		player2.close();

		console.log('\nВсе проверки пройдены ✔');
	} finally {
		await server.stop();
		fs.rmSync(dataDir, { recursive: true, force: true });
	}
}

main().catch(error => {
	console.error('\nТест не пройден:', error);
	process.exit(1);
});
