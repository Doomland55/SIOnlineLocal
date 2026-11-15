import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { ContentItem, Package, Question, Round, Theme } from '../../../src/model/siquester/package';
import { parseXMLtoPackage } from '../../../src/model/siquester/packageLoader';
import { parseXml } from '../xml';

/** A package prepared for the game: parsed content plus extracted media on disk. */
export interface LoadedPackage {
	/** Package identifier (content hash). */
	id: string;

	/** Parsed package. */
	package: Package;

	/** Absolute path to the package root inside the media directory. */
	rootDir: string;

	/** Archive-relative media names mapped to the paths actually stored on disk. */
	mediaPaths?: ReadonlyMap<string, string>;

	/** Original file name. */
	fileName: string;

	/** Absolute path to the .siq file. */
	filePath: string;
}

/** Media file relative path prefix that is exposed to clients. */
export const MEDIA_ROUTE_PREFIX = '/package';

const MEDIA_FOLDERS: Record<string, string> = {
	audio: 'Audio',
	video: 'Video',
	html: 'Html',
	image: 'Images',
};

/** Returns the media category folder for a content type. */
export function getMediaFolder(contentType: string): string | null {
	return MEDIA_FOLDERS[contentType] ?? null;
}

/** Files that must not be exposed as media. */
const NON_MEDIA_FILES = new Set(['content.xml', 'quality.marker']);

/** Folder mapping for flat packages without category folders. */
const EXTENSION_FOLDERS: Record<string, string> = {
	'.jpg': 'Images',
	'.jpeg': 'Images',
	'.png': 'Images',
	'.gif': 'Images',
	'.bmp': 'Images',
	'.webp': 'Images',
	'.svg': 'Images',
	'.mp3': 'Audio',
	'.wav': 'Audio',
	'.ogg': 'Audio',
	'.m4a': 'Audio',
	'.flac': 'Audio',
	'.mp4': 'Video',
	'.webm': 'Video',
	'.avi': 'Video',
	'.mov': 'Video',
	'.html': 'Html',
	'.htm': 'Html',
};

function collectContentItems(question: Question): ContentItem[] {
	const items: ContentItem[] = [];

	const addParam = (param: { items?: ContentItem[] } | undefined) => {
		param?.items?.forEach(item => items.push(item));
	};

	addParam(question.params.question);
	addParam(question.params.answer);

	if (question.params.answerOptions) {
		for (const option of Object.values(question.params.answerOptions)) {
			addParam(option);
		}
	}

	return items;
}

function getPackageMediaItems(pack: Package) {
	const result: ContentItem[] = [];

	const visitQuestion = (question: Question) => {
		result.push(...collectContentItems(question));
	};

	pack.rounds.forEach(round => round.themes.forEach(theme => theme.questions.forEach(visitQuestion)));

	return result;
}

/**
 * Resolves a package relative media reference into a path relative to the package root.
 * Content references may or may not contain the media category folder, so both variants are checked.
 */
export function resolveMediaPath(pack: LoadedPackage, item: ContentItem): string | null {
	if (!item.value || item.isRef === false) {
		return null;
	}

	const folder = getMediaFolder(item.type);
	const raw = item.value.replaceAll('\\', '/').replace(/^\.?\/+/, '');
	const references = [raw];
	if (raw.startsWith('@')) {
		references.push(raw.slice(1));
	}
	for (const reference of [...references]) {
		try {
			const decoded = decodeURIComponent(reference);
			if (!references.includes(decoded)) {
				references.push(decoded);
			}
		} catch {
			// A literal percent sign is a valid filename too.
		}
	}

	const candidates = references.flatMap(reference => folder ? [reference, `${folder}/${reference}`] : [reference]);
	const valid = candidates.filter(candidate => {
		const segments = candidate.split('/');
		return segments.length > 0 && segments.every(segment => segment !== '' && segment !== '.' && segment !== '..' && !segment.includes('\0'));
	});

	// A logical archive name may have been shortened for the host filesystem.
	if (pack.mediaPaths) {
		const normalize = (value: string) => value.split('/').map(part => {
			try { return decodeURIComponent(part).normalize('NFC').toLocaleLowerCase(); } catch { return part.normalize('NFC').toLocaleLowerCase(); }
		}).join('\0');
		for (const candidate of valid) {
			const actual = pack.mediaPaths.get(candidate);
			if (actual && findMediaFile(pack.rootDir, actual, false)) {
				return actual;
			}
		}
		for (const candidate of valid) {
			const matches = [...pack.mediaPaths.entries()].filter(([name]) => normalize(name) === normalize(candidate));
			if (matches.length === 1 && findMediaFile(pack.rootDir, matches[0][1], false)) {
				return matches[0][1];
			}
		}
		return null;
	}

	// Packages constructed without an archive map still support direct disk lookup.
	for (const relaxed of [false, true]) {
		for (const candidate of valid) {
			const resolved = findMediaFile(pack.rootDir, candidate, relaxed);
			if (resolved !== null) {
				return resolved;
			}
		}
	}
	return null;
}

/** Match each path segment without escaping the extracted package or guessing between collisions. */
function findMediaFile(root: string, candidate: string, relaxed: boolean): string | null {
	const normalized = (value: string) => {
		let decoded = value;
		try { decoded = decodeURIComponent(value); } catch { /* literal percent */ }
		return decoded.normalize('NFC').toLocaleLowerCase();
	};
	const parts = candidate.split('/');
	const matches: string[] = [];
	const visit = (directory: string, index: number, resolved: string[]) => {
		try {
			if (index === parts.length) {
				if (fs.statSync(directory).isFile()) {
					matches.push(resolved.join('/'));
				}
				return;
			}
			const names = relaxed
				? fs.readdirSync(directory).filter(entry => normalized(entry) === normalized(parts[index]))
				: [parts[index]];
			for (const name of names) {
				const fullPath = path.join(directory, name);
				if (!fs.lstatSync(fullPath).isSymbolicLink()) {
					visit(fullPath, index + 1, [...resolved, name]);
				}
			}
		} catch {
			// Missing entries are not errors; continue with the next candidate.
		}
	};
	visit(root, 0, []);
	return matches.length === 1 ? matches[0] : null;
}

/** Builds the public url of a package media file. */
export function getMediaUrl(pack: LoadedPackage, relativePath: string): string {
	return `${MEDIA_ROUTE_PREFIX}/${pack.id}/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Lists all media urls referenced by the package (used for content preloading). */
export function getPackageMediaUris(pack: LoadedPackage): string[] {
	const uris = new Set<string>();

	for (const item of getPackageMediaItems(pack.package)) {
		const mediaPath = resolveMediaPath(pack, item);

		if (mediaPath) {
			uris.add(getMediaUrl(pack, mediaPath));
		}
	}

	return [...uris];
}

/** Computes a stable package id from file contents. */
function computePackageId(data: Buffer): string {
	return crypto.createHash('sha1').update(data).digest('hex').slice(0, 16);
}

function safeRelativePath(entryName: string): string | null {
	const normalized = entryName.replaceAll('\\', '/');

	if (normalized.startsWith('/') || path.win32.isAbsolute(normalized)
		|| normalized.split('/').some(segment => segment === '..' || segment === '.') || normalized.includes('\0')) {
		return null;
	}

	return normalized;
}

/**
 * Extracts media without relying on Windows long-path support or filesystem filename limits.
 * The map retains archive names, so question references do not need to be rewritten.
 */
async function extractMedia(zip: JSZip, packageId: string, mediaDir: string): Promise<{
	rootDir: string;
	mediaPaths: ReadonlyMap<string, string>;
}> {
	const rootDir = path.resolve(mediaDir, packageId);
	fs.mkdirSync(rootDir, { recursive: true });
	const mediaPaths = new Map<string, string>();
	const entries = Object.values(zip.files).flatMap(entry => {
		if (entry.dir || NON_MEDIA_FILES.has(entry.name.toLowerCase())) {
			return [];
		}
		const name = safeRelativePath(entry.name);
		if (!name || !safeRelativePath(entry.unsafeOriginalName ?? entry.name)) {
			return [];
		}
		const extension = path.extname(name).toLowerCase();
		const folder = !name.includes('/') ? EXTENSION_FOLDERS[extension] : undefined;
		return [{ entry, name, logical: folder ? `${folder}/${name}` : name }];
	});

	// Reserve every original name before assigning aliases, including names differing only by case.
	const reserved = new Set(entries.map(({ logical }) => logical.normalize('NFC').toLocaleLowerCase()));
	const used = new Set<string>();
	const key = (value: string) => value.normalize('NFC').toLocaleLowerCase();
	const archiveNames = new Set(entries.map(({ name }) => name));
	const archiveRoots = new Set(entries.map(({ logical }) => key(logical.split('/')[0])));
	let aliasFolder = '_si';
	let aliasFolderIndex = 0;
	while (archiveRoots.has(key(aliasFolder))) {
		aliasFolderIndex += 1;
		aliasFolder = `_si${aliasFolderIndex}`;
	}
	const conflicts = (value: string) => {
		const candidate = key(value);
		return used.has(candidate)
			|| [...used].some(other => candidate.startsWith(`${other}/`) || other.startsWith(`${candidate}/`))
			|| [...reserved].some(other => other.startsWith(`${candidate}/`));
	};
	const fits = (value: string) => {
		const parts = value.split('/');
		if (!safeRelativePath(value) || path.join(rootDir, value).length > 235) {
			return false;
		}
		return parts.every(part => part.length > 0 && Buffer.byteLength(part, 'utf8') <= 240 && part.length <= 240
			&& !/[<>:"\\|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part)
			&& !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
	};

	for (const { entry, name, logical } of entries) {
		let physical = logical;
		if (!fits(physical) || conflicts(physical)) {
			// URL-encoded Cyrillic is often several times longer than the real name.
			try {
				const decoded = logical.split('/').map(part => decodeURIComponent(part)).join('/');
				if (fits(decoded) && !reserved.has(key(decoded)) && !conflicts(decoded)) {
					physical = decoded;
				}
			} catch {
				// Treat invalid percent sequences as literal filename characters.
			}
		}
		if (!fits(physical) || conflicts(physical)) {
			const hash = crypto.createHash('sha256').update(logical).digest('hex').slice(0, 24);
			const extension = path.extname(logical).toLowerCase();
			const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
			let suffix = 0;
			do {
				physical = `${aliasFolder}/${hash}${suffix ? `-${suffix}` : ''}${safeExtension}`;
				suffix += 1;
			} while (reserved.has(key(physical)) || used.has(key(physical)));
			if (!fits(physical)) {
				throw new Error(`Media directory path is too long: ${rootDir}. Use a shorter SI_DATA_DIR.`);
			}
		}

		used.add(key(physical));
		mediaPaths.set(name, physical);
		if (name !== logical && !archiveNames.has(logical)) {
			mediaPaths.set(logical, physical);
		}
		const destination = path.join(rootDir, physical);
		// eslint-disable-next-line no-await-in-loop
		const content = await entry.async('nodebuffer');
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.writeFileSync(destination, content);
	}

	return { rootDir, mediaPaths };
}

/** Reads a .siq file and prepares its media. */
export async function loadPackage(
	filePath: string,
	fileName: string,
	mediaDir: string,
): Promise<LoadedPackage> {
	const data = fs.readFileSync(filePath);
	const packageId = computePackageId(data);

	const zip = await JSZip.loadAsync(data);
	const contentFile = zip.file('content.xml');

	if (!contentFile) {
		throw new Error('Package does not contain content.xml');
	}

	const xml = await contentFile.async('string');
	const pack = parseXMLtoPackage(parseXml(xml) as unknown as Document);
	const { rootDir, mediaPaths } = await extractMedia(zip, packageId, mediaDir);

	return {
		id: packageId,
		package: pack,
		rootDir,
		mediaPaths,
		fileName,
		filePath,
	};
}

/** Builds a package from raw bytes (used for uploaded packages). */
export async function loadPackageFromBuffer(
	data: Buffer,
	fileName: string,
	mediaDir: string,
): Promise<{ loaded: LoadedPackage; buffer: Buffer }> {
	const packageId = computePackageId(data);
	const zip = await JSZip.loadAsync(data);
	const contentFile = zip.file('content.xml');

	if (!contentFile) {
		throw new Error('Package does not contain content.xml');
	}

	const xml = await contentFile.async('string');
	const pack = parseXMLtoPackage(parseXml(xml) as unknown as Document);
	const { rootDir, mediaPaths } = await extractMedia(zip, packageId, mediaDir);

	return {
		loaded: {
			id: packageId,
			package: pack,
			rootDir,
			mediaPaths,
			fileName,
			filePath: path.join(mediaDir, `${packageId}.siq`),
		},
		buffer: data,
	};
}

/** Returns the number of questions in the package. */
export function getQuestionCount(pack: Package): number {
	return pack.rounds.reduce((total, round) => total + round.themes.reduce((sum, theme) => sum + theme.questions.length, 0), 0);
}

/** Returns true if a round must be played as a final round. */
export function isFinalRound(round: Round): boolean {
	return round.type === 'final';
}

/** Returns themes of the round that contain at least one playable question. */
export function getPlayableThemes(round: Round): Theme[] {
	return round.themes.filter(theme => theme.questions.some(question => question.price >= 0));
}
