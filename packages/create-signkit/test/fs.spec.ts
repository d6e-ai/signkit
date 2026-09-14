import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKUP_DIR_MODE, BACKUP_FILE_MODE } from '../src/constants.js';
import { createNodeFileSystem } from '../src/runtime/fs.js';

describe('createNodeFileSystem', () => {
	it.skipIf(process.platform === 'win32')(
		'creates directories with the requested mode at mkdir time',
		async () => {
			const fs = createNodeFileSystem();
			const root = await mkdtemp(join(tmpdir(), 'create-signkit-fs-'));
			const dir = join(root, 'backups');
			try {
				await fs.mkdir(dir, { mode: BACKUP_DIR_MODE });
				expect((await stat(dir)).mode & 0o777).toBe(BACKUP_DIR_MODE);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	);

	it.skipIf(process.platform === 'win32')(
		'chmod tightens an existing directory that recursive mkdir does not restat',
		async () => {
			const fs = createNodeFileSystem();
			const root = await mkdtemp(join(tmpdir(), 'create-signkit-fs-existing-'));
			const dir = join(root, 'backups');
			try {
				await mkdir(dir, { recursive: true });
				await chmod(dir, 0o755);
				await fs.mkdir(dir, { mode: BACKUP_DIR_MODE });
				expect((await stat(dir)).mode & 0o777).toBe(0o755);
				await fs.chmod(dir, BACKUP_DIR_MODE);
				expect((await stat(dir)).mode & 0o777).toBe(BACKUP_DIR_MODE);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	);

	it.skipIf(process.platform === 'win32')('chmod is fail-closed on POSIX', async () => {
		const fs = createNodeFileSystem();
		const missing = join(tmpdir(), 'create-signkit-missing-chmod', 'nope');
		await expect(fs.chmod(missing, BACKUP_FILE_MODE)).rejects.toThrow();
	});

	it.skipIf(process.platform !== 'win32')('chmod is best-effort on Windows', async () => {
		const fs = createNodeFileSystem();
		const missing = join(tmpdir(), 'create-signkit-missing-chmod', 'nope');
		await expect(fs.chmod(missing, BACKUP_FILE_MODE)).resolves.toBeUndefined();
	});
});
