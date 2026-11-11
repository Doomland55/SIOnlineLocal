import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import mime from 'mime-types';

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

	/** Saves a package and returns its relative uri (`/api/v1/content/packages/<hash>/<name>`). */
	savePackage(data: Buffer, name: string, hash?: string): string {
		const packageHash = hash ?? LocalContentStorage.hash(data);
		const safeName = path.basename(name) || 'package.siq';
		const folder = path.join(this.packagesDir, packageHash);

		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, safeName), data);

		return `/api/v1/content/packages/${packageHash}/${encodeURIComponent(safeName)}`;
	}

	/** Returns package file by hash and file name. */
	getPackagePath(hash: string, name: string): string | null {
		return this.getSafePath(path.join(this.packagesDir, hash), name);
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
		return this.getSafePath(path.join(this.avatarsDir, hash), name);
	}

	/** Resolves a package media file (`/package/<packageId>/<relativePath>`). */
	getMediaPath(packageId: string, relativePath: string): string | null {
		const root = path.resolve(this.mediaDir, packageId);
		const target = path.resolve(root, relativePath);

		if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
			return null;
		}

		return target;
	}

	private getSafePath(folder: string, name: string): string | null {
		const safeName = path.basename(name);
		const target = path.join(folder, safeName);

		return fs.existsSync(target) && fs.statSync(target).isFile() ? target : null;
	}
}

/** Sends a file with a proper content type. */
export function sendFile(res: { setHeader: (name: string, value: string) => void; end: (data?: Buffer) => void }, filePath: string): void {
	const contentType = mime.lookup(filePath) || 'application/octet-stream';
	res.setHeader('Content-Type', contentType);
	res.setHeader('Cache-Control', 'public, max-age=3600');
	res.end(fs.readFileSync(filePath));
}

export default LocalContentStorage;
