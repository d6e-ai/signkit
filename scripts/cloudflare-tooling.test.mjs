import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'jsonc-parser';
import config from '../cloudflare.config.ts';
import { buildEnvironment, contextConfiguration } from './build-cloudflare-output.mjs';

test('offline build environment omits credentials and runtime secrets', () => {
	const source = {
		PATH: '/safe/bin',
		HOME: '/safe/home',
		SIGNKIT_D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
		CLOUDFLARE_API_TOKEN: 'synthetic-not-a-token',
		CLOUDFLARE_ACCOUNT_ID: 'synthetic-account',
		D6E_AUTH_CLIENT_SECRET: 'synthetic-secret',
		SESSION_ENCRYPTION_KEY: 'synthetic-key',
		DATABASE_URL: 'synthetic-database-url',
		NODE_OPTIONS: '--import=/untrusted/module',
		CI: '0',
		CLOUDFLARE_SEND_METRICS: 'true'
	};
	assert.deepEqual(buildEnvironment(source, '/private-build'), {
		PATH: source.PATH,
		HOME: source.HOME,
		SIGNKIT_D1_DATABASE_ID: source.SIGNKIT_D1_DATABASE_ID,
		CI: '1',
		CF_SEND_TELEMETRY: 'false',
		WRANGLER_SEND_METRICS: 'false',
		DO_NOT_TRACK: '1',
		CLOUDFLARE_AUTH_USE_KEYRING: 'false',
		XDG_CONFIG_HOME: '/private-build/.config'
	});
	assert.deepEqual(buildEnvironment({}, '/private-build'), {
		CI: '1',
		CF_SEND_TELEMETRY: 'false',
		WRANGLER_SEND_METRICS: 'false',
		DO_NOT_TRACK: '1',
		CLOUDFLARE_AUTH_USE_KEYRING: 'false',
		XDG_CONFIG_HOME: '/private-build/.config'
	});
});

test('isolated context imports both authoritative configs and only overrides build paths', () => {
	const repository = '/tmp/repository with spaces';
	const files = contextConfiguration(repository);
	assert.deepEqual(Object.keys(files), ['cloudflare.config.ts', 'wrangler.config.ts']);
	assert.match(files['cloudflare.config.ts'], /repository%20with%20spaces\/cloudflare\.config\.ts/);
	assert.match(files['cloudflare.config.ts'], /\.\.\.config\.worker, entrypoint:/);
	assert.ok(
		files['cloudflare.config.ts'].includes(
			JSON.stringify(join(repository, 'cloudflare-worker.mjs'))
		)
	);
	assert.match(files['wrangler.config.ts'], /repository%20with%20spaces\/wrangler\.config\.ts/);
	assert.match(files['wrangler.config.ts'], /\.\.\.config, assetsDirectory:/);
	assert.ok(
		files['wrangler.config.ts'].includes(JSON.stringify(join(repository, '.svelte-kit/cloudflare')))
	);
	assert.doesNotMatch(files['cloudflare.config.ts'], /env:|compatibilityDate:|triggers:/);
});

test('cf runtime metadata remains consistent with the legacy and SvelteKit profiles', async () => {
	const legacy = parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
	const adapter = parse(
		await readFile(new URL('../wrangler.build.jsonc', import.meta.url), 'utf8')
	);
	assert.equal(config.worker.name, legacy.name);
	assert.equal(config.worker.compatibilityDate, legacy.compatibility_date);
	assert.equal(config.worker.compatibilityDate, adapter.compatibility_date);
	assert.deepEqual(config.worker.compatibilityFlags, legacy.compatibility_flags);
	assert.deepEqual(config.worker.compatibilityFlags, adapter.compatibility_flags);
	assert.equal(config.worker.entrypoint, legacy.main);
	assert.equal(legacy.keep_vars, true);
	assert.deepEqual(config.worker.unsafe.metadata.keep_bindings, [
		'plain_text',
		'json',
		'secret_text',
		'secret_key'
	]);
	assert.deepEqual(Object.keys(config.worker.env).sort(), [
		'ASSETS',
		'DB',
		'EMAIL',
		'OBJECTS',
		'SIGNKIT_MAIL_PROVIDER'
	]);
	assert.equal(config.worker.env.DB.name, legacy.d1_databases[0].database_name);
	assert.equal(config.worker.env.OBJECTS.name, legacy.r2_buckets[0].bucket_name);
	assert.equal(config.worker.env.SIGNKIT_MAIL_PROVIDER.value, legacy.vars.SIGNKIT_MAIL_PROVIDER);
	assert.deepEqual(
		config.worker.triggers.map((trigger) => trigger.schedule),
		legacy.triggers.crons
	);
	assert.equal(
		config.worker.observability.headSamplingRate,
		legacy.observability.head_sampling_rate
	);
});
