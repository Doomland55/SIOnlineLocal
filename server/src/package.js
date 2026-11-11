'use strict';

/**
 * SIQ package parsing.
 *
 * A .siq file is a zip archive with content.xml describing rounds, themes and
 * questions, plus media files referenced from the question content (images,
 * audio, video, html). This module converts content.xml into a plain JS model
 * that the game engine uses, and keeps the media files in memory so they can
 * be served over HTTP.
 *
 * The parsing rules mirror src/model/siquester/packageLoader.ts of the web
 * client (including the v4 -> v5 question upgrade), so packages behave the
 * same way in local games as in the official client.
 */

const { readZip } = require('./zip');
const { parseXml } = require('./xml');

/** Atom types used in v4 packages. */
const AtomTypes = {
	Say: 'say',
	Voice: 'voice',
	Image: 'image',
	Video: 'video',
	Html: 'html',
	Marker: 'marker',
};

const QuestionTypes = {
	Default: '',
	Simple: 'simple',
	Auction: 'auction',
	Cat: 'cat',
	BagCat: 'bagcat',
	Sponsored: 'sponsored',
	Secret: 'secret',
	SecretNoQuestion: 'secretNoQuestion',
	SecretPublicPrice: 'secretPublicPrice',
	Stake: 'stake',
	NoRisk: 'noRisk',
	StakeAll: 'stakeAll',
	ForAll: 'forAll',
};

const TEXT_CONTENT_TYPE = 'text';

function getDirectChildren(element, tagName) {
	return element ? element.getDirectChildren(tagName) : [];
}

function getDirectChild(element, tagName) {
	return element ? element.getDirectChild(tagName) : null;
}

function parseInfo(element) {
	const infoElement = getDirectChild(element, 'info');
	if (!infoElement) {
		return { authors: [], sources: [] };
	}

	const authorsElement = getDirectChild(infoElement, 'authors');
	const sourcesElement = getDirectChild(infoElement, 'sources');
	const commentsElement = getDirectChild(infoElement, 'comments');

	return {
		authors: getDirectChildren(authorsElement, 'author').map(author => author.textContent || ''),
		sources: getDirectChildren(sourcesElement, 'source').map(source => source.textContent || ''),
		comments: commentsElement ? commentsElement.textContent || '' : '',
	};
}

function parseNumberSet(value) {
	// Number sets come either as "minimum,maximum,step" strings or as nested
	// <numberSet minimum=".." maximum=".." step=".."/> elements.
	if (!value) {
		return null;
	}

	const match = String(value).match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*$/);
	if (match) {
		return {
			minimum: Number(match[1]),
			maximum: Number(match[2]),
			step: Number(match[3]),
		};
	}

	return null;
}

function parseContentItems(paramElement) {
	if (!paramElement) {
		return [];
	}

	return getDirectChildren(paramElement, 'item').map(item => {
		const isRefValue = (item.getAttribute('isRef') || '').toLowerCase() === 'true';

		return {
			type: item.getAttribute('type') || TEXT_CONTENT_TYPE,
			value: item.textContent || '',
			isRef: isRefValue,
			placement: item.getAttribute('placement') || 'screen',
			duration: item.getAttribute('duration') || null,
			waitForFinish: (item.getAttribute('waitForFinish') || '').toLowerCase() !== 'false',
		};
	});
}

function parseQuestionParams(questionElement) {
	const paramsElement = getDirectChild(questionElement, 'params');
	const params = {};

	if (!paramsElement) {
		return params;
	}

	for (const paramElement of getDirectChildren(paramsElement, 'param')) {
		const name = paramElement.getAttribute('name');

		if (!name) {
			continue;
		}

		switch (name) {
			case 'question':
			case 'answer':
				params[name] = { items: parseContentItems(paramElement) };
				break;

			case 'theme':
			case 'answerType':
			case 'answerDeviation':
			case 'answerDuration':
			case 'selectionMode':
				params[name] = paramElement.textContent || '';
				break;

			case 'price': {
				const numberSetElement = getDirectChild(paramElement, 'numberSet');
				if (numberSetElement) {
					params.price = {
						numberSet: {
							minimum: Number(numberSetElement.getAttribute('minimum')) || 0,
							maximum: Number(numberSetElement.getAttribute('maximum')) || 0,
							step: Number(numberSetElement.getAttribute('step')) || 0,
						},
					};
				}
				break;
			}

			case 'answerOptions': {
				/** @type {Record<string, { items: object[] }>} */
				const options = {};
				for (const option of getDirectChildren(paramElement, 'param')) {
					const optionName = option.getAttribute('name');
					if (optionName) {
						options[optionName] = { items: parseContentItems(option) };
					}
				}
				params.answerOptions = options;
				break;
			}

			default:
				params[name] = paramElement.textContent || '';
				break;
		}
	}

	return params;
}

function parseRight(questionElement) {
	const rightElement = getDirectChild(questionElement, 'right');

	return {
		answer: getDirectChildren(rightElement, 'answer').map(answer => answer.textContent || ''),
	};
}

function parseWrong(questionElement) {
	const wrongElement = getDirectChild(questionElement, 'wrong');
	if (!wrongElement) {
		return { answer: [] };
	}

	return {
		answer: getDirectChildren(wrongElement, 'answer').map(answer => answer.textContent || ''),
	};
}

function getAtomContentType(atomType) {
	switch (atomType) {
		case AtomTypes.Voice:
			return 'audio';
		case AtomTypes.Image:
			return 'image';
		case AtomTypes.Video:
			return 'video';
		case AtomTypes.Html:
			return 'html';
		case AtomTypes.Say:
		default:
			return 'text';
	}
}

function getAtomPlacement(atomType) {
	switch (atomType) {
		case AtomTypes.Say:
			return 'replic';
		case AtomTypes.Voice:
			return 'background';
		default:
			return 'screen';
	}
}

function formatDuration(seconds) {
	// SIQ v5 stores durations as .NET TimeSpan strings: "00:00:05".
	const total = Math.max(0, Math.round(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const remaining = total % 60;

	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
}

/**
 * Converts a v4 question (scenario/atom) into the v5 params representation,
 * following upgradeV4Question() of the client package loader.
 */
function upgradeV4Question(price, info, typeName, typeParams, atoms) {
	const question = {
		price,
		info,
		type: QuestionTypes.Default,
		params: {},
		right: { answer: [] },
		wrong: { answer: [] },
	};

	if (price === -1) {
		return question;
	}

	let remainingAtoms = atoms;

	switch (typeName) {
		case QuestionTypes.Auction:
			question.type = QuestionTypes.Stake;
			break;

		case QuestionTypes.Sponsored:
			question.type = QuestionTypes.NoRisk;
			break;

		case QuestionTypes.Cat:
		case QuestionTypes.BagCat: {
			const theme = typeParams.get('catTheme') || typeParams.get('theme') || '';
			const priceValue = typeParams.get('catCost') || typeParams.get('cost') || '';
			const knows = typeName === QuestionTypes.BagCat
				? typeParams.get('bagCatKnows') || 'after'
				: 'after';
			const canGiveSelf = typeName === QuestionTypes.BagCat
				? typeParams.get('bagCatSelf') || 'false'
				: 'false';

			const numberSet = parseNumberSet(priceValue);

			if (knows === 'never') {
				remainingAtoms = [];
				question.type = QuestionTypes.SecretNoQuestion;
				question.params.price = { numberSet };
				question.params.selectionMode = canGiveSelf === 'true' ? 'any' : 'exceptCurrent';
			} else {
				question.type = knows === 'before'
					? QuestionTypes.SecretPublicPrice
					: QuestionTypes.Secret;

				question.params.theme = theme;
				question.params.price = { numberSet };
				question.params.selectionMode = canGiveSelf === 'true' ? 'any' : 'exceptCurrent';
			}
			break;
		}

		case QuestionTypes.Simple:
			question.type = QuestionTypes.Default;
			break;

		default:
			question.type = typeName;
			for (const [key, value] of typeParams) {
				if (!question.params[key]) {
					question.params[key] = value;
				}
			}
			break;
	}

	const content = [];
	const answerContent = [];
	let useMarker = false;

	for (const atom of remainingAtoms) {
		if (atom.type === AtomTypes.Marker) {
			useMarker = true;
			continue;
		}

		const isRefValue = atom.text.startsWith('@');
		const item = {
			type: getAtomContentType(atom.type),
			value: isRefValue ? atom.text.substring(1) : atom.text,
			isRef: isRefValue,
			placement: getAtomPlacement(atom.type),
			duration: atom.time !== -1 ? formatDuration(atom.time) : null,
			waitForFinish: atom.time !== -1,
		};

		if (useMarker) {
			answerContent.push(item);
		} else {
			content.push(item);
		}
	}

	if (content.length > 0) {
		question.params.question = { items: content };
	}

	if (answerContent.length > 0) {
		question.params.answer = { items: answerContent };
	}

	return question;
}

function parseQuestion(questionElement, version) {
	const price = Number(questionElement.getAttribute('price')) || 0;
	const info = parseInfo(questionElement);
	const right = parseRight(questionElement);
	const wrong = parseWrong(questionElement);

	if (version === '4') {
		const typeElement = getDirectChild(questionElement, 'type');
		const typeParams = new Map();
		let typeName = QuestionTypes.Default;

		if (typeElement) {
			typeName = typeElement.getAttribute('name') || QuestionTypes.Default;

			for (const param of getDirectChildren(typeElement, 'param')) {
				const name = param.getAttribute('name');
				if (name) {
					typeParams.set(name, param.textContent || '');
				}
			}
		}

		const scenarioElement = getDirectChild(questionElement, 'scenario');
		const atoms = getDirectChildren(scenarioElement, 'atom').map(atom => {
			const timeValue = parseInt(atom.getAttribute('time') || '', 10);

			return {
				type: atom.getAttribute('type') || '',
				text: atom.textContent || '',
				time: Number.isNaN(timeValue) ? 0 : timeValue,
			};
		});

		const question = upgradeV4Question(price, info, typeName, typeParams, atoms);
		question.right = right;
		question.wrong = wrong;
		return question;
	}

	return {
		price,
		type: questionElement.getAttribute('type') || QuestionTypes.Default,
		info,
		params: parseQuestionParams(questionElement),
		right,
		wrong,
	};
}

const MIME_TYPES = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	bmp: 'image/bmp',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	avif: 'image/avif',
	ico: 'image/x-icon',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	opus: 'audio/ogg',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	flac: 'audio/flac',
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	webm: 'video/webm',
	ogv: 'video/ogg',
	mov: 'video/quicktime',
	avi: 'video/x-msvideo',
	mkv: 'video/x-matroska',
	html: 'text/html; charset=utf-8',
	htm: 'text/html; charset=utf-8',
	css: 'text/css; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	json: 'application/json; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	pdf: 'application/pdf',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	xml: 'application/xml; charset=utf-8',
};

function getMimeType(fileName) {
	const dotIndex = fileName.lastIndexOf('.');
	if (dotIndex < 0) {
		return 'application/octet-stream';
	}

	const extension = fileName.substring(dotIndex + 1).toLowerCase();
	return MIME_TYPES[extension] || 'application/octet-stream';
}

/**
 * Parses a .siq file.
 *
 * @param {Buffer} buffer Raw .siq (zip) contents.
 * @param {{hash: string, fileName: string}} meta Package file identity.
 * @returns {object} Parsed package with in-memory media files.
 */
function parseSiq(buffer, meta) {
	const files = readZip(buffer);
	const contentEntry = files.get('content.xml') || files.get('Content.xml');

	if (!contentEntry) {
		const error = new Error('Package does not contain content.xml');
		error.code = 'NoContentXml';
		throw error;
	}

	const root = parseXml(contentEntry.toString('utf8'));
	const version = root.getAttribute('version') || '';
	const name = root.getAttribute('name') || meta.fileName.replace(/\.siq$/i, '');

	const rounds = getDirectChildren(getDirectChild(root, 'rounds'), 'round').map(roundElement => ({
		name: roundElement.getAttribute('name') || '',
		type: roundElement.getAttribute('type') || '',
		info: parseInfo(roundElement),
		themes: getDirectChildren(getDirectChild(roundElement, 'themes'), 'theme').map(themeElement => ({
			name: themeElement.getAttribute('name') || '',
			info: parseInfo(themeElement),
			questions: getDirectChildren(getDirectChild(themeElement, 'questions'), 'question')
				.map(questionElement => parseQuestion(questionElement, version)),
		})),
	}));

	// QuestionIndex is a flat per-question progress counter used by the lobby.
	const totalQuestions = rounds.reduce(
		(sum, round) => sum + round.themes.reduce((themeSum, theme) => themeSum + theme.questions.length, 0),
		0
	);

	const mediaFiles = new Map();
	for (const [fileName, data] of files) {
		if (fileName !== 'content.xml' && fileName !== 'Content.xml') {
			mediaFiles.set(fileName.replace(/\\/g, '/'), data);
		}
	}

	return {
		hash: meta.hash,
		fileName: meta.fileName,
		name,
		version,
		date: root.getAttribute('date') || '',
		publisher: root.getAttribute('publisher') || '',
		language: root.getAttribute('language') || '',
		restriction: root.getAttribute('restriction') || '',
		contactUri: root.getAttribute('contactUri') || '',
		logo: root.getAttribute('logo') || null,
		info: parseInfo(root),
		rounds,
		totalQuestions,
		files: mediaFiles,
	};
}

/** Returns the first text content item of a content param as a string. */
function getTextContent(param) {
	if (!param || !param.items) {
		return '';
	}

	return param.items
		.filter(item => item.type === TEXT_CONTENT_TYPE)
		.map(item => item.value)
		.join('\n');
}

module.exports = {
	parseSiq,
	getMimeType,
	getTextContent,
	parseNumberSet,
	QuestionTypes,
	TEXT_CONTENT_TYPE,
	MIME_TYPES,
};
