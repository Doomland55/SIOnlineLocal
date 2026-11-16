import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Response } from 'express';

/**
 * Directory names produced by `LocalContentStorage.hash` (base64url SHA-1).
 * A hash comes from a client header (`Content-MD5`), so it is validated before it is used as a path segment.
 */
const HASH_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Returns true when a value could be used as a single directory name inside the data directory.
 *
 * Hashes arrive as headers from the browser: anything with separators, dot segments, absolute paths
 * or percent-encoded characters must be rejected instead of being normalized, so a request could not
 * silently address a directory outside of the storage root.
 */
export function isSafeHashSegment(value: string | null | undefined): value is string {
	return typeof value === 'string' && HASH_PATTERN.test(value) && value !== '.' && value !== '..';
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
	 * The hash is supplied by the client (`Content-MD5`) and is used as a directory name,
	 * so it is validated here: an invalid hash is ignored and the content-based one is used instead.
	 */
	savePackage(data: Buffer, name: string, hash?: string | null): string {
		const packageHash = isSafeHashSegment(hash) ? hash : LocalContentStorage.hash(data);
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

	/** Saves an avatar. */
	saveAvatar(data: Buffer, name: string): string {
		const avatarHash = LocalContentStorage.hash(data);
		const safeName = path.basename(name) || 'avatar.png';
		const folder = path.join(this.avatarsDir, avatarHash);

		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, safeName), data);

		return `/api/v1/content/avatars/${avatarHash}/${encodeURIComponent(safeName)}`;
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

	/** Resolves `<root>/<hash>/<name>` when the hash is a safe segment and the file exists. */
	private getSafePath(root: string, hash: string, name: string): string | null {
		if (!isSafeHashSegment(hash)) {
			return null;
		}

		return resolveInside(path.join(root, hash), path.basename(name));
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
