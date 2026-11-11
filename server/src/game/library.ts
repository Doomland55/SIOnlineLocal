import fs from 'fs';
import path from 'path';
import { loadPackage, LoadedPackage } from './package';

/** Local packages library: everything in `packagesDir` plus uploaded packages. */
export class PackageLibrary {
	private cache = new Map<string, LoadedPackage>();

	constructor(
		public readonly packagesDir: string,
		private readonly mediaDir: string,
		private readonly log: (message: string) => void,
	) {
		fs.mkdirSync(packagesDir, { recursive: true });
		fs.mkdirSync(mediaDir, { recursive: true });
	}

	/** Returns all .siq files available locally. */
	listFiles(): string[] {
		if (!fs.existsSync(this.packagesDir)) {
			return [];
		}

		return fs.readdirSync(this.packagesDir)
			.filter(name => name.toLowerCase().endsWith('.siq'))
			.sort((a, b) => a.localeCompare(b))
			.map(name => path.join(this.packagesDir, name));
	}

	/** Loads all packages. Broken packages are skipped and reported through the logger. */
	async loadAll(): Promise<LoadedPackage[]> {
		const result: LoadedPackage[] = [];

		for (const filePath of this.listFiles()) {
			try {
				// eslint-disable-next-line no-await-in-loop
				result.push(await this.load(filePath));
			} catch (e) {
				this.log(`Не удалось прочитать пакет ${path.basename(filePath)}: ${(e as Error).message}`);
			}
		}

		return result;
	}

	/** Loads (and caches) a single package by absolute path. */
	async load(filePath: string): Promise<LoadedPackage> {
		const cached = this.cache.get(filePath);

		if (cached && fs.existsSync(filePath)) {
			return cached;
		}

		const loaded = await loadPackage(filePath, path.basename(filePath), this.mediaDir);
		this.cache.set(filePath, loaded);
		return loaded;
	}

	/** Returns the absolute path of a library package by its relative path. */
	findFileByName(name: string): string | null {
		const baseName = path.basename(name.replaceAll('\\', '/'));

		const candidate = path.join(this.packagesDir, baseName);

		return fs.existsSync(candidate) ? candidate : null;
	}

	/** Finds a cached package by identifier. */
	findById(id: string): LoadedPackage | null {
		for (const loaded of this.cache.values()) {
			if (loaded.id === id) {
				return loaded;
			}
		}

		return null;
	}

	/** Returns the first package of the library (used as a fallback for random games). */
	async getDefaultPackage(): Promise<LoadedPackage | null> {
		const all = await this.loadAll();
		return all[0] ?? null;
	}
}

export default PackageLibrary;
