import { describe, expect, it } from 'vitest';
import {
	assertArgvHasNoSecrets,
	createNodeProcessRunner,
	filterEnvForWrangler
} from '../src/runtime/process.js';
import { ACCOUNT_ID } from './helpers.js';

describe('Wrangler child environment allowlist', () => {
	it('drops unrelated secrets and keeps Cloudflare auth plus OS runtime vars', () => {
		const env = filterEnvForWrangler(
			{
				PATH: '/usr/bin',
				HOME: '/home/operator',
				LANG: 'C',
				CLOUDFLARE_API_TOKEN: 'cf-super-secret-token',
				SECRET_FOO: 'should-not-leak',
				npm_config_registry: 'https://evil.example',
				NODE_OPTIONS: '--require ./evil.js'
			},
			ACCOUNT_ID
		);
		expect(env.SECRET_FOO).toBeUndefined();
		expect(env.npm_config_registry).toBeUndefined();
		expect(env.NODE_OPTIONS).toBeUndefined();
		expect(env.CLOUDFLARE_API_TOKEN).toBe('cf-super-secret-token');
		expect(env.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT_ID);
		expect(env.CI).toBe('1');
		expect(env.PATH).toBe('/usr/bin');
		expect(JSON.stringify(env)).not.toContain('should-not-leak');
	});
});

describe('argv secret detection', () => {
	it('does not treat cf- worker names as secret values', () => {
		expect(() =>
			assertArgvHasNoSecrets(['node', '/opt/wrangler/bin/wrangler.js', '--name', 'cf-production'])
		).not.toThrow();
	});

	it('still refuses secret-like values and secret-bearing flags', () => {
		expect(() => assertArgvHasNoSecrets(['node', 'wrangler.js', '--token', 'x'])).toThrow(
			/secret-bearing argv flag/
		);
		expect(() =>
			assertArgvHasNoSecrets(['node', 'wrangler.js', '--name', 'sk-live-secret'])
		).toThrow(/secret-like argv value/);
	});

	it('allows --secrets-file and --config paths but still rejects secret values elsewhere', () => {
		expect(() =>
			assertArgvHasNoSecrets([
				'node',
				'wrangler.js',
				'versions',
				'upload',
				'--config',
				'/tmp/bundle/wrangler.jsonc',
				'--name',
				'signkit',
				'--secrets-file',
				'/home/operator/.local/state/create-signkit/recovery.json',
				'--keep-vars',
				'--strict',
				'--no-bundle'
			])
		).not.toThrow();
		expect(() =>
			assertArgvHasNoSecrets([
				'node',
				'wrangler.js',
				'--secrets-file',
				'/tmp/recovery.json',
				'--name',
				'sk-live-secret'
			])
		).toThrow(/secret-like argv value/);
		expect(() => assertArgvHasNoSecrets(['node', 'wrangler.js', '--secret', 'x'])).toThrow(
			/secret-bearing argv flag/
		);
	});
});

describe('process output limits', () => {
	it('rejects oversized stdout without settling the same promise twice', async () => {
		const runner = createNodeProcessRunner({ maxOutputBytes: 8 });
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on('unhandledRejection', onUnhandled);
		try {
			await expect(
				runner.run({
					file: process.execPath,
					argv: ['-e', 'process.stdout.write("abcdefghijklmnop")']
				})
			).rejects.toThrow(/stdout exceeded size limit/);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});
});
