'use strict';

/**
 * Small non-validating XML parser.
 *
 * Produces a lightweight DOM: { tagName, attributes, children, text }.
 * It supports elements, attributes, text, CDATA, comments, processing
 * instructions, DOCTYPE and the standard XML entities. That is enough for
 * SIQ package content.xml files produced by SIQuester.
 */

const ENTITY_MAP = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: '\'',
	nbsp: '\u00a0',
};

function decodeEntities(value) {
	if (value.indexOf('&') < 0) {
		return value;
	}

	return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
		if (entity[0] === '#') {
			const codePoint = entity[1] === 'x' || entity[1] === 'X'
				? parseInt(entity.substring(2), 16)
				: parseInt(entity.substring(1), 10);

			return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
		}

		const decoded = ENTITY_MAP[entity];
		return decoded === undefined ? match : decoded;
	});
}

class XmlElement {
	constructor(tagName) {
		this.tagName = tagName;
		this.attributes = {};
		this.children = [];
		this.text = '';
		this.parent = null;
		this._textContent = null;
	}

	getAttribute(name) {
		const value = this.attributes[name];
		return value === undefined ? null : value;
	}

	get textContent() {
		if (this._textContent === null) {
			let result = this.text;
			for (const child of this.children) {
				result += child.textContent;
			}
			this._textContent = result;
		}

		return this._textContent;
	}

	getDirectChild(tagName) {
		return this.children.find(child => child.tagName === tagName) || null;
	}

	getDirectChildren(tagName) {
		return this.children.filter(child => child.tagName === tagName);
	}
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_.:-]/;

function parseXml(source) {
	const length = source.length;
	let position = 0;
	let root = null;
	const stack = [];

	function fail(message) {
		throw new Error(`XML parse error at offset ${position}: ${message}`);
	}

	function skipWhitespace() {
		while (position < length && /\s/.test(source[position])) {
			position++;
		}
	}

	function readName() {
		const start = position;
		if (position >= length || !NAME_START.test(source[position])) {
			fail('expected a name');
		}

		while (position < length && NAME_CHAR.test(source[position])) {
			position++;
		}

		return source.substring(start, position);
	}

	/** Skips <!DOCTYPE ...> including a possible internal subset. */
	function skipDoctype() {
		let depth = 0;
		while (position < length) {
			const char = source[position++];
			if (char === '[') {
				depth++;
			} else if (char === ']') {
				depth--;
			} else if (char === '>' && depth <= 0) {
				return;
			}
		}
		fail('unterminated DOCTYPE');
	}

	function parseAttributes(element) {
		for (;;) {
			const before = position;
			skipWhitespace();

			if (source[position] === '>' || source.startsWith('/>', position)) {
				return;
			}

			if (position >= length) {
				fail('unexpected end of input in tag');
			}

			const name = readName();
			skipWhitespace();

			if (source[position] !== '=') {
				fail(`expected "=" after attribute ${name}`);
			}

			position++;
			skipWhitespace();

			const quote = source[position];
			if (quote !== '"' && quote !== '\'') {
				fail(`expected a quoted value for attribute ${name}`);
			}

			position++;
			const start = position;
			const end = source.indexOf(quote, position);
			if (end < 0) {
				fail(`unterminated value for attribute ${name}`);
			}

			element.attributes[name] = decodeEntities(source.substring(start, end));
			position = end + 1;

			if (position === before) {
				fail('parser made no progress');
			}
		}
	}

	while (position < length) {
		const char = source[position];

		if (char !== '<') {
			const start = position;
			const next = source.indexOf('<', position);
			position = next < 0 ? length : next;
			const text = source.substring(start, position);
			if (stack.length > 0) {
				stack[stack.length - 1].text += decodeEntities(text);
			}
			continue;
		}

		if (source.startsWith('<!--', position)) {
			const end = source.indexOf('-->', position + 4);
			if (end < 0) {
				fail('unterminated comment');
			}
			position = end + 3;
			continue;
		}

		if (source.startsWith('<![CDATA[', position)) {
			const end = source.indexOf(']]>', position + 9);
			if (end < 0) {
				fail('unterminated CDATA section');
			}
			if (stack.length > 0) {
				stack[stack.length - 1].text += source.substring(position + 9, end);
			}
			position = end + 3;
			continue;
		}

		if (source.startsWith('<?', position)) {
			const end = source.indexOf('?>', position + 2);
			if (end < 0) {
				fail('unterminated processing instruction');
			}
			position = end + 2;
			continue;
		}

		if (source.startsWith('<!DOCTYPE', position) || source.startsWith('<!doctype', position)) {
			position += 9;
			skipDoctype();
			continue;
		}

		if (source.startsWith('</', position)) {
			position += 2;
			const tagName = readName();
			skipWhitespace();
			if (source[position] !== '>') {
				fail('expected ">" in closing tag');
			}
			position++;

			const element = stack.pop();
			if (!element || element.tagName !== tagName) {
				fail(`unexpected closing tag </${tagName}>`);
			}
			continue;
		}

		position++; // '<'
		const tagName = readName();
		const element = new XmlElement(tagName);
		parseAttributes(element);

		if (stack.length > 0) {
			element.parent = stack[stack.length - 1];
			stack[stack.length - 1].children.push(element);
		} else if (!root) {
			root = element;
		} else {
			fail('multiple root elements');
		}

		if (source.startsWith('/>', position)) {
			position += 2;
		} else if (source[position] === '>') {
			position++;
			stack.push(element);
		} else {
			fail(`expected end of tag <${tagName}>`);
		}
	}

	if (stack.length > 0) {
		fail(`unclosed element <${stack[stack.length - 1].tagName}>`);
	}

	if (!root) {
		throw new Error('XML document has no root element');
	}

	return root;
}

module.exports = { parseXml, decodeEntities, XmlElement };
