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

	// Prefer exact spelling, then try an unambiguous case/URI/Unicode-normalized match.
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
 * Extracts all media files of a package into `<mediaDir>/<packageId>/`.
 * Media are stored with their original package relative paths so that
 * `content.xml` references keep working.
 */
async function extractMedia(zip: JSZip, packageId: string, mediaDir: string): Promise<string> {
	const rootDir = path.join(mediaDir, packageId);
	fs.mkdirSync(rootDir, { recursive: true });

	for (const entry of Object.values(zip.files)) {
		if (entry.dir || NON_MEDIA_FILES.has(entry.name.toLowerCase())) {
			continue;
		}

		const relativeName = safeRelativePath(entry.name);
		// JSZip sanitizes traversal names; do not accept the sanitized alias of an unsafe entry.
		const originalName = safeRelativePath(entry.unsafeOriginalName ?? entry.name);

		if (!relativeName || !originalName) {
			continue;
		}

		let destination = path.join(rootDir, relativeName);
		const [firstSegment] = relativeName.split('/');
		const hasCategoryFolder = Object.values(MEDIA_FOLDERS).includes(firstSegment);

		if (!hasCategoryFolder && !relativeName.includes('/')) {
			// Flat package: guess the folder by the file extension
			const extension = path.extname(relativeName).toLowerCase();
			const folder = EXTENSION_FOLDERS[extension];

			if (folder) {
				destination = path.join(rootDir, folder, relativeName);
			}
		}

		// eslint-disable-next-line no-await-in-loop
		const content = await entry.async('nodebuffer');
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.writeFileSync(destination, content);
	}

	return rootDir;
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
	const rootDir = await extractMedia(zip, packageId, mediaDir);

	return {
		id: packageId,
		package: pack,
		rootDir,
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
	const rootDir = await extractMedia(zip, packageId, mediaDir);

	return {
		loaded: {
			id: packageId,
			package: pack,
			rootDir,
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
