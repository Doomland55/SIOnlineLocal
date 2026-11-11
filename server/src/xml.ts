import sax from 'sax';

/** Minimal DOM-like attribute. */
export interface XmlAttribute {
	name: string;
	value: string;
}

/** Minimal DOM-like element that satisfies `parseXMLtoPackage` requirements. */
export class XmlElement {
	public readonly children: XmlElement[] = [];

	public parent: XmlElement | null = null;

	public readonly attributes: XmlAttribute[] = [];

	private readonly attributeMap: Record<string, string> = {};

	private textParts: string[] = [];

	constructor(public readonly tagName: string) {}

	setAttribute(name: string, value: string): void {
		this.attributeMap[name] = value;
		this.attributes.push({ name, value });
	}

	getAttribute(name: string): string | null {
		return this.attributeMap[name] ?? null;
	}

	appendText(text: string): void {
		this.textParts.push(text);
	}

	appendChild(child: XmlElement): void {
		child.parent = this;
		this.children.push(child);
	}

	/** Concatenated text of this element and all its descendants. */
	get textContent(): string {
		const own = this.textParts.join('');
		return own + this.children.map(child => child.textContent).join('');
	}
}

/** Parsed XML document. */
export interface XmlDocument {
	documentElement: XmlElement;
}

/** Parses an XML string into a minimal DOM tree. */
export function parseXml(xml: string): XmlDocument {
	const parser = sax.parser(true, { lowercase: false, trim: false, normalize: false });

	let root: XmlElement | null = null;
	const stack: XmlElement[] = [];

	parser.onopentag = node => {
		const element = new XmlElement(node.name);

		for (const [name, value] of Object.entries(node.attributes)) {
			element.setAttribute(name, String(value));
		}

		const parent = stack[stack.length - 1];

		if (parent) {
			parent.appendChild(element);
		} else if (!root) {
			root = element;
		}

		stack.push(element);
	};

	parser.onclosetag = () => {
		stack.pop();
	};

	parser.ontext = text => {
		const current = stack[stack.length - 1];

		if (current) {
			current.appendText(text);
		}
	};

	parser.oncdata = text => {
		const current = stack[stack.length - 1];

		if (current) {
			current.appendText(text);
		}
	};

	parser.write(xml).close();

	if (!root) {
		throw new Error('XML document has no root element');
	}

	return { documentElement: root };
}
