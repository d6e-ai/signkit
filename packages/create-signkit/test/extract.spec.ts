import { mkdir, mkdtemp, readFile, rm, symlink, link, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create as tarCreate } from 'tar';
import { describe, expect, it } from 'vitest';
import {
	assertAllowedTarMember,
	destinationUnderRoot,
	extractTarGz,
	normalizeEntryPath
} from '../src/release/extract.js';

describe('archive extraction safety', () => {
	it('rejects path traversal members', () => {
		expect(normalizeEntryPath('../etc/passwd')).toBeUndefined();
		expect(normalizeEntryPath('/etc/passwd')).toBeUndefined();
		expect(normalizeEntryPath('C:\\windows\\system32')).toBeUndefined();
		expect(normalizeEntryPath('worker/index.js')).toBe('worker/index.js');
		expect(destinationUnderRoot('/tmp/bundle', '../etc/passwd')).toBeUndefined();
		expect(destinationUnderRoot('/tmp/bundle', 'worker/index.js')).toBe(
			'/tmp/bundle/worker/index.js'
		);
	});

	it('rejects symlinks, hardlinks, devices, FIFOs, and other non-file types', () => {
		expect(() => assertAllowedTarMember('evil', 'SymbolicLink')).toThrow(/not a regular file/);
		expect(() => assertAllowedTarMember('evil', 'Link')).toThrow(/not a regular file/);
		expect(() => assertAllowedTarMember('evil', 'CharacterDevice')).toThrow(/not a regular file/);
		expect(() => assertAllowedTarMember('evil', 'BlockDevice')).toThrow(/not a regular file/);
		expect(() => assertAllowedTarMember('evil', 'FIFO')).toThrow(/not a regular file/);
		expect(() => assertAllowedTarMember('x', 'ExtendedHeader')).toThrow(/not a regular file/);
		expect(() => assertAllowedTarMember('g', 'GlobalExtendedHeader')).toThrow(/not a regular file/);
		expect(() => assertAllowedTarMember('L', 'NextFileHasLongPath')).toThrow(/not a regular file/);
		expect(() => assertAllowedTarMember('worker.js', 'File')).not.toThrow();
		expect(() => assertAllowedTarMember('assets', 'Directory')).not.toThrow();
	});

	it('extracts a bounded tar.gz into the destination directory', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'create-signkit-out-'));
		try {
			const source = await mkdtemp(join(dir, 'src-'));
			await writeFile(join(source, 'worker.js'), 'export default {}\n');
			const archivePath = join(dir, 'bundle.tar.gz');
			await tarCreate({ gzip: true, file: archivePath, cwd: source }, ['worker.js']);
			const bytes = new Uint8Array(await readFile(archivePath));
			const dest = join(dir, 'dest');
			await mkdir(dest, { recursive: true });
			await extractTarGz(bytes, dest);
			expect(await readFile(join(dest, 'worker.js'), 'utf8')).toBe('export default {}\n');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('refuses a malicious archive containing a symlink', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'create-signkit-link-'));
		try {
			const source = await mkdtemp(join(dir, 'src-'));
			await symlink('/etc/passwd', join(source, 'link'));
			const archivePath = join(dir, 'evil.tar.gz');
			await tarCreate({ gzip: true, file: archivePath, cwd: source }, ['link']);
			const bytes = new Uint8Array(await readFile(archivePath));
			const dest = join(dir, 'dest');
			await mkdir(dest, { recursive: true });
			await expect(extractTarGz(bytes, dest)).rejects.toThrow(/not a regular file|unsafe path/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('refuses a malicious archive containing a hardlink', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'create-signkit-hard-'));
		try {
			const source = await mkdtemp(join(dir, 'src-'));
			await writeFile(join(source, 'target'), 'secret\n');
			await link(join(source, 'target'), join(source, 'hard'));
			const archivePath = join(dir, 'evil.tar.gz');
			await tarCreate({ gzip: true, file: archivePath, cwd: source }, ['target', 'hard']);
			const bytes = new Uint8Array(await readFile(archivePath));
			const dest = join(dir, 'dest');
			await mkdir(dest, { recursive: true });
			await expect(extractTarGz(bytes, dest)).rejects.toThrow(/not a regular file/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('fails closed when uncompressed regular-file bytes exceed the limit', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'create-signkit-size-'));
		try {
			const source = await mkdtemp(join(dir, 'src-'));
			await writeFile(join(source, 'worker.js'), 'export default {}\n');
			const archivePath = join(dir, 'bundle.tar.gz');
			await tarCreate({ gzip: true, file: archivePath, cwd: source }, ['worker.js']);
			const bytes = new Uint8Array(await readFile(archivePath));
			const dest = join(dir, 'dest');
			await mkdir(dest, { recursive: true });
			await expect(extractTarGz(bytes, dest, { maxUncompressedBytes: 4 })).rejects.toThrow(
				/uncompressed size exceeds limit/
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('fails closed when the archive entry count exceeds the limit', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'create-signkit-count-'));
		try {
			const source = await mkdtemp(join(dir, 'src-'));
			await writeFile(join(source, 'a.js'), 'a\n');
			await writeFile(join(source, 'b.js'), 'b\n');
			await writeFile(join(source, 'c.js'), 'c\n');
			const archivePath = join(dir, 'bundle.tar.gz');
			await tarCreate({ gzip: true, file: archivePath, cwd: source }, ['a.js', 'b.js', 'c.js']);
			const bytes = new Uint8Array(await readFile(archivePath));
			const dest = join(dir, 'dest');
			await mkdir(dest, { recursive: true });
			await expect(extractTarGz(bytes, dest, { maxEntries: 2 })).rejects.toThrow(
				/entry count exceeds limit/
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
