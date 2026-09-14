#!/usr/bin/env node
import { copyFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = dirname(fileURLToPath(new URL('.', import.meta.url)));
const destination = join(packageDir, 'LICENSE');

async function findRootLicense(start) {
	let current = start;
	for (let i = 0; i < 8; i += 1) {
		const candidate = join(current, 'LICENSE');
		try {
			await access(candidate);
			if (candidate !== destination) {
				return candidate;
			}
		} catch {
			// keep walking
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error('could not find repository LICENSE to include in the npm package');
}

const source = await findRootLicense(packageDir);
await copyFile(source, destination);
