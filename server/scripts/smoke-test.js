/**
 * Smoke test of the local SIGame server.
 *
 * Implements a minimal SignalR messagepack client (the same transport the web client uses)
 * and plays a whole question: join, ready, choose a question, press the button and answer.
 *
 * Usage: node server/scripts/smoke-test.js [serverUrl]
 */
const assert = require('assert');
const path = require('path');
const WebSocket = require('ws');
const { Encoder, decode } = require('@msgpack/msgpack');

const serverUrl = (process.argv[2] || 'http://localhost:8080').replace(/\/+$/, '');

const encoder = new Encoder();
const RECORD_SEPARATOR = 0x1e;

function writeVarInt(size) {
	const bytes = [];
	let rest = size;

	do {
		let part = rest & 0x7f;
		rest >>= 7;

		if (rest > 0) {
			part |= 0x80;
		}

		bytes.push(part);
	} while (rest > 0);

	return bytes;
}

function frame(payload) {
	return Buffer.concat([Buffer.from(writeVarInt(payload.byteLength)), Buffer.from(payload)]);
}

function encodeInvocation(target, args, invocationId = null) {
	return frame(encoder.encode([1, {}, invocationId, target, args]));
}

/** Minimal SignalR client used by the test. */
class TestClient {
	constructor(hubName) {
		this.hubName = hubName;
		this.handlers = new Map();
		this.done = new Map();
		this.invocations = new Map();
		this.nextId = 1;
		this.buffer = Buffer.alloc(0);
		this.handshaken = false;
		this.messages = [];
	}

	on(target, handler) {
		if (!this.handlers.has(target)) {
			this.handlers.set(target, []);
		}

		this.handlers.get(target).push(handler);
	}

	async connect() {
		const negotiateResponse = await fetch(`${serverUrl}/${this.hubName}/negotiate?negotiateVersion=1`, { method: 'POST' });

		assert(negotiateResponse.ok, `negotiate failed: ${negotiateResponse.status}`);
		const negotiation = await negotiateResponse.json();
		assert(negotiation.connectionToken, 'no connection token');

		const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/${this.hubName}?id=${negotiation.connectionToken}`;
		this.socket = new WebSocket(wsUrl);

		this.socket.on('message', data => this.onData(Buffer.isBuffer(data) ? data : Buffer.from(data)));

		await new Promise((resolve, reject) => {
			this.socket.once('open', resolve);
			this.socket.once('error', reject);
		});

		// Handshake
		this.socket.send(Buffer.concat([
			Buffer.from(JSON.stringify({ protocol: 'messagepack', version: 2 })),
			Buffer.from([RECORD_SEPARATOR]),
		]));

		await new Promise(resolve => setTimeout(resolve, 200));
		assert(this.handshaken, 'handshake was not confirmed');
	}

	onData(data) {
		this.buffer = Buffer.concat([this.buffer, data]);

		if (!this.handshaken) {
			const separator = this.buffer.indexOf(RECORD_SEPARATOR);

			if (separator === -1) {
				return;
			}

			const text = this.buffer.subarray(0, separator).toString('utf8');
			this.buffer = this.buffer.subarray(separator + 1);
			this.handshaken = true;
			this.handshake = JSON.parse(text);
			return;
		}

		let offset = 0;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			let size = 0;
			let shift = 0;
			let index = offset;
			let complete = false;

			while (index < this.buffer.length) {
				const byte = this.buffer[index];
				size |= (byte & 0x7f) << shift;
				index += 1;
				shift += 7;

				if ((byte & 0x80) === 0) {
					complete = true;
					break;
				}
			}

			if (!complete || index + size > this.buffer.length) {
				break;
			}

			const payload = this.buffer.subarray(index, index + size);
			offset = index + size;
			this.onPayload(payload);
		}

		this.buffer = this.buffer.subarray(offset);
	}

	onPayload(payload) {
		const message = decode(payload);
		const type = message[0];

		if (type === 1) {
			const target = message[3];
			// A single argument is packed as a scalar, not as an array
			const rawArgs = message.length > 4 ? message[4] : [];
			const args = Array.isArray(rawArgs) ? rawArgs : [rawArgs];
			this.messages.push({ target, args });
			(this.handlers.get(target) ?? []).slice().forEach(handler => handler(...args));
			return;
		}

		if (type === 3) {
			const invocationId = message[2];
			const result = message[4];
			const pending = this.done.get(invocationId);
			this.done.delete(invocationId);

			if (pending) {
				pending.resolve(result);
			}
		}
	}

	invoke(target, ...args) {
		const invocationId = String(this.nextId);
		this.nextId += 1;
		const promise = new Promise((resolve, reject) => {
			this.done.set(invocationId, { resolve, reject });
			setTimeout(() => reject(new Error(`invoke ${target} timed out`)), 5000);
		});

		this.socket.send(encodeInvocation(target, args, invocationId));
		return promise;
	}

	send(target, ...args) {
		this.socket.send(encodeInvocation(target, args, null));
	}

	/** Waits for a hub message matching a predicate. */
	waitFor(target, predicate = () => true, timeout = 8000) {
		const existing = this.messages.find(m => m.target === target && predicate(...(Array.isArray(m.args) ? m.args : [m.args])));

		if (existing) {
			return Promise.resolve(existing.args);
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`message ${target} not received; got: ${this.messages.map(m => m.target + ':' + JSON.stringify(getGameText(m.args?.[0])).slice(0, 90)).join(' | ')}`)),
				timeout,
			);
			const handler = (...args) => {
				if (!predicate(...args)) {
					return;
				}

				clearTimeout(timer);
				resolve(args);
			};

			this.on(target, handler);
		});
	}
}

/** Extracts a game message text (the game sends them through the `Receive` event). */
function getGameText(message) {
	return message && typeof message.Text === 'string' ? message.Text : '';
}

const gameTexts = [];

(async () => {
	console.log(`Testing server at ${serverUrl}`);

	// 1. REST API
	const hostInfoResponse = await fetch(`${serverUrl}/api/v1/info/host`);
	assert(hostInfoResponse.ok, 'host info is not available');
	const hostInfo = await hostInfoResponse.json();
	console.log(`  host: ${hostInfo.name}, content: ${hostInfo.contentPublicBaseUrls?.join(', ') || 'none'}`);
	assert(hostInfo.license, 'no license in host info');
	assert(Array.isArray(hostInfo.contentInfos) && hostInfo.contentInfos.length > 0, 'no content services');

	const botsResponse = await fetch(`${serverUrl}/api/v1/info/bots`);
	const bots = await botsResponse.json();
	console.log(`  bots: ${bots.join(', ')}`);

	// 2. Package library
	const packagesResponse = await fetch(`${serverUrl}/api/v1/packages`);
	const packages = await packagesResponse.json();
	assert(packages.length > 0, 'no packages in the library');
	console.log(`  packages: ${packages.map(pack => `${pack.fileName} (${pack.questions} questions)`).join('; ')}`);

	// 3. Create a fresh game through the REST API (this is what the web client does)
	const gameName = `Тест ${Date.now() % 100000}`;
	const createResponse = await fetch(`${serverUrl}/api/v1/games`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			gameSettings: {
				humanPlayerName: 'Ведущий',
				networkGameName: gameName,
				networkGamePassword: '',
				networkVoiceChat: '',
				isPrivate: false,
				allowViewers: true,
				showman: { name: 'Ведущий', isHuman: false },
				players: [],
				viewers: [],
				appSettings: { readingSpeed: 20, timeSettings: {} },
			},
			packageInfo: { type: 1, uri: packages[0].uri, contentServiceUri: null, secret: null, source: null },
			computerAccounts: [],
		}),
	});

	const created = await createResponse.json();
	assert(created.isSuccess, `game creation failed: ${JSON.stringify(created)}`);
	console.log(`  game created: #${created.gameId} «${gameName}»`);

	// 4. Lobby must report the new game
	const lobby = new TestClient('sionline');
	await lobby.connect();
	const slice = await lobby.invoke('GetGamesSlice', 0);
	assert(Array.isArray(slice.Data), 'games slice is not an array');
	console.log(`  games: ${slice.Data.map(game => `#${game.GameID} ${game.GameName} [${game.Stage}]`).join('; ')}`);

	const gameInfo = slice.Data.find(game => game.GameID === created.gameId);
	assert(gameInfo, 'the created game is not in the lobby list');

	// 5. Join
	const host = new TestClient('sihost');
	host.on('Receive', message => gameTexts.push(getGameText(message)));
	host.on('GamePersonsChanged', () => { });
	await host.connect();

	const info = await host.invoke('TryGetGameInfo', gameInfo.GameID);
	assert(info && info.GameID === gameInfo.GameID, 'game info is not available');

	const playerName = 'Тестовый игрок';
	const joinResult = await host.invoke('JoinGame2', {
		GameId: gameInfo.GameID,
		UserName: playerName,
		Role: 'Player',
		Sex: 'Male',
		AuthorizationMode: 'None',
		Password: '',
		Pin: null,
	});

	console.log(`  joined as ${playerName}: ${joinResult}`);
	assert.strictEqual(joinResult, 'Success', `join failed: ${joinResult}`);

	// 6. The server must send the game state on join
	await host.waitFor('Receive', message => getGameText(message).startsWith('INFO2'));
	await host.waitFor('Receive', message => getGameText(message).startsWith('STAGE'));
	console.log(`  state received (${gameTexts.length} messages)`);

	const hasMessage = prefix => gameTexts.some(text => text.startsWith(prefix));
	assert(hasMessage('GAMEMETADATA'), 'no game metadata');
	assert(hasMessage('PACKAGE'), 'no package info');
	assert(hasMessage('HOSTNAME'), 'no host name');
	console.log('  package:', gameTexts.find(text => text.startsWith('PACKAGE')).split('\n')[1]);

	// 7. Start the game
	host.send('SendMessage', { IsSystem: true, Sender: playerName, Receiver: '@', Text: 'READY\n+' });
	await host.waitFor('Receive', message => getGameText(message) === 'READY\n' + playerName + '\n+');
	console.log('  ready sent');

	await host.waitFor('Receive', message => getGameText(message).startsWith('STAGE\nBegin'), 10000);
	console.log('  game started');

	// 8. Round
	await host.waitFor('Receive', message => getGameText(message).startsWith('STAGE\nRound'), 15000);
	await host.waitFor('Receive', message => getGameText(message).startsWith('ROUND_THEMES2'), 8000);
	await host.waitFor('Receive', message => getGameText(message).startsWith('ROUNDCONTENT'), 8000);
	await host.waitFor('Receive', message => getGameText(message).startsWith('TABLO2'), 8000);
	const roundsThemes = gameTexts.find(text => text.startsWith('ROUND_THEMES2'));
	const roundsNames = gameTexts.find(text => text.startsWith('ROUNDSNAMES'));
	const table = gameTexts.filter(text => text.startsWith('TABLO2')).pop();
	const roundContent = gameTexts.find(text => text.startsWith('ROUNDCONTENT'));

	console.log('  game messages:', gameTexts.map(text => text.split('\n')[0]).join(', '));
	console.log('  rounds:', (roundsNames ?? 'ROUNDSNAMES').split('\n').slice(1).join(', '));
	console.log('  themes:', (roundsThemes ?? 'ROUND_THEMES2').split('\n').slice(2).join(', '));
	console.log('  table:', table.split('\n').slice(1).join(' '));
	console.log('  round content:', roundContent ? roundContent.split('\n').length - 1 : 0, 'items');
	assert(table, 'no round table');
	assert(roundContent, 'no round content');

	// Round media must be downloadable by an absolute url (players reach the server by ip)
	for (const uri of roundContent.split('\n').slice(1)) {
		assert(uri.startsWith('http://') || uri.startsWith('https://'), `media url is not absolute: ${uri}`);
		const resolvedUri = uri;
		const mediaResponse = await fetch(resolvedUri);

		assert(mediaResponse.ok, `media ${uri} is not available: ${mediaResponse.status}`);
		const body = await mediaResponse.arrayBuffer();
		console.log(`  media ok: ${resolvedUri} (${body.byteLength} bytes, ${mediaResponse.headers.get('content-type')})`);
		assert(body.byteLength > 0, `media ${uri} is empty`);
	}

	// 9. Choose a question
	await host.waitFor('Receive', message => getGameText(message).startsWith('CHOOSE'), 15000);

	// The player is the chooser only if the chooser index matches. Otherwise pick any available cell.
	const chooserText = gameTexts.filter(text => text.startsWith('SETCHOOSER')).pop();
	console.log('  chooser:', chooserText ? chooserText.split('\n')[1] : 'none');

	const prices = table.split('\n').slice(1).filter(value => value.length > 0).map(value => parseInt(value, 10));
	const themeCount = roundsThemes.split('\n').length - 2;

	host.send('SendMessage', { IsSystem: true, Sender: playerName, Receiver: '@', Text: `CHOICE\n0\n0` });
	void prices;
	void themeCount;

	await host.waitFor('Receive', message => getGameText(message).startsWith('CHOICE'), 5000);
	await host.waitFor('Receive', message => getGameText(message).startsWith('QUESTION\n'), 5000);

	const questionMessages = gameTexts.filter(text => text.startsWith('QUESTION\n') || text.startsWith('QTYPE') || text.startsWith('QUESTIONCAPTION'));
	console.log('  question:', JSON.stringify(questionMessages.map(text => text.split('\n').join(' | '))));

	// 10. Question content
	await host.waitFor('Receive', message => getGameText(message).startsWith('CONTENT2'), 8000);
	const content = gameTexts.filter(text => text.startsWith('CONTENT2')).pop();
	console.log('  content:', content.split('\n').slice(1).join(' | '));

	// 11. Press the button and answer
	await host.waitFor('Receive', message => getGameText(message) === 'TRY', 15000);
	console.log('  press phase started');
	host.send('SendMessage', { IsSystem: true, Sender: playerName, Receiver: '@', Text: 'I\n100' });

	await host.waitFor('Receive', message => getGameText(message).startsWith('ENDTRY'), 5000);
	await host.waitFor('Receive', message => getGameText(message).startsWith('ANSWER'), 5000);
	console.log('  answering');

	host.send('SendMessage', { IsSystem: true, Sender: playerName, Receiver: '@', Text: 'ANSWER\n4' });

	await host.waitFor('Receive', message => getGameText(message).startsWith('RIGHTANSWER'), 5000);
	const rightAnswer = gameTexts.filter(text => text.startsWith('RIGHTANSWER')).pop();
	console.log('  right answer:', JSON.stringify(rightAnswer.split('\n').slice(1)));

	await host.waitFor('Receive', message => getGameText(message).startsWith('SUMS'), 5000);
	const sums = gameTexts.filter(text => text.startsWith('SUMS')).pop();
	console.log('  sums:', sums.split('\n').slice(1).join(', '));

	await host.waitFor('Receive', message => getGameText(message) === 'QUESTION_END', 8000);
	console.log('  question finished');

	// 12. Automatic game (used by the "play alone" flow)
	const autoResponse = await fetch(`${serverUrl}/api/v1/games/auto?player=Автоигрок`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ culture: 'ru-RU' }),
	});
	const autoGame = await autoResponse.json();
	console.log(`  automatic game: #${autoGame.gameId} (${autoGame.isSuccess})`);
	assert(autoGame.isSuccess, 'automatic game was not created');

	host.socket.close();
	lobby.socket.close();

	console.log(`\nAll checks passed. Game messages: ${gameTexts.length}`);
	void path;
	process.exit(0);
})().catch(error => {
	console.error('SMOKE TEST FAILED:', error.stack ?? error.message);
	process.exit(1);
});
