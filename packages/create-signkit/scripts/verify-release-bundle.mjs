#!/usr/bin/env node
/**
 * Verify a generated Cloudflare release bundle against the v1 manifest schema,
 * create-signkit's runtime parser, size/hash, and required archive paths.
 *
 * Requires `pnpm run build:create-signkit` and a prior bundle build under
 * `.release/assets`. Does not publish or deploy.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const packageDir = dirname(fileURLToPath(new URL('.', import.meta.url)));
const repoRoot = join(packageDir, '../..');
const distDir = join(packageDir, 'dist');
await stat(join(distDir, 'release/manifest.js'));

const { parseReleaseManifest } = await import(
	pathToFileURL(join(distDir, 'release/manifest.js')).href
);
const { resolveReleaseTag, parseReleaseTag } = await import(
	pathToFileURL(join(distDir, 'release/semver.js')).href
);
const { createTarGzExtractor } = await import(
	pathToFileURL(join(distDir, 'release/extract.js')).href
);
const { createNodeFileSystem } = await import(pathToFileURL(join(distDir, 'runtime/fs.js')).href);
const { sha256Hex } = await import(pathToFileURL(join(distDir, 'release/github.js')).href);

const require = createRequire(join(packageDir, 'package.json'));
const { default: Ajv2020 } = await import(pathToFileURL(require.resolve('ajv/dist/2020.js')).href);
const addFormats = (await import(pathToFileURL(require.resolve('ajv-formats')).href)).default;

const tag = resolveReleaseTag(process.env);
const commit = (process.env.GITHUB_SHA ?? '').replace(/[^0-9a-f]/g, '').slice(0, 40);
if (!tag) {
	throw new Error('SIGNKIT_RELEASE_TAG/GITHUB_REF_NAME is required');
}
try {
	parseReleaseTag(tag);
} catch (error) {
	throw new Error(
		`SIGNKIT_RELEASE_TAG/GITHUB_REF_NAME must be a semver tag without build metadata: ${error instanceof Error ? error.message : String(error)}`,
		{ cause: error }
	);
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
	throw new Error('GITHUB_SHA must be a 40-character commit');
}

const schema = JSON.parse(
	await readFile(join(packageDir, 'schema/release-manifest.v1.json'), 'utf8')
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const assetsDir = join(repoRoot, '.release/assets');
const manifestPath = join(assetsDir, 'signkit-cloudflare-manifest.json');
const manifestRaw = await readFile(manifestPath, 'utf8');
const manifestJson = JSON.parse(manifestRaw);
if (!validate(manifestJson)) {
	throw new Error(`release manifest failed schema validation: ${ajv.errorsText(validate.errors)}`);
}

const parsed = parseReleaseManifest(manifestRaw, { tag, commit });
const bundlePath = join(assetsDir, parsed.bundle.assetName);
const bundleBytes = await readFile(bundlePath);
if (bundleBytes.byteLength !== parsed.bundle.size) {
	throw new Error(
		`bundle size ${bundleBytes.byteLength} does not match manifest ${parsed.bundle.size}`
	);
}
const digest = sha256Hex(
	new Uint8Array(bundleBytes.buffer, bundleBytes.byteOffset, bundleBytes.byteLength)
);
if (digest !== parsed.bundle.sha256) {
	throw new Error('bundle SHA-256 does not match the release manifest');
}

const fs = createNodeFileSystem();
const dest = await mkdtemp(join(tmpdir(), 'signkit-bundle-verify-'));
try {
	const extracted = await createTarGzExtractor(fs).extract(
		new Uint8Array(bundleBytes.buffer, bundleBytes.byteOffset, bundleBytes.byteLength),
		dest,
		parsed
	);
	const required = [
		extracted.main,
		extracted.assetsDirectory,
		extracted.migrationsDirectory,
		extracted.configPath
	];
	for (const path of required) {
		if (!(await fs.exists(path))) {
			throw new Error(`extracted bundle is missing required path ${path}`);
		}
	}
} finally {
	await rm(dest, { recursive: true, force: true });
}

console.log(`Verified ${parsed.bundle.assetName} (${parsed.bundle.size} bytes, sha256 ${digest})`);
