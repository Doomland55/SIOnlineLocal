/**
 * Builds a small .siq package used for local server smoke tests.
 * Usage: node server/scripts/make-test-package.js [output.siq]
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const output = process.argv[2] || path.join(__dirname, '..', 'packages', 'test-package.siq');

// 1x1 transparent png
const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
	'base64',
);

// 0.2 seconds of silence as a wav file
function makeWav(seconds = 0.2, rate = 8000) {
	const samples = Math.floor(seconds * rate);
	const data = Buffer.alloc(samples * 2);
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

function questionXml({ price, text, answer, answerOptions, image, audio }) {
	const params = [];

	const items = [];

	if (text) {
		items.push(`<item placement="screen" type="text">${text}</item>`);
	}
	if (image) {
		// Files inside a .siq are referenced relative to the package root
		items.push(`<item placement="screen" type="image" isRef="true">Images/${image}</item>`);
	}
	if (audio) {
		items.push(`<item placement="screen" type="audio" isRef="true" duration="00:00:01">Audio/${audio}</item>`);
	}

	params.push(`<param name="answer" type="content"><item type="text">${answer}</item></param>`);

	if (answerOptions) {
		params.push('<param name="answerType">select</param>');

		const options = answerOptions
			.map((option, index) => `<param name="${String.fromCharCode(65 + index)}" type="content"><item placement="option" type="text">${option}</item></param>`)
			.join('');

		params.push(`<param name="answerOptions" type="group">${options}</param>`);
	}

	return { items, params, price, answer };
}

function buildContent(pack) {
	const roundsXml = pack.rounds.map(round => {
		const themesXml = round.themes.map(theme => {
			const questionsXml = theme.questions.map(q => `
				<question price="${q.price}">
					<params>
						<param name="question" type="content">${q.items.join('')}</param>
						${q.params.join('')}
					</params>
					<right><answer>${q.answer}</answer></right>
				</question>`).join('');

			return `<theme name="${theme.name}"><questions>${questionsXml}</questions></theme>`;
		}).join('');

		return `<round name="${round.name}" type="${round.type || 'standard'}"><themes>${themesXml}</themes></round>`;
	}).join('');

	return `<?xml version="1.0" encoding="utf-8"?>
<package name="${pack.name}" version="5" id="00000000-0000-0000-0000-000000000001" date="2026-01-01" difficulty="2" logo="logo.png">
	<info><authors><author name="Локальный сервер" /></authors></info>
	<rounds>${roundsXml}</rounds>
</package>`;
}

const pack = {
	name: 'Тестовый пакет',
	rounds: [
		{
			name: 'Раунд 1',
			themes: [
				{
					name: 'Текст',
					questions: [
						questionXml({ price: 100, text: 'Сколько будет 2+2?', answer: '4' }),
						questionXml({ price: 200, text: 'Первая буква алфавита?', answer: 'А' }),
					],
				},
				{
					name: 'Ответы',
					questions: [
						questionXml({
							price: 100,
							text: 'Столица России?',
							answer: 'Москва',
							answerOptions: ['Москва', 'Париж', 'Лондон', 'Казань'],
						}),
					],
				},
				{
					name: 'Медиа',
					questions: [
						questionXml({ price: 200, text: 'Что за звук?', answer: 'Тишина', audio: 'tone.wav' }),
						questionXml({ price: 300, image: 'dot.png', answer: 'Точка' }),
					],
				},
			],
		},
		{
			name: 'Раунд 2',
			themes: [
				{
					name: 'Ещё текст',
					questions: [
						questionXml({ price: 100, text: 'Первый месяц зимы?', answer: 'Декабрь' }),
					],
				},
			],
		},
	],
};

async function main() {
	const zip = new JSZip();
	zip.file('content.xml', buildContent(pack));
	zip.file('logo.png', png);
	zip.file('Images/dot.png', png);
	zip.file('Audio/tone.wav', makeWav());

	const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
	fs.mkdirSync(path.dirname(output), { recursive: true });
	fs.writeFileSync(output, buffer);
	console.log(`Package written: ${output} (${buffer.length} bytes)`);
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
