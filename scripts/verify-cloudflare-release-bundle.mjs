#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));
const script = join(root, 'packages/create-signkit/scripts/verify-release-bundle.mjs');
const child = spawn(process.execPath, [script], {
	cwd: join(root, 'packages/create-signkit'),
	stdio: 'inherit',
	env: process.env
});
child.on('exit', (code) => {
	process.exit(code ?? 1);
});
