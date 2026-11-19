import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnvironment } from '../../scripts/build-cloudflare-output.mjs';

const services = dirname(fileURLToPath(import.meta.url));
const root = resolve(services, '../..');
const require = createRequire(import.meta.url);
const buildSettings = [
	'SEAL_WORKER_PREFIX',
	'SEAL_WORKER_ROLE',
	'SEAL_ISSUER',
	'SEAL_AUDIENCE',
	'SEAL_CERTIFICATE_SHA256',
	'SEAL_POLICY_ID',
	'VALIDATION_POLICY_ID',
	'SEAL_AUTHORIZATION_PUBLIC_KEY',
	'SEAL_EVIDENCE_DB_ID',
	'SEAL_EVIDENCE_BUCKET',
	'SEAL_LEDGER_DB_ID',
	'SEAL_RESULT_BUCKET'
];

if (process.argv.length !== 3) throw new Error('Pass a new directory for the prebuilt service');
const output = resolve(process.argv[2]);
const context = await mkdtemp(join(tmpdir(), 'signkit-seal-build-'));

try {
	const { devDependencies } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
	await Promise.all([
		...['src', 'node_modules', '.svelte-kit'].map((name) =>
			symlink(join(root, name), join(context, name), 'dir')
		),
		...['cloudflare', 'gateway', 'engine', 'validator'].map((name) =>
			symlink(join(services, name), join(context, name), 'dir')
		),
		cp(join(root, 'tsconfig.json'), join(context, 'tsconfig.json')),
		cp(join(services, 'cloudflare.config.ts'), join(context, 'cloudflare.config.ts')),
		writeFile(
			join(context, 'package.json'),
			JSON.stringify({
				name: 'signkit-seal-service-build',
				private: true,
				type: 'module',
				dependencies: { cf: devDependencies.cf, wrangler: devDependencies.wrangler }
			})
		),
		writeFile(
			join(context, 'wrangler.config.ts'),
			`import { defineWranglerConfig } from 'wrangler/experimental-config';
export default defineWranglerConfig({ types: { generate: false } });
`
		)
	]);
	const env = buildEnvironment(process.env, context);
	for (const name of buildSettings) {
		if (process.env[name] !== undefined) env[name] = process.env[name];
	}
	const cfBin = join(dirname(require.resolve('cf/package.json')), 'bin/cf');
	await new Promise((resolveBuild, reject) => {
		const child = spawn(process.execPath, [cfBin, 'build'], {
			cwd: context,
			env,
			stdio: 'inherit'
		});
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolveBuild();
			else reject(new Error(`cf build exited ${code}`));
		});
	});
	await mkdir(output, { mode: 0o700 });
	await cp(join(context, '.cloudflare'), join(output, '.cloudflare'), { recursive: true });
} finally {
	await rm(context, { recursive: true, force: true });
}
