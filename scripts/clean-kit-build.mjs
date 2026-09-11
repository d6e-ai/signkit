import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const generatedDirectories = [
	new URL('../.svelte-kit/output/', import.meta.url),
	new URL('../.svelte-kit/cloudflare/', import.meta.url),
	new URL('../.svelte-kit/cloudflare-tmp/', import.meta.url)
];

for (const generatedDirectory of generatedDirectories) {
	await rm(fileURLToPath(generatedDirectory), { force: true, recursive: true });
}
