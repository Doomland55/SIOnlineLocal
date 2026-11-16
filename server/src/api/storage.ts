import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Response } from 'express';

/**
 * A hash in any form the web client can send: standard base64 (`+`, `/`, `=`) in the `Content-MD5`
 * header and base64url (letters, digits, `-`, `_`) in the urls it requests afterwards.
 *
 * Only hash alphabet characters are allowed and the length is bounded, so the normalized value is
 * always a single directory name: it cannot contain a separator, a dot segment, a drive letter or a
 * percent-encoded character. `..`, `/etc`, `C:\temp` and `..%2f..` therefore never match.
 */
const BASE64_HASH_PATTERN = /^[A-Za-z0-9+/\-_]{20,64}={0,2}$/;

/** Decimal hash: another valid form of the same digest, which some clients still send. */
const DECIMAL_HASH_PATTERN = /^\d{1,40}$/;

/**
 * Converts a client supplied hash (`Content-MD5` header or a path segment) into a single directory name.
 *
 * `sicontent-client` computes base64 SHA-1 and keeps `+`, `/` and `=` as is in the header, while the
 * path it requests later uses the base64url form. Both are accepted and normalized to the same
 * directory name, so an upload and the following download address the same folder.
 *
 * Values that are not a hash at all are rejected instead of being normalized.
 */
export function normalizeHashSegment(value: string | null | undefined): string | null {
	if (typeof value !== 'string' || !BASE64_HASH_PATTERN.test(value)) {
		return null;
	}

	// The standard base64 alphabet is sanitized exactly like `sicontent-client` does for its urls.
	return value
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

/**
 * Returns true when a value looks like a hash of the content service and not like a path.
 * Used to decide whether a client could be trusted with its own hash instead of a computed one.
 */
export function isAcceptableHash(value: string | null | undefined): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
		return false;
	}

	return normalizeHashSegment(value) !== null || DECIMAL_HASH_PATTERN.test(value);
}

/**
 * Resolves `relativePath` inside `root` and returns it only when it stays inside the root
 * and points to an existing file. The root itself must be an absolute path.
 */
export function resolveInside(root: string, relativePath: string): string | null {
	const resolvedRoot = path.resolve(root);
	let target: string;

	try {
		target = path.resolve(resolvedRoot, relativePath);
	} catch {
		return null;
	}

	if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${path.sep}`)) {
		return null;
	}

	try {
		return fs.statSync(target).isFile() ? target : null;
	} catch {
		return null;
	}
}

/** Local content/storage service: packages, media and avatars stored on disk. */
export class LocalContentStorage {
	constructor(
		private readonly packagesDir: string,
		private readonly mediaDir: string,
		private readonly avatarsDir: string,
	) {
		fs.mkdirSync(packagesDir, { recursive: true });
		fs.mkdirSync(mediaDir, { recursive: true });
		fs.mkdirSync(avatarsDir, { recursive: true });
	}

	/** Hashes data the same way `sicontent-client` does (base64url SHA-1). */
	static hash(data: Buffer): string {
		return crypto
			.createHash('sha1')
			.update(data)
			.digest('base64')
			.replaceAll('/', '_')
			.replaceAll('+', '-')
			.replaceAll('=', '');
	}

	/**
	 * Saves a package and returns its relative uri (`/api/v1/content/packages/<hash>/<name>`).
	 *
	 * The hash is supplied by the client (`Content-MD5`) and is used as a directory name.
	 * It is normalized to the base64url form and checked: a value that is not a hash is ignored
	 * and the content-based one is used instead, so a broken header never turns into a path.
	 */
	savePackage(data: Buffer, name: string, hash?: string | null): string {
		const suppliedHash = isAcceptableHash(hash) ? hash : null;
		const packageHash = (suppliedHash && normalizeHashSegment(suppliedHash)) ?? LocalContentStorage.hash(data);
		const safeName = path.basename(name) || 'package.siq';
		const folder = path.join(this.packagesDir, packageHash);

		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, safeName), data);

		return `/api/v1/content/packages/${packageHash}/${encodeURIComponent(safeName)}`;
	}

	/** Returns package file by hash and file name. */
	getPackagePath(hash: string, name: string): string | null {
		return this.getSafePath(this.packagesDir, hash, name);
	}

	/**
	 * Saves an avatar and returns the url of the image itself.
	 *
	 * The reference content service answers an upload with `/avatars/<file>`, an image link that the
	 * client puts straight into `AVATAR` and into an `<img>` tag. The lookup uri
	 * (`/api/v1/content/avatars/<hash>/<name>`) answers with the link as text, so returning it here
	 * would make every other client load a text document instead of a picture.
	 */
	saveAvatar(data: Buffer, name: string): string {
		const avatarHash = LocalContentStorage.hash(data);
		const safeName = path.basename(name) || 'avatar.png';
		const folder = path.join(this.avatarsDir, avatarHash);

		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, safeName), data);

		return `/avatars/${avatarHash}/${encodeURIComponent(safeName)}`;
	}

	/** Returns avatar path by hash and file name. */
	getAvatarPath(hash: string, name: string): string | null {
		return this.getSafePath(this.avatarsDir, hash, name);
	}

	/** Resolves a package media file (`/package/<packageId>/<relativePath>`). */
	getMediaPath(packageId: string, relativePath: string): string | null {
		if (!/^[a-f0-9]{16}$/i.test(packageId)) {
			return null;
		}

		return resolveInside(path.join(this.mediaDir, packageId), relativePath);
	}

	/** Resolves `<root>/<hash>/<name>` when the hash is a valid segment and the file exists. */
	private getSafePath(root: string, hash: string, name: string): string | null {
		// A decimal hash is a valid form of the digest, but this service never stores such folders
		const segment = normalizeHashSegment(hash);

		if (!segment) {
			return null;
		}

		return resolveInside(path.join(root, segment), path.basename(name));
	}
}

/** Extensions of files that a browser renders as a document or runs as a script. */
const ACTIVE_EXTENSIONS = ['.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs', '.css'];

/** Options of file delivery. */
export interface SendFileOptions {
	/**
	 * Serve active content (html, svg, js) as a document instead of a download.
	 *
	 * Package media need this: a question could contain an HTML file that is shown to players.
	 * It stays safe because such files are displayed in a sandboxed frame without same-origin access.
	 */
	inlineActiveContent?: boolean;
}

/**
 * Sends a file with a proper content type.
 *
 * Files come from packages and from uploads, so the response is always marked as non-sniffable.
 * Uploaded packages and avatars are downloads: an uploaded HTML file must not run as a document of
 * this origin, where it would have access to the application and its API.
 */
export function sendFile(res: Response, filePath: string, options: SendFileOptions = {}): void {
	// Express streams the file and handles HEAD, byte ranges, and conditional requests.
	res.setHeader('Cache-Control', 'public, max-age=3600');
	res.setHeader('X-Content-Type-Options', 'nosniff');

	if (!options.inlineActiveContent && ACTIVE_EXTENSIONS.includes(path.extname(filePath).toLowerCase())) {
		res.setHeader('Content-Disposition', 'attachment');
	}

	res.sendFile(path.resolve(filePath));
}

export default LocalContentStorage;
