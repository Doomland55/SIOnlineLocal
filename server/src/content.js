'use strict';

/**
 * SIContent-compatible content service.
 *
 * The web client uploads the .siq package to {serviceUri}/api/v1/content/packages
 * and expects package media to be downloadable from content URIs. This module
 * implements that API (plus avatars) on top of the local file system and keeps
 * parsed packages in memory so question media can be streamed to players.
 *
 * Uploads are stored under <dataDir>/packages/<sha1-base64url>/<fileName> so a
 * game can be restored after a server restart. Media inside packages is served
 * with HTTP Range support (required for video seeking) and immutable caching,
 * which is what makes round media preloading fast and reliable on a LAN.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { getMimeType } = require('./package');

const MAX_PACKAGE_SIZE_MB = 256;
const MAX_AVATAR_SIZE_MB = 4;

/** Base64url-encoded SHA-1 of the file, as used by SIContentService. */
function computeContentHash(buffer) {
	return crypto.createHash('sha1').update(buffer).digest('base64url');
}

/** Parses multipart/form-data body into an array of {name, fileName, data}. */
function parseMultipart(body, contentTypeHeader) {
	const contentTypeMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader || '');
	if (!contentTypeMatch) {
		throw Object.assign(new Error('Multipart boundary is missing'), { errorCode: 4 });
	}

	const boundary = `--${(contentTypeMatch[1] || contentTypeMatch[2]).trim()}`;
	const boundaryBuffer = Buffer.from(boundary, 'utf8');
	const bodyLength = body.length;
	const parts = [];

	let position = body.indexOf(boundaryBuffer, 0);

	while (position >= 0) {
		position += boundaryBuffer.length;

		// Final boundary is followed by "--".
		if (body.subarray(position, position + 2).toString() === '--') {
			break;
		}

		// Skip CRLF after boundary.
		if (body[position] === 13 && body[position + 1] === 10) {
			position += 2;
		}

		const headersEnd = body.indexOf(Buffer.from('\r\n\r\n'), position);
		if (headersEnd < 0) {
			break;
		}

		const headersText = body.subarray(position, headersEnd).toString('utf8');
		const dataStart = headersEnd + 4;

		let dataEnd = body.indexOf(boundaryBuffer, dataStart);
		if (dataEnd < 0) {
			dataEnd = bodyLength;
		}

		// The boundary is preceded by CRLF; strip it from the part data.
		let dataStop = dataEnd;
		if (dataStop >= 2 && body[dataStop - 2] === 13 && body[dataStop - 1] === 10) {
			dataStop -= 2;
		}

		const dispositionMatch = /content-disposition:([^\r\n]*)/i.exec(headersText);
		const disposition = dispositionMatch ? dispositionMatch[1] : '';
		const nameMatch = /name="([^"]*)"/i.exec(disposition);
		const fileNameMatch = /filename="([^"]*)"/i.exec(disposition);

		parts.push({
			name: nameMatch ? nameMatch[1] : '',
			fileName: fileNameMatch ? fileNameMatch[1] : '',
			data: body.subarray(dataStart, dataStop),
		});

		position = dataEnd;
	}

	return parts;
}

function sanitizeFileName(fileName) {
	const baseName = String(fileName || 'file').replace(/\\/g, '/').split('/').pop() || 'file';

	return baseName.replace(/[\u0000-\u001f<>:"|?*]/g, '_').substring(0, 200) || 'file';
}

class ContentService {
	/**
	 * @param {{dataDir: string, log?: Function}} options
	 */
	constructor(options) {
		this.dataDir = options.dataDir;
		this.log = options.log || (() => {});
		this.packagesDir = path.join(this.dataDir, 'packages');
		this.avatarsDir = path.join(this.dataDir, 'avatars');

		/** Parsed packages keyed by content hash. */
		this.packages = new Map();

		fs.mkdirSync(this.packagesDir, { recursive: true });
		fs.mkdirSync(this.avatarsDir, { recursive: true });
	}

	/**
	 * Registers a parsed package so its media can be served.
	 * @param {object} parsedPackage Result of parseSiq().
	 */
	registerPackage(parsedPackage) {
		this.packages.set(parsedPackage.hash, parsedPackage);
	}

	getPackage(hash) {
		return this.packages.get(hash) || null;
	}

	/**
	 * Public URL of a media file inside a package.
	 *
	 * <SERVERHOST> is a placeholder that the web client replaces with the server
	 * address it is connected to. That keeps media working no matter which of
	 * the host machine's IP addresses (or host names) players used to join.
	 */
	getMediaUri(packageHash, fileName) {
		return `<SERVERHOST>/media/${packageHash}/${encodeURIComponent(fileName)}`;
	}

	/** Relative package uri, as returned by SIContentService. */
	getPackageUri(hash, fileName) {
		return `content/packages/${hash}/${encodeURIComponent(fileName)}`;
	}

	async savePackage(buffer, fileName) {
		if (buffer.length === 0) {
			throw Object.assign(new Error('File is empty'), { errorCode: 2 });
		}

		if (buffer.length > MAX_PACKAGE_SIZE_MB * 1024 * 1024) {
			throw Object.assign(new Error('File is too large'), { errorCode: 3 });
		}

		const hash = computeContentHash(buffer);
		const safeName = sanitizeFileName(fileName);
		const directory = path.join(this.packagesDir, hash);

		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(path.join(directory, safeName), buffer);

		return { hash, fileName: safeName, uri: this.getPackageUri(hash, safeName) };
	}

	readStoredPackage(hash, fileName) {
		const safeName = sanitizeFileName(fileName);
		const filePath = path.join(this.packagesDir, hash, safeName);

		try {
			return fs.readFileSync(filePath);
		} catch {
			return null;
		}
	}

	async saveAvatar(buffer, fileName) {
		if (buffer.length === 0) {
			throw Object.assign(new Error('File is empty'), { errorCode: 2 });
		}

		if (buffer.length > MAX_AVATAR_SIZE_MB * 1024 * 1024) {
			throw Object.assign(new Error('File is too large'), { errorCode: 3 });
		}

		const hash = computeContentHash(buffer);
		const safeName = sanitizeFileName(fileName);
		const directory = path.join(this.avatarsDir, hash);

		await fsp.mkdir(directory, { recursive: true });
		await fsp.writeFile(path.join(directory, safeName), buffer);

		return { hash, fileName: safeName, uri: `content/avatars/${hash}/${encodeURIComponent(safeName)}` };
	}

	/** Serves a media file from a registered package. */
	serveMedia(req, res, packageHash, fileName) {
		const parsedPackage = this.packages.get(packageHash);
		const data = parsedPackage ? parsedPackage.files.get(fileName) : undefined;

		if (!data) {
			this.sendNotFound(res);
			return;
		}

		this.sendBuffer(req, res, data, getMimeType(fileName), `${packageHash}:${fileName}`);
	}

	/** Answers "does this file exist" with its relative uri, as SIContent does. */
	serveUriLookup(req, res, directory, hash, fileName, prefix) {
		const safeName = sanitizeFileName(fileName);
		const filePath = path.join(directory, hash, safeName);

		let exists = false;
		try {
			exists = fs.statSync(filePath).isFile();
		} catch {
			exists = false;
		}

		if (!exists) {
			this.sendNotFound(res);
			return;
		}

		const uri = `${prefix}/${hash}/${encodeURIComponent(safeName)}`;
		res.writeHead(200, {
			'Content-Type': 'text/plain; charset=utf-8',
			'Access-Control-Allow-Origin': '*',
		});
		res.end(uri);
	}

	serveStoredFile(req, res, directory, hash, fileName) {
		if (!/^[A-Za-z0-9_-]+$/.test(hash)) {
			this.sendNotFound(res);
			return;
		}

		const filePath = path.join(directory, hash, sanitizeFileName(fileName));
		let stat;

		try {
			stat = fs.statSync(filePath);
		} catch {
			this.sendNotFound(res);
			return;
		}

		this.sendFile(req, res, filePath, stat, getMimeType(fileName), `${hash}:${fileName}`);
	}

	sendNotFound(res) {
		res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('Not found');
	}

	sendBuffer(req, res, data, mimeType, etagSeed) {
		this.sendRangeAware(req, res, data, data.length, mimeType, etagSeed, null);
	}

	sendFile(req, res, filePath, stat, mimeType, etagSeed) {
		const etag = `"${crypto.createHash('sha1').update(etagSeed).digest('hex').substring(0, 16)}"`;

		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304, { ETag: etag });
			res.end();
			return;
		}

		const rangeHeader = req.headers.range;
		const size = stat.size;

		if (!rangeHeader) {
			res.writeHead(200, {
				'Content-Type': mimeType,
				'Content-Length': size,
				'Accept-Ranges': 'bytes',
				ETag: etag,
				'Cache-Control': 'public, max-age=31536000, immutable',
				'Access-Control-Allow-Origin': '*',
			});

			if (req.method === 'HEAD') {
				res.end();
				return;
			}

			fs.createReadStream(filePath).pipe(res);
			return;
		}

		const range = parseRange(rangeHeader, size);

		if (!range) {
			res.writeHead(416, { 'Content-Range': `bytes */${size}` });
			res.end();
			return;
		}

		res.writeHead(206, {
			'Content-Type': mimeType,
			'Content-Length': range.end - range.start + 1,
			'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
			'Accept-Ranges': 'bytes',
			ETag: etag,
			'Cache-Control': 'public, max-age=31536000, immutable',
			'Access-Control-Allow-Origin': '*',
		});

		fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
	}

	sendRangeAware(req, res, data, size, mimeType, etagSeed, _unused) {
		const etag = `"${crypto.createHash('sha1').update(etagSeed).digest('hex').substring(0, 16)}"`;

		const isNotModified = req.headers['if-none-match'] === etag;
		if (isNotModified) {
			res.writeHead(304, { ETag: etag });
			res.end();
			return;
		}

		const commonHeaders = {
			'Content-Type': mimeType,
			'Accept-Ranges': 'bytes',
			ETag: etag,
			// Question media never changes for a given package hash, so it can be
			// cached aggressively; this makes reconnects and replays instant.
			'Cache-Control': 'public, max-age=31536000, immutable',
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
		};

		const rangeHeader = req.headers.range;

		if (!rangeHeader) {
			res.writeHead(200, { ...commonHeaders, 'Content-Length': size });

			if (req.method === 'HEAD') {
				res.end();
				return;
			}

			res.end(data);
			return;
		}

		const range = parseRange(rangeHeader, size);
		if (!range) {
			res.writeHead(416, { ...commonHeaders, 'Content-Range': `bytes */${size}` });
			res.end();
			return;
		}

		res.writeHead(206, {
			...commonHeaders,
			'Content-Length': range.end - range.start + 1,
			'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
		});
		res.end(data.subarray(range.start, range.end + 1));
	}

	/**
	 * Handles content service HTTP requests.
	 * @returns {boolean} true if the request has been handled.
	 */
	async handleRequest(req, res) {
		const url = new URL(req.url, 'http://localhost');
		const { pathname } = url;

		// Uploads.
		if (pathname === '/api/v1/content/packages' && req.method === 'POST') {
			await this.handleUpload(req, res, 'packages');
			return true;
		}

		if (pathname === '/api/v1/content/avatars' && req.method === 'POST') {
			await this.handleUpload(req, res, 'avatars');
			return true;
		}

		// SIContent "does this file exist?" endpoints return the relative uri of
		// the file as plain text. The client uses them to avoid re-uploading.
		const packageLookup = /^\/api\/v1\/content\/packages\/([^/]+)\/([^/]+)$/.exec(pathname);
		if (packageLookup) {
			this.serveUriLookup(req, res, this.packagesDir, decodeURIComponent(packageLookup[1]), decodeURIComponent(packageLookup[2]), 'content/packages');
			return true;
		}

		const avatarLookup = /^\/api\/v1\/content\/avatars\/([^/]+)\/([^/]+)$/.exec(pathname);
		if (avatarLookup) {
			this.serveUriLookup(req, res, this.avatarsDir, decodeURIComponent(avatarLookup[1]), decodeURIComponent(avatarLookup[2]), 'content/avatars');
			return true;
		}

		// Actual file downloads.
		const packageMatch = /^\/content\/packages\/([^/]+)\/([^/]+)$/.exec(pathname);
		if (packageMatch) {
			this.serveStoredFile(req, res, this.packagesDir, decodeURIComponent(packageMatch[1]), decodeURIComponent(packageMatch[2]));
			return true;
		}

		const avatarMatch = /^\/content\/avatars\/([^/]+)\/([^/]+)$/.exec(pathname);
		if (avatarMatch) {
			this.serveStoredFile(req, res, this.avatarsDir, decodeURIComponent(avatarMatch[1]), decodeURIComponent(avatarMatch[2]));
			return true;
		}

		// In-package media (images, audio, video, html).
		const mediaMatch = /^\/media\/([^/]+)\/([^/]+)$/.exec(pathname);
		if (mediaMatch) {
			this.serveMedia(req, res, decodeURIComponent(mediaMatch[1]), decodeURIComponent(mediaMatch[2]));
			return true;
		}

		if (req.method === 'OPTIONS') {
			this.sendCorsPreflight(req, res);
			return true;
		}

		return false;
	}

	sendCorsPreflight(req, res) {
		res.writeHead(204, {
			'Access-Control-Allow-Origin': req.headers.origin || '*',
			'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Content-MD5, Accept, Range',
			'Access-Control-Allow-Credentials': 'true',
			'Access-Control-Max-Age': '86400',
		});
		res.end();
	}

	async handleUpload(req, res, kind) {
		const contentType = req.headers['content-type'] || '';

		if (!contentType.toLowerCase().includes('multipart/form-data')) {
			this.sendJsonError(res, 415, 4);
			return;
		}

		const contentLength = Number(req.headers['content-length'] || 0);
		const limitMb = kind === 'avatars' ? MAX_AVATAR_SIZE_MB : MAX_PACKAGE_SIZE_MB;

		if (contentLength > limitMb * 1024 * 1024 * 1.05) {
			this.sendJsonError(res, 413, 3);
			return;
		}

		let body;
		try {
			body = await readRequestBody(req, limitMb * 1024 * 1024 * 1.1);
		} catch {
			this.sendJsonError(res, 413, 3);
			return;
		}

		let parts;
		try {
			parts = parseMultipart(body, contentType);
		} catch (error) {
			this.sendJsonError(res, 400, error.errorCode || 4);
			return;
		}

		const filePart = parts.find(part => part.name === 'file') || parts[0];

		if (!filePart || !filePart.data || filePart.data.length === 0) {
			this.sendJsonError(res, 400, 2);
			return;
		}

		// The client sends Content-MD5 equal to the SHA-1 of the file, encoded
		// either as base64 (browser) or base64url; both are accepted.
		const declaredHash = req.headers['content-md5'];
		const actualHash = computeContentHash(filePart.data);
		const normalizeHash = hash => String(hash).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

		if (declaredHash && normalizeHash(declaredHash) !== normalizeHash(actualHash)) {
			this.log(`Upload hash mismatch: declared ${declaredHash}, actual ${actualHash}`);
		}

		try {
			const result = kind === 'avatars'
				? await this.saveAvatar(filePart.data, filePart.fileName)
				: await this.savePackage(filePart.data, filePart.fileName);

			this.log(`Uploaded ${kind}: ${result.fileName} (${filePart.data.length} bytes, ${result.hash})`);

			if (kind === 'packages') {
				// Validate the package right away, so the client receives a clear
				// error instead of a broken game later.
				const { parseSiq } = require('./package');
				parseSiq(filePart.data, { hash: result.hash, fileName: result.fileName });
			}

			res.writeHead(200, {
				'Content-Type': 'text/plain; charset=utf-8',
				'Access-Control-Allow-Origin': '*',
			});
			res.end(result.uri);
		} catch (error) {
			this.log(`Package upload failed: ${error.message}`);
			this.sendJsonError(res, 400, 0);
		}
	}

	sendJsonError(res, status, errorCode) {
		const body = JSON.stringify({ errorCode, message: String(errorCode) });
		res.writeHead(status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': Buffer.byteLength(body),
			'Access-Control-Allow-Origin': '*',
		});
		res.end(body);
	}
}

function parseRange(rangeHeader, size) {
	const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
	if (!match) {
		return null;
	}

	let start;
	let end;

	if (match[1] === '') {
		// Suffix range: last N bytes.
		const suffixLength = Number(match[2]);
		if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
			return null;
		}
		start = Math.max(0, size - suffixLength);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === '' ? size - 1 : Number(match[2]);
	}

	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
		return null;
	}

	return { start, end: Math.min(end, size - 1) };
}

function readRequestBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;

		req.on('data', chunk => {
			total += chunk.length;

			if (total > limit) {
				reject(new Error('Request body is too large'));
				req.destroy();
				return;
			}

			chunks.push(chunk);
		});

		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

module.exports = {
	ContentService,
	computeContentHash,
	parseMultipart,
	readRequestBody,
	sanitizeFileName,
	MAX_PACKAGE_SIZE_MB,
};
