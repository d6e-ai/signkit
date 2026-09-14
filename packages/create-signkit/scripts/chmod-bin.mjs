#!/usr/bin/env node
import { chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(new URL('.', import.meta.url))), 'dist/bin.js');
try {
	await chmod(bin, 0o755);
} catch (error) {
	if (process.platform === 'win32') {
		process.exit(0);
	}
	throw error;
}
