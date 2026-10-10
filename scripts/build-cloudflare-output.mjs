#!/usr/bin/env node
/**
 * Build the scheduled Worker with cf after SvelteKit has built the application.
 * cf beta's framework detector cannot select the application at a pnpm
 * workspace root. A private build context contains only the Cloudflare tools;
 * the application and its authoritative configuration stay at repository root.
 * No account credentials or secret files are forwarded into that context.
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));
const require = createRequire(import.meta.url);

/** Only build inputs and platform plumbing may reach the isolated cf process. */
export function buildEnvironment(source, context) {
	const keys = [
		'PATH',
		'HOME',
		'TMPDIR',
		'SYSTEMROOT',
		'LANG',
		'LC_ALL',
		'HTTP_PROXY',
		'HTTPS_PROXY',
		'NO_PROXY',
		'NODE_EXTRA_CA_CERTS',
		'SIGNKIT_D1_DATABASE_ID'
	];
	return {
		...Object.fromEntries(
			keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])
		),
		CI: '1',
		CF_SEND_TELEMETRY: 'false',
		WRANGLER_SEND_METRICS: 'false',
		DO_NOT_TRACK: '1',
		CLOUDFLARE_AUTH_USE_KEYRING: 'false',
		XDG_CONFIG_HOME: join(context, '.config')
	};
}

/** The private context only overrides paths, never runtime bindings or settings. */
export function contextConfiguration(repositoryRoot) {
	return {
		'cloudflare.config.ts': `import config from ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'cloudflare.config.ts')).href)};
export default { ...config, worker: { ...config.worker, entrypoint: ${JSON.stringify(join(repositoryRoot, 'cloudflare-worker.mjs'))} } };
`,
		'wrangler.config.ts': `import config from ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'wrangler.config.ts')).href)};
export default { ...config, assetsDirectory: ${JSON.stringify(join(repositoryRoot, '.svelte-kit/cloudflare'))} };
`
	};
}

export async function buildCloudflareOutput() {
	const cfBin = join(dirname(require.resolve('cf/package.json')), 'bin/cf');
	const context = await mkdtemp(join(tmpdir(), 'signkit-cf-build-'));
	try {
		const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
		await symlink(join(root, 'node_modules'), join(context, 'node_modules'), 'dir');
		await writeFile(
			join(context, 'package.json'),
			JSON.stringify({
				name: 'signkit-worker-build',
				private: true,
				type: 'module',
				dependencies: {
					cf: packageJson.devDependencies.cf,
					wrangler: packageJson.devDependencies.wrangler
				}
			})
		);
		for (const [name, source] of Object.entries(contextConfiguration(root))) {
			await writeFile(join(context, name), source);
		}
		await new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [cfBin, 'build'], {
				cwd: context,
				env: buildEnvironment(process.env, context),
				stdio: 'inherit'
			});
			child.on('error', reject);
			child.on('close', (code) => {
				if (code === 0) resolve();
				else reject(new Error(`cf build exited ${code}`));
			});
		});
		const destination = join(root, '.cloudflare/output/v0');
		await rm(destination, { recursive: true, force: true });
		await mkdir(destination, { recursive: true });
		await cp(join(context, '.cloudflare/output/v0'), destination, { recursive: true });
	} finally {
		await rm(context, { recursive: true, force: true });
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await buildCloudflareOutput();
}
