#!/usr/bin/env node
/**
 * Build the GitHub Release assets for create-signkit:
 * a prebundled Cloudflare Worker tarball, a validated manifest, and SHA256SUMS.
 *
 * Requires a prior `pnpm run build:cloudflare` so cf Build Output exists.
 * Does not deploy, and does not need Cloudflare credentials.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, stat, cp, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { readBuildOutput } from '@cloudflare/build-output-utils';

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));
const REPOSITORY = 'd6e-ai/signkit';
const MANIFEST_NAME = 'signkit-cloudflare-manifest.json';
const MIGRATION_POLICY = {
	schemaEpoch: 'single-instance-v1',
	compatibility: 'additive-within-schema-epoch',
	notes:
		'D1 migrations are additive within one schema epoch. create-signkit refuses an in-place upgrade across schema epochs unless the selected D1 is fresh. It applies pending migrations before uploading the Worker; Worker rollback cannot roll back D1.'
};

const { resolveReleaseTag, channelFromReleaseTag } = await import(
	pathToFileURL(join(ROOT, 'packages/create-signkit/dist/release/semver.js')).href
);
const tag = resolveReleaseTag(process.env);
const commit = (process.env.GITHUB_SHA ?? '').replace(/[^0-9a-f]/g, '').slice(0, 40);
let channel;
try {
	channel = channelFromReleaseTag(tag);
} catch (error) {
	throw new Error(
		`SIGNKIT_RELEASE_TAG/GITHUB_REF_NAME must be a semver tag without build metadata, got ${JSON.stringify(tag)}: ${error instanceof Error ? error.message : String(error)}`,
		{ cause: error }
	);
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
	throw new Error('GITHUB_SHA must be a 40-character commit');
}

const output = await readBuildOutput(ROOT);
const worker = output.workers.default;
if (!worker.bundleDir || !worker.assetsDir || !worker.config.manifest) {
	throw new Error(
		'cf Build Output must contain both the scheduled Worker bundle and static assets'
	);
}
const { compatibilityDate, compatibilityFlags } = worker.config;
const { env, triggers, observability } = worker.config;
if (
	env.DB?.type !== 'd1' ||
	env.OBJECTS?.type !== 'r2' ||
	env.ASSETS?.type !== 'assets' ||
	env.EMAIL?.type !== 'send-email' ||
	Object.entries(env).some(
		([name, binding]) =>
			!['DB', 'OBJECTS', 'ASSETS', 'EMAIL'].includes(name) && binding.type !== 'text'
	) ||
	triggers?.some((trigger) => trigger.type !== 'scheduled')
) {
	throw new Error(
		'cf runtime metadata cannot be represented by the v1 release compatibility config'
	);
}
const migrationsDir = join(ROOT, 'migrations/d1');
await stat(migrationsDir);

const staging = join(ROOT, '.release/cloudflare-bundle');
const outDir = join(ROOT, '.release/assets');
const bundleName = `signkit-cloudflare-${tag}.tar.gz`;
await rm(staging, { recursive: true, force: true });
await rm(join(outDir, bundleName), { force: true });
await rm(join(outDir, MANIFEST_NAME), { force: true });
await rm(join(outDir, 'SHA256SUMS'), { force: true });
await mkdir(join(staging, 'worker'), { recursive: true });
await mkdir(join(staging, 'assets'), { recursive: true });
await mkdir(join(staging, 'migrations/d1'), { recursive: true });
await mkdir(outDir, { recursive: true });

await cp(worker.bundleDir, join(staging, 'worker'), { recursive: true });
await cp(worker.assetsDir, join(staging, 'assets'), { recursive: true });
await cp(migrationsDir, join(staging, 'migrations/d1'), { recursive: true });

const workerFiles = (await readdir(join(staging, 'worker'))).sort();
const workerModule = worker.config.manifest.mainModule;
if (!workerFiles.includes(workerModule)) {
	throw new Error('cf Build Output entrypoint must be a top-level bundled Worker module');
}
const workerEntry = `worker/${workerModule}`;

const wranglerConfig = {
	name: worker.config.name,
	main: workerEntry,
	compatibility_date: compatibilityDate,
	compatibility_flags: compatibilityFlags,
	keep_vars: true,
	unsafe: worker.config.unsafe,
	assets: { directory: 'assets', binding: 'ASSETS' },
	d1_databases: [
		{
			binding: 'DB',
			database_name: env.DB.name,
			database_id: 'REPLACE_AT_DEPLOY',
			migrations_dir: 'migrations/d1'
		}
	],
	r2_buckets: [{ binding: 'OBJECTS', bucket_name: env.OBJECTS.name }],
	send_email: [{ name: 'EMAIL' }],
	vars: Object.fromEntries(
		Object.entries(env)
			.filter(([, binding]) => binding.type === 'text')
			.map(([name, binding]) => [name, binding.value])
	),
	triggers: { crons: (triggers ?? []).map((trigger) => trigger.schedule) },
	observability: observability && {
		enabled: observability.enabled,
		head_sampling_rate: observability.headSamplingRate
	}
};
await writeFile(join(staging, 'wrangler.jsonc'), `${JSON.stringify(wranglerConfig, null, '\t')}\n`);

const bundlePath = join(outDir, bundleName);
await run('tar', [
	'-czf',
	bundlePath,
	'-C',
	staging,
	'worker',
	'assets',
	'migrations',
	'wrangler.jsonc'
]);

const bundleBytes = await readFile(bundlePath);
const sha256 = createHash('sha256').update(bundleBytes).digest('hex');
const manifest = {
	schemaVersion: 1,
	kind: 'signkit-cloudflare-release',
	repository: REPOSITORY,
	tag,
	commit,
	channel,
	createdAt: new Date().toISOString(),
	bundle: {
		assetName: bundleName,
		contentType: 'application/gzip',
		size: bundleBytes.byteLength,
		sha256
	},
	worker: {
		main: workerEntry,
		compatibilityDate,
		compatibilityFlags,
		assetsDirectory: 'assets',
		migrationsDirectory: 'migrations/d1'
	},
	bindings: { d1: 'DB', r2: 'OBJECTS', assets: 'ASSETS', email: 'EMAIL' },
	requiredSecrets: [
		'DELIVERY_ENCRYPTION_KEY',
		'SESSION_ENCRYPTION_KEY',
		'DELIVERY_WORKER_SECRET',
		'D6E_AUTH_CLIENT_ID',
		'D6E_AUTH_CLIENT_SECRET'
	],
	requiredVars: [
		'D6E_AUTH_BASE_URL',
		'SIGNKIT_PUBLIC_ORIGIN',
		'SIGNKIT_EMAIL_FROM',
		'SIGNKIT_EMAIL_FROM_NAME',
		'SIGNKIT_MAIL_PROVIDER',
		'SIGNKIT_BOOTSTRAP_OWNER_EMAIL'
	],
	migrationPolicy: MIGRATION_POLICY
};

const manifestPath = join(outDir, MANIFEST_NAME);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
const manifestSha = createHash('sha256')
	.update(await readFile(manifestPath))
	.digest('hex');
await writeFile(
	join(outDir, 'SHA256SUMS'),
	`${sha256}  ${bundleName}\n${manifestSha}  ${MANIFEST_NAME}\n`
);

console.log(`Wrote ${bundlePath}`);
console.log(`Wrote ${manifestPath}`);
console.log(`sha256 ${sha256} size ${bundleBytes.byteLength}`);

function run(file, argv) {
	return new Promise((resolve, reject) => {
		const child = spawn(file, argv, { cwd: ROOT, stdio: 'inherit' });
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${file} ${argv.join(' ')} exited ${code}`));
		});
	});
}
