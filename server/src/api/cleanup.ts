import fs from 'fs';
import path from 'path';

/** Result of a data directory cleanup. */
export interface CleanupResult {
	/** Directories and files that were removed. */
	removed: string[];

	/** Entries that could not be removed (a media file could still be opened by a browser). */
	failed: string[];
}

/** Sub directories of the data directory that are filled while the server runs. */
const DATA_SUBDIRS = ['package', 'media', 'avatars', 'uploads'];

/**
 * Deletes the files the server has accumulated in its data directory.
 *
 * Uploaded packages, extracted media and avatars are copies of content that could be uploaded again,
 * so they are not kept between runs. A file that is still open (a browser could hold a video while
 * the server stops) is reported instead of failing the whole cleanup.
 *
 * `dataDir` itself is kept: it is created on the next start and the path could be a mount point.
 */
export function cleanupDataDir(dataDir: string, log: (message: string) => void = () => { }): CleanupResult {
	const result: CleanupResult = { removed: [], failed: [] };

	for (const subDir of DATA_SUBDIRS) {
		const dir = path.join(dataDir, subDir);

		if (!fs.existsSync(dir)) {
			continue;
		}

		let entries: string[];

		try {
			entries = fs.readdirSync(dir);
		} catch (e) {
			result.failed.push(dir);
			log(`Не удалось прочитать каталог ${dir}: ${(e as Error).message}`);
			continue;
		}

		for (const entry of entries) {
			const target = path.join(dir, entry);

			try {
				fs.rmSync(target, { recursive: true, force: true });
				result.removed.push(target);
			} catch (e) {
				result.failed.push(target);
				log(`Не удалось удалить ${target}: ${(e as Error).message}`);
			}
		}
	}

	return result;
}

export default cleanupDataDir;
