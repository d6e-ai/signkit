import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

	it.skipIf(process.platform === 'win32')(
		'stat uses lstat semantics: symlinks are neither files nor directories',
		async () => {
			const fs = createNodeFileSystem();
			const root = await mkdtemp(join(tmpdir(), 'create-signkit-fs-link-'));
			try {
				const target = join(root, 'target.json');
				const link = join(root, 'link.json');
				const dirLink = join(root, 'dir-link');
				await writeFile(target, '{}');
				await symlink(target, link);
				await symlink(root, dirLink);
				const linkStat = await fs.stat(link);
				expect(linkStat.isSymlink).toBe(true);
				expect(linkStat.isFile).toBe(false);
				expect(linkStat.isDirectory).toBe(false);
				const dirLinkStat = await fs.stat(dirLink);
				expect(dirLinkStat.isSymlink).toBe(true);
				expect(dirLinkStat.isDirectory).toBe(false);
				const fileStat = await fs.stat(target);
				expect(fileStat.isSymlink).toBe(false);
				expect(fileStat.isFile).toBe(true);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	);

	it.skipIf(process.platform === 'win32')(
		'writeFileExclusive refuses to overwrite an existing path',
		async () => {
			const fs = createNodeFileSystem();
			const root = await mkdtemp(join(tmpdir(), 'create-signkit-fs-excl-'));
			try {
				const file = join(root, 'recovery.json');
				await fs.writeFileExclusive(file, '{}', 0o600);
				expect((await stat(file)).mode & 0o777).toBe(0o600);
				await expect(fs.writeFileExclusive(file, '{}', 0o600)).rejects.toThrow();
				await fs.fsync(file);
				await fs.fsync(root);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	);
});
