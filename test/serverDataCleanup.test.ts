import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanupDataDir } from '../server/src/api/cleanup';

describe('Data directory cleanup on shutdown', () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-cleanup-'));
	});

	afterEach(() => {
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	const write = (relativePath: string, content = 'data') => {
		const filePath = path.join(dataDir, relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, content);
		return filePath;
	};

	it('removes uploaded packages with their extracted media, avatars and temporary copies', () => {
		write('uploads/game.siq');
		write('uploads/media/package-1/Images/pic.png');
		write('package/package-1/content.xml');
		write('media/package-1/Sounds/theme.mp3');
		write('avatars/abc/avatar.png');

		const { removed, failed } = cleanupDataDir(dataDir);

		expect(failed).toEqual([]);
		expect(removed.length).toBeGreaterThanOrEqual(5);

		for (const subDir of ['uploads', 'package', 'media', 'avatars']) {
			expect(fs.readdirSync(path.join(dataDir, subDir))).toEqual([]);
		}
	});

	it('keeps the data directory itself and ignores the sub directories it does not have', () => {
		write('uploads/game.siq');

		const { removed, failed } = cleanupDataDir(dataDir);

		expect(failed).toEqual([]);
		expect(removed).toEqual([path.join(dataDir, 'uploads', 'game.siq')]);
		expect(fs.existsSync(dataDir)).toBe(true);
	});

	it('does not touch files outside the data directory', () => {
		const sibling = path.join(path.dirname(dataDir), `si-cleanup-sibling-${Date.now()}.txt`);
		fs.writeFileSync(sibling, 'keep me');
		write('uploads/game.siq');

		try {
			cleanupDataDir(dataDir);
			expect(fs.existsSync(sibling)).toBe(true);
		} finally {
			fs.rmSync(sibling, { force: true });
		}
	});

	it('does nothing for a directory that does not exist yet', () => {
		const logs: string[] = [];
		const { removed, failed } = cleanupDataDir(path.join(dataDir, 'missing'), message => logs.push(message));

		expect({ removed, failed, logs }).toEqual({ removed: [], failed: [], logs: [] });
	});

	it('reports a directory it cannot read instead of failing', () => {
		write('uploads/game.siq');

		// A file instead of a directory makes `readdirSync` fail the same way a permission error does
		fs.rmSync(path.join(dataDir, 'uploads'), { recursive: true, force: true });
		fs.writeFileSync(path.join(dataDir, 'uploads'), 'not a directory');

		const logs: string[] = [];
		const { failed } = cleanupDataDir(dataDir, message => logs.push(message));

		expect(failed).toEqual([path.join(dataDir, 'uploads')]);
		expect(logs[0]).toContain('uploads');
	});
});
