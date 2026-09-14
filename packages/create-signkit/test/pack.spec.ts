import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { list as tarList } from 'tar';

const execFileAsync = promisify(execFile);
const packageDir = fileURLToPath(new URL('..', import.meta.url));

describe('npm pack contents', () => {
	it('includes dist bin, schema, README, and LICENSE, and excludes sources and secrets', async () => {
		const dest = await mkdtemp(join(tmpdir(), 'create-signkit-pack-'));
		try {
			await execFileAsync('pnpm', ['run', 'build'], { cwd: packageDir });
			await execFileAsync('pnpm', ['pack', '--pack-destination', dest], {
				cwd: packageDir
			});
			const packed = (await readdir(dest)).filter((name) => name.endsWith('.tgz'));
			expect(packed).toHaveLength(1);
			const tarball = join(dest, packed[0]!);
			const entries: string[] = [];
			await tarList({ file: tarball, onReadEntry: (entry) => entries.push(entry.path) });
			expect(entries).toContain('package/package.json');
			expect(entries).toContain('package/README.md');
			expect(entries).toContain('package/LICENSE');
			expect(entries).toContain('package/dist/bin.js');
			expect(entries.some((entry) => entry.startsWith('package/schema/'))).toBe(true);
			expect(entries.some((entry) => entry.startsWith('package/src/'))).toBe(false);
			expect(entries.some((entry) => entry.includes('test/'))).toBe(false);
			expect(entries.some((entry) => entry.includes('node_modules/'))).toBe(false);
			expect(entries.join('\n')).not.toMatch(/secret|token|credential/i);
			const bin = await readFile(join(packageDir, 'dist/bin.js'), 'utf8');
			expect(bin.startsWith('#!/usr/bin/env node')).toBe(true);
			const mode = (await stat(join(packageDir, 'dist/bin.js'))).mode;
			if (process.platform !== 'win32') {
				expect(mode & 0o111).toBeTruthy();
			}
		} finally {
			await rm(dest, { recursive: true, force: true });
		}
	}, 60_000);
});
