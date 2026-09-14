import { describe, expect, it } from 'vitest';
import {
	createWranglerClient,
	wranglerDeployArgs,
	wranglerMigrationArgs,
	wranglerUploadArgs
} from '../src/providers/cloudflare/wrangler.js';
import { filterEnvForWrangler } from '../src/runtime/process.js';
import { runCreateSignkit } from '../src/cli/run.js';
import { envHasSecretName } from '../src/runtime/process.js';
import { ACCOUNT_ID, RecordingProcessRunner } from './helpers.js';

describe('command argv and env secrecy', () => {
	it('passes CLOUDFLARE_ACCOUNT_ID only in the child environment, never on argv', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout: JSON.stringify([{ uuid: '11111111-1111-1111-1111-111111111111', name: 'signkit' }]),
			stderr: ''
		});
		const wrangler = createWranglerClient({
			runner,
			accountId: ACCOUNT_ID,
			env: {
				CLOUDFLARE_API_TOKEN: 'cf-super-secret-token',
				PATH: '/usr/bin',
				SECRET_FOO: 'should-not-leak'
			},
			wranglerBin: '/opt/wrangler/bin/wrangler.js',
			nodeExecutable: '/usr/bin/node'
		});
		await wrangler.listD1();
		expect(runner.requests).toHaveLength(1);
		const request = runner.requests[0]!;
		expect(request.cwd).toMatch(/create-signkit-wrangler-/);
		expect(request.cwd).not.toBe('/opt/wrangler/bin');
		expect(request.argv.join(' ')).not.toContain(ACCOUNT_ID);
		expect(request.argv.join(' ')).not.toContain('cf-super-secret-token');
		expect(request.argv).toEqual(['/opt/wrangler/bin/wrangler.js', 'd1', 'list', '--json']);
		expect(request.env?.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT_ID);
		expect(request.env?.CLOUDFLARE_API_TOKEN).toBe('cf-super-secret-token');
		expect(request.env?.SECRET_FOO).toBeUndefined();
		expect(envHasSecretName('CLOUDFLARE_API_TOKEN')).toBe(true);
		expect(envHasSecretName('CLOUDFLARE_ACCOUNT_ID')).toBe(false);
	});

	it('preserves dashboard vars by passing --keep-vars and never puts secret values on argv', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout:
				'Deployed\nVersion ID: 22222222-2222-2222-2222-222222222222\nhttps://signkit.example.workers.dev',
			stderr: ''
		});
		const wrangler = createWranglerClient({
			runner,
			accountId: ACCOUNT_ID,
			env: { CLOUDFLARE_API_TOKEN: 'cf-super-secret-token' },
			wranglerBin: '/opt/wrangler/bin/wrangler.js',
			nodeExecutable: '/usr/bin/node'
		});
		await wrangler.deploy({
			cwd: '/tmp/bundle',
			configPath: '/tmp/bundle/wrangler.jsonc',
			workerName: 'signkit',
			keepVars: true,
			noBundle: true
		});
		const argv = runner.requests[0]!.argv;
		expect(argv).toContain('--keep-vars');
		expect(argv.join(' ')).not.toMatch(/cf-super-secret-token|DELIVERY_ENCRYPTION_KEY=/);
	});

	it('does not pass --domain to versions upload', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout:
				'Uploaded\nVersion ID: 22222222-2222-2222-2222-222222222222\nhttps://signkit.example.workers.dev',
			stderr: ''
		});
		const wrangler = createWranglerClient({
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
		await wrangler.uploadVersion(options);
		const uploadArgv = runner.requests[0]!.argv;
		expect(uploadArgv).toContain('--keep-vars');
		expect(uploadArgv).toContain('--strict');
		expect(uploadArgv).toContain('--no-bundle');
		expect(uploadArgv).toContain('--config');
		expect(uploadArgv).toContain('--name');
		expect(uploadArgv).not.toContain('--domain');
		expect(wranglerUploadArgs(options)).not.toContain('--domain');
		expect(wranglerDeployArgs(options)).toContain('--domain');
		expect(filterEnvForWrangler({ SECRET_FOO: 'x' }, ACCOUNT_ID).SECRET_FOO).toBeUndefined();
		await wrangler.deploy(options);
		expect(runner.requests[1]!.argv).toContain('--domain');
		expect(runner.requests[1]!.cwd).toBe('/tmp/bundle');
	});

	it('lists and applies D1 migrations with --config and the extracted cwd', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout: 'No migrations to apply!',
			stderr: ''
		});
		const wrangler = createWranglerClient({
			runner,
			accountId: ACCOUNT_ID,
			env: { CLOUDFLARE_API_TOKEN: 'cf-super-secret-token' },
			wranglerBin: '/opt/wrangler/bin/wrangler.js',
			nodeExecutable: '/usr/bin/node'
		});
		const options = {
			cwd: '/tmp/bundle',
			configPath: '/tmp/bundle/wrangler.jsonc',
			database: 'signkit'
		};
		await wrangler.listMigrations(options);
		await wrangler.applyMigrations(options);
		expect(runner.requests[0]?.cwd).toBe('/tmp/bundle');
		expect(runner.requests[1]?.cwd).toBe('/tmp/bundle');
		expect(runner.requests[0]?.argv).toEqual([
			'/opt/wrangler/bin/wrangler.js',
			...wranglerMigrationArgs('list', options)
		]);
		expect(runner.requests[1]?.argv).toEqual([
			'/opt/wrangler/bin/wrangler.js',
			...wranglerMigrationArgs('apply', options)
		]);
		expect(runner.requests[0]?.argv).toContain('--config');
		expect(runner.requests[0]?.argv).toContain('/tmp/bundle/wrangler.jsonc');
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
