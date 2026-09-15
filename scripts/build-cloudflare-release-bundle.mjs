#!/usr/bin/env node
/**
 * Build the GitHub Release assets for create-signkit:
 * a prebundled Cloudflare Worker tarball, a validated manifest, and SHA256SUMS.
 *
 * Requires a prior `pnpm run build:cloudflare` so `.svelte-kit/cloudflare` exists.
 * Does not deploy, and does not need Cloudflare credentials (`wrangler deploy --dry-run`).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, stat, cp, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { parse as parseJsonc } from 'jsonc-parser';

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));
const REPOSITORY = 'd6e-ai/signkit';
const MANIFEST_NAME = 'signkit-cloudflare-manifest.json';
const MIGRATION_POLICY = {
	compatibility: 'forward-and-backward-compatible-within-released-versions',
	notes:
		'Released D1 migrations are additive and must remain backward-compatible with the previous released Worker. create-signkit applies pending migrations before uploading a new Worker version so the still-serving previous Worker can run on the new schema. Worker rollback cannot roll back D1. Do not restore SQL by rolling back a Worker.'
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

const { compatibilityDate, compatibilityFlags } = readRootWranglerCompat(
	await readFile(join(ROOT, 'wrangler.jsonc'), 'utf8')
);

const cloudflareDir = join(ROOT, '.svelte-kit/cloudflare');
const migrationsDir = join(ROOT, 'migrations/d1');
await stat(cloudflareDir);
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

const wranglerBin = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
await run(process.execPath, [
	wranglerBin,
	'deploy',
	'--dry-run',
	'--outdir',
	join(staging, 'worker'),
	'--keep-vars'
]);

await cp(cloudflareDir, join(staging, 'assets'), { recursive: true });
await cp(migrationsDir, join(staging, 'migrations/d1'), { recursive: true });

const workerFiles = (await readdir(join(staging, 'worker'))).sort();
const workerEntry = workerMain(workerFiles);

const wranglerConfig = {
	name: 'signkit',
	main: workerEntry,
	compatibility_date: compatibilityDate,
	compatibility_flags: compatibilityFlags,
	assets: { directory: 'assets', binding: 'ASSETS' },
	d1_databases: [
		{
			binding: 'DB',
			database_name: 'signkit',
			database_id: 'REPLACE_AT_DEPLOY',
			migrations_dir: 'migrations/d1'
		}
	],
	r2_buckets: [{ binding: 'OBJECTS', bucket_name: 'signkit-objects' }],
	send_email: [{ name: 'EMAIL' }],
	vars: { SIGNKIT_MAIL_PROVIDER: 'cloudflare' },
	triggers: { crons: ['* * * * *'] },
	observability: { enabled: true, head_sampling_rate: 1 }
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

function workerMain(files) {
	const names = [...files].sort();
	if (names.includes('index.js')) return 'worker/index.js';
	const js = names.filter((name) => name.endsWith('.js'));
	if (js.length === 1) return `worker/${js[0]}`;
	if (js.length === 0) {
		throw new Error('wrangler --dry-run --outdir did not produce a bundled Worker JS entry');
	}
	throw new Error(`ambiguous Worker JS entries in dry-run output: ${js.join(', ')}`);
}

function readRootWranglerCompat(source) {
	const errors = [];
	const parsed = parseJsonc(source, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		throw new Error(
			`failed to parse wrangler.jsonc: ${errors.map((error) => error.message ?? 'parse error').join('; ')}`
		);
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new Error('wrangler.jsonc must be an object');
	}
	const compatibilityDate = parsed.compatibility_date;
	const compatibilityFlags = parsed.compatibility_flags;
	if (typeof compatibilityDate !== 'string' || compatibilityDate.length === 0) {
		throw new Error('wrangler.jsonc is missing compatibility_date');
	}
	if (!Array.isArray(compatibilityFlags)) {
		throw new Error('wrangler.jsonc is missing compatibility_flags');
	}
	return { compatibilityDate, compatibilityFlags };
}

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
