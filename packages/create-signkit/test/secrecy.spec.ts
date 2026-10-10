import { describe, expect, it } from 'vitest';
import { createCloudflareClient } from '../src/providers/cloudflare/cloudflare-client.js';
import { filterEnvForCloudflareCli } from '../src/runtime/process.js';
import { runCreateSignkit } from '../src/cli/run.js';
import { envHasSecretName } from '../src/runtime/process.js';
import { ACCOUNT_ID, RecordingProcessRunner } from './helpers.js';

describe('command argv and env secrecy', () => {
	it('passes CLOUDFLARE_ACCOUNT_ID only in the child environment, never on argv (cf)', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout: JSON.stringify([{ uuid: '11111111-1111-1111-1111-111111111111', name: 'signkit' }]),
			stderr: ''
		});
		const cloudflare = createCloudflareClient({
			runner,
			accountId: ACCOUNT_ID,
			env: {
				CLOUDFLARE_API_TOKEN: 'cf-super-secret-token',
				PATH: '/usr/bin',
				SECRET_FOO: 'should-not-leak'
			},
			cfBin: '/opt/cf/bin/cf',
			nodeExecutable: '/usr/bin/node'
		});
		await cloudflare.listD1();
		expect(runner.requests).toHaveLength(1);
		const request = runner.requests[0]!;
		expect(request.cwd).toMatch(/create-signkit-cf-/);
		expect(request.cwd).not.toBe('/opt/cf/bin');
		expect(request.argv.join(' ')).not.toContain(ACCOUNT_ID);
		expect(request.argv.join(' ')).not.toContain('cf-super-secret-token');
		expect(request.argv).toEqual([
			'/opt/cf/bin/cf',
			'd1',
			'list',
			'--page',
			'1',
			'--per-page',
			'50'
		]);
		expect(request.env?.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT_ID);
		expect(request.env?.CLOUDFLARE_API_TOKEN).toBe('cf-super-secret-token');
		expect(request.env?.SECRET_FOO).toBeUndefined();
		expect(envHasSecretName('CLOUDFLARE_API_TOKEN')).toBe(true);
		expect(envHasSecretName('CLOUDFLARE_ACCOUNT_ID')).toBe(false);
	});

	it('preserves dashboard vars by passing --keep-vars and never puts secret values on argv (Wrangler deploy)', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout:
				'Deployed\nVersion ID: 22222222-2222-2222-2222-222222222222\nhttps://signkit.example.workers.dev',
			stderr: ''
		});
		const cloudflare = createCloudflareClient({
			runner,
			accountId: ACCOUNT_ID,
			env: { CLOUDFLARE_API_TOKEN: 'cf-super-secret-token' },
			wranglerBin: '/opt/wrangler/bin/wrangler.js',
			nodeExecutable: '/usr/bin/node'
		});
		await cloudflare.deploy({
			cwd: '/tmp/bundle',
			configPath: '/tmp/bundle/wrangler.jsonc',
			workerName: 'signkit',
			keepVars: true,
			noBundle: true
		});
		const argv = runner.requests[0]!.argv;
		expect(argv[0]).toBe('/opt/wrangler/bin/wrangler.js');
		expect(argv).toContain('--keep-vars');
		expect(argv.join(' ')).not.toMatch(/cf-super-secret-token|DELIVERY_ENCRYPTION_KEY=/);
	});

	it('passes --secrets-file by path only and never puts secret values on argv (Wrangler deploy)', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout:
				'Deployed\nVersion ID: 22222222-2222-2222-2222-222222222222\nhttps://signkit.example.workers.dev',
			stderr: ''
		});
		const cloudflare = createCloudflareClient({
			runner,
			accountId: ACCOUNT_ID,
			env: { CLOUDFLARE_API_TOKEN: 'cf-super-secret-token' },
			wranglerBin: '/opt/wrangler/bin/wrangler.js',
			nodeExecutable: '/usr/bin/node'
		});
		await cloudflare.deploy({
			cwd: '/tmp/bundle',
			configPath: '/tmp/bundle/wrangler.jsonc',
			workerName: 'signkit',
			keepVars: true,
			noBundle: true,
			secretsFile: '/xdg/state/create-signkit/recovery/secrets.json'
		});
		const argv = runner.requests[0]!.argv;
		expect(argv).toContain('--secrets-file');
		expect(argv[argv.indexOf('--secrets-file') + 1]).toBe(
			'/xdg/state/create-signkit/recovery/secrets.json'
		);
		expect(argv.join(' ')).not.toMatch(/cf-super-secret-token|DELIVERY_ENCRYPTION_KEY=/);
	});

	it('does not pass --domain to versions upload, but does to deploy (Wrangler)', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout:
				'Uploaded\nVersion ID: 22222222-2222-2222-2222-222222222222\nhttps://signkit.example.workers.dev',
			stderr: ''
		});
		const cloudflare = createCloudflareClient({
			runner,
			accountId: ACCOUNT_ID,
			env: { CLOUDFLARE_API_TOKEN: 'cf-super-secret-token' },
			wranglerBin: '/opt/wrangler/bin/wrangler.js',
			nodeExecutable: '/usr/bin/node'
		});
		const options = {
			cwd: '/tmp/bundle',
			configPath: '/tmp/bundle/wrangler.jsonc',
			workerName: 'signkit',
			domain: 'sign.example.com',
			keepVars: true,
			noBundle: true
		};
		await cloudflare.uploadVersion(options);
		const uploadArgv = runner.requests[0]!.argv;
		expect(uploadArgv).toContain('--keep-vars');
		expect(uploadArgv).toContain('--strict');
		expect(uploadArgv).toContain('--no-bundle');
		expect(uploadArgv).toContain('--config');
		expect(uploadArgv).toContain('--name');
		expect(uploadArgv).not.toContain('--domain');
		expect(runner.requests[0]!.cwd).toBe('/tmp/bundle');
		expect(filterEnvForCloudflareCli({ SECRET_FOO: 'x' }, ACCOUNT_ID).SECRET_FOO).toBeUndefined();
		await cloudflare.deploy(options);
		expect(runner.requests[1]!.argv).toContain('--domain');
		expect(runner.requests[1]!.cwd).toBe('/tmp/bundle');
	});

	it('lists and applies D1 migrations by database id with an explicit --dir, then reads applied history by cf d1 query (cf)', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			if (request.argv.includes('query')) {
				return { code: 0, stdout: JSON.stringify([{ success: true, results: [] }]), stderr: '' };
			}
			return { code: 0, stdout: '[]', stderr: '' };
		};
		const cloudflare = createCloudflareClient({
			runner,
			accountId: ACCOUNT_ID,
			env: { CLOUDFLARE_API_TOKEN: 'cf-super-secret-token' },
			cfBin: '/opt/cf/bin/cf',
			nodeExecutable: '/usr/bin/node'
		});
		const options = {
			d1Id: '11111111-1111-1111-1111-111111111111',
			migrationsDir: '/tmp/bundle/migrations/d1'
		};
		await cloudflare.listMigrations(options);
		await cloudflare.applyMigrations(options);
		expect(runner.requests[0]?.argv).toEqual([
			'/opt/cf/bin/cf',
			'd1',
			'migrations',
			'list',
			options.d1Id,
			'--dir',
			options.migrationsDir
		]);
		expect(runner.requests[1]?.argv).toEqual([
			'/opt/cf/bin/cf',
			'd1',
			'query',
			options.d1Id,
			'--sql',
			'SELECT name FROM d1_migrations ORDER BY id'
		]);
		expect(runner.requests[2]?.argv).toEqual([
			'/opt/cf/bin/cf',
			'd1',
			'migrations',
			'apply',
			options.d1Id,
			'--dir',
			options.migrationsDir
		]);
	});

	it('rejects CLI flags that would pass secrets on argv', async () => {
		const stdout: string[] = [];
		const code = await runCreateSignkit({
			argv: [
				'--cloudflare',
				'deploy',
				'--account-id',
				ACCOUNT_ID,
				'--api-token',
				'cf-super-secret-token',
				'--yes',
				'--json'
			],
			stdout: { write: (chunk) => stdout.push(chunk) },
			stderr: { write() {} }
		});
		expect(code).toBe(2);
		expect(stdout.join('')).toMatch(/never accepted on argv/);
		expect(stdout.join('')).not.toContain('cf-super-secret-token');
	});
});
