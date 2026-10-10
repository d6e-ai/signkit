import { describe, expect, it } from 'vitest';
import {
	accountIdIsAuthorized,
	assertSuccessfulUpload,
	createCloudflareClient,
	isMissingWorkerError,
	parseCfMigrationNames,
	parseD1QueryAppliedNames
} from '../src/providers/cloudflare/cloudflare-client.js';
import { ACCOUNT_ID, RecordingProcessRunner } from './helpers.js';

const D1_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKER_VERSION = '22222222-2222-2222-2222-222222222222';
const CF_BIN = '/opt/cf/bin/cf';
const WRANGLER_BIN = '/opt/wrangler/bin/wrangler.js';

function client(runner: RecordingProcessRunner) {
	return createCloudflareClient({
		runner,
		accountId: ACCOUNT_ID,
		env: { PATH: '/usr/bin' },
		cfBin: CF_BIN,
		wranglerBin: WRANGLER_BIN,
		nodeExecutable: '/usr/bin/node'
	});
}

describe('cf-handled operations', () => {
	it('discovers later D1 pages before declaring the selected database absent', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			const page = request.argv[request.argv.indexOf('--page') + 1];
			return {
				code: 0,
				stdout: JSON.stringify(
					page === '1'
						? Array.from({ length: 50 }, (_, index) => ({
								uuid: `fixture-${index}`,
								name: `fixture-${index}`
							}))
						: [{ uuid: D1_UUID, name: 'selected' }]
				),
				stderr: ''
			};
		};
		const rows = await client(runner).listD1();
		expect(rows).toHaveLength(51);
		expect(rows[50]).toEqual({ uuid: D1_UUID, name: 'selected' });
		expect(runner.requests[1]?.argv).toContain('2');
	});

	it('fails closed when pagination repeats rather than assuming inventory is complete', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout: JSON.stringify(
				Array.from({ length: 50 }, (_, index) => ({ id: `fixture-${index}` }))
			),
			stderr: ''
		});
		await expect(client(runner).whoami()).rejects.toThrow(/repeated resource identity/);
	});

	it('runs whoami through `cf accounts list`', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout: JSON.stringify([{ id: ACCOUNT_ID, name: 'signkit-lab' }]),
			stderr: ''
		});
		const cloudflare = client(runner);
		await expect(cloudflare.whoami()).resolves.toEqual({
			accounts: [{ id: ACCOUNT_ID, name: 'signkit-lab' }]
		});
		expect(runner.requests[0]?.argv).toEqual([
			CF_BIN,
			'accounts',
			'list',
			'--page',
			'1',
			'--per-page',
			'50'
		]);
	});

	it('runs listD1/createD1 through `cf d1 list`/`cf d1 create`', async () => {
		const listRunner = new RecordingProcessRunner();
		listRunner.handler = () => ({
			code: 0,
			stdout: JSON.stringify([{ uuid: D1_UUID, name: 'signkit' }]),
			stderr: ''
		});
		await client(listRunner).listD1();
		expect(listRunner.requests[0]?.argv).toEqual([
			CF_BIN,
			'd1',
			'list',
			'--page',
			'1',
			'--per-page',
			'50'
		]);

		const createRunner = new RecordingProcessRunner();
		createRunner.handler = () => ({
			code: 0,
			stdout: JSON.stringify({ uuid: D1_UUID, name: 'signkit' }),
			stderr: ''
		});
		await expect(client(createRunner).createD1('signkit')).resolves.toEqual({
			uuid: D1_UUID,
			name: 'signkit'
		});
		expect(createRunner.requests[0]?.argv).toEqual([CF_BIN, 'd1', 'create', '--name', 'signkit']);
	});

	it('runs r2Exists/createR2 through `cf r2 buckets get`/`create`', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) =>
			request.argv.includes('present')
				? { code: 0, stdout: '{}', stderr: '' }
				: { code: 1, stdout: '', stderr: 'The specified bucket does not exist' };
		const cloudflare = client(runner);
		await expect(cloudflare.r2Exists('present')).resolves.toBe(true);
		await expect(cloudflare.r2Exists('absent')).resolves.toBe(false);
		expect(runner.requests[0]?.argv).toEqual([CF_BIN, 'r2', 'buckets', 'get', 'present']);

		const createRunner = new RecordingProcessRunner();
		createRunner.handler = () => ({ code: 0, stdout: '{}', stderr: '' });
		await client(createRunner).createR2('signkit-objects');
		expect(createRunner.requests[0]?.argv).toEqual([
			CF_BIN,
			'r2',
			'buckets',
			'create',
			'--name',
			'signkit-objects'
		]);
	});

	it('runs listMigrations through `cf d1 migrations list` plus `cf d1 query` for applied history', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			if (request.argv.includes('query')) {
				return {
					code: 0,
					stdout: JSON.stringify([
						{ success: true, results: [{ name: '0001_core.sql' }, { name: '0002_next.sql' }] }
					]),
					stderr: ''
				};
			}
			return {
				code: 0,
				stdout: JSON.stringify([{ Name: '0003_pending.sql' }]),
				stderr: ''
			};
		};
		const cloudflare = client(runner);
		await expect(
			cloudflare.listMigrations({ d1Id: D1_UUID, migrationsDir: '/tmp/migrations/d1' })
		).resolves.toEqual({
			pending: ['0003_pending.sql'],
			applied: ['0001_core.sql', '0002_next.sql']
		});
		expect(runner.requests[0]?.argv).toEqual([
			CF_BIN,
			'd1',
			'migrations',
			'list',
			D1_UUID,
			'--dir',
			'/tmp/migrations/d1'
		]);
		expect(runner.requests[1]?.argv).toEqual([
			CF_BIN,
			'd1',
			'query',
			D1_UUID,
			'--sql',
			'SELECT name FROM d1_migrations ORDER BY id'
		]);
	});

	it('runs applyMigrations through `cf d1 migrations apply`', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({ code: 0, stdout: '', stderr: '' });
		await client(runner).applyMigrations({ d1Id: D1_UUID, migrationsDir: '/tmp/migrations/d1' });
		expect(runner.requests[0]?.argv).toEqual([
			CF_BIN,
			'd1',
			'migrations',
			'apply',
			D1_UUID,
			'--dir',
			'/tmp/migrations/d1'
		]);
	});

	it('runs discovery commands from a fresh empty temp cwd and cleans it up', async () => {
		const { access } = await import('node:fs/promises');
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout: JSON.stringify([{ uuid: D1_UUID, name: 'signkit' }]),
			stderr: ''
		});
		await client(runner).listD1();
		const cwd = runner.requests[0]?.cwd;
		expect(cwd).toMatch(/create-signkit-cf-/);
		expect(cwd).not.toBe(process.cwd());
		await expect(access(cwd!)).rejects.toThrow();
	});
});

describe('parseCfMigrationNames', () => {
	it('parses the verified beta14 JSON shape of capitalized Name rows', () => {
		expect(
			parseCfMigrationNames(JSON.stringify([{ Name: '0001_core.sql' }]), 'cf d1 migrations list')
		).toEqual(['0001_core.sql']);
	});

	it('errors rather than silently returning empty pending on malformed JSON', () => {
		expect(() => parseCfMigrationNames('not json', 'cf d1 migrations list')).toThrow(
			/expected JSON output/
		);
	});

	it('errors on a row shape without a Name field instead of yielding empty pending', () => {
		expect(() =>
			parseCfMigrationNames(JSON.stringify([{ name: '0001_core.sql' }]), 'cf d1 migrations list')
		).toThrow(/without a Name field/);
	});
});

describe('parseD1QueryAppliedNames', () => {
	it('refuses an empty or multi-result response instead of declaring a fresh database', () => {
		expect(() => parseD1QueryAppliedNames('[]')).toThrow(/exactly one query result/);
		expect(() =>
			parseD1QueryAppliedNames(
				JSON.stringify([
					{ success: true, results: [] },
					{ success: true, results: [] }
				])
			)
		).toThrow(/exactly one query result/);
		expect(parseD1QueryAppliedNames(JSON.stringify([{ success: true, results: [] }]))).toEqual([]);
	});
	it('parses a successful SDK D1 query result into applied names', () => {
		expect(
			parseD1QueryAppliedNames(
				JSON.stringify([{ success: true, results: [{ name: '0001_core.sql' }] }])
			)
		).toEqual(['0001_core.sql']);
	});

	it('errors on an explicit unsuccessful result instead of yielding empty applied history', () => {
		expect(() =>
			parseD1QueryAppliedNames(JSON.stringify([{ success: false, results: [] }]))
		).toThrow(/unsuccessful result/);
	});

	it('errors when the success flag is missing instead of yielding empty applied history', () => {
		expect(() => parseD1QueryAppliedNames(JSON.stringify([{ results: [] }]))).toThrow(
			/unsuccessful result/
		);
	});
});

describe('Wrangler-delegated operations', () => {
	it('runs listSecrets/listVersions through the Wrangler binary, not cf', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			if (request.argv.includes('secret')) {
				return { code: 0, stdout: JSON.stringify([{ name: 'FOO' }]), stderr: '' };
			}
			if (request.argv.includes('versions')) {
				return { code: 0, stdout: JSON.stringify([{ id: WORKER_VERSION }]), stderr: '' };
			}
			return { code: 0, stdout: '[]', stderr: '' };
		};
		const cloudflare = client(runner);
		await expect(cloudflare.listSecrets('signkit')).resolves.toEqual(['FOO']);
		await expect(cloudflare.listVersions('signkit')).resolves.toEqual([{ id: WORKER_VERSION }]);
		for (const request of runner.requests) {
			expect(request.argv[0]).toBe(WRANGLER_BIN);
		}
	});

	it('treats listSecrets/listVersions fresh-account errors as an empty Worker', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			if (request.argv.includes('secret')) {
				return { code: 1, stdout: '', stderr: 'code: 10007 script_not_found' };
			}
			if (request.argv.includes('versions')) {
				return { code: 1, stdout: '', stderr: '[code: 10006] script_not_found' };
			}
			return { code: 0, stdout: '[]', stderr: '' };
		};
		const cloudflare = client(runner);
		await expect(cloudflare.listSecrets('signkit')).resolves.toEqual([]);
		await expect(cloudflare.listVersions('signkit')).resolves.toEqual([]);
	});

	it('runs deploy/uploadVersion through Wrangler and accepts only a labelled Worker Version ID', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout: `Uploaded signkit\nVersion ID: ${WORKER_VERSION}\nhttps://signkit.example.workers.dev\n`,
			stderr: ''
		});
		const cloudflare = client(runner);
		const result = assertSuccessfulUpload(
			await cloudflare.deploy({
				cwd: '/tmp/bundle',
				configPath: '/tmp/bundle/wrangler.jsonc',
				workerName: 'signkit',
				keepVars: true,
				noBundle: true
			})
		);
		expect(result.workerVersionId).toBe(WORKER_VERSION);
		expect(runner.requests[0]?.argv[0]).toBe(WRANGLER_BIN);
		expect(runner.requests[0]?.argv).toContain('deploy');
	});

	it('runs deployVersion/rollback through Wrangler `versions deploy`/`rollback`', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({ code: 0, stdout: `Version ID: ${WORKER_VERSION}\n`, stderr: '' });
		const cloudflare = client(runner);
		await cloudflare.deployVersion('signkit', WORKER_VERSION);
		await cloudflare.rollback('signkit', WORKER_VERSION, 'restoring previous Worker version');
		for (const request of runner.requests) {
			expect(request.argv[0]).toBe(WRANGLER_BIN);
		}
		expect(runner.requests[0]?.argv).toEqual([
			WRANGLER_BIN,
			'versions',
			'deploy',
			`${WORKER_VERSION}@100`,
			'--name',
			'signkit',
			'--yes'
		]);
		expect(runner.requests[1]?.argv).toEqual([
			WRANGLER_BIN,
			'rollback',
			WORKER_VERSION,
			'--name',
			'signkit',
			'--yes',
			'--message',
			'restoring previous Worker version'
		]);
	});

	it('runs exportD1 through Wrangler `d1 export`', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({ code: 0, stdout: '', stderr: '' });
		await client(runner).exportD1('signkit', '/tmp/backups/signkit.sql');
		expect(runner.requests[0]?.argv).toEqual([
			WRANGLER_BIN,
			'd1',
			'export',
			'signkit',
			'--remote',
			'--output',
			'/tmp/backups/signkit.sql',
			'--skip-confirmation'
		]);
	});
});

describe('missing Worker classification', () => {
	it('recognizes script_not_found and API codes 10007/10006/10090', () => {
		expect(isMissingWorkerError('code: 10007 script_not_found')).toBe(true);
		expect(isMissingWorkerError('[10006] Worker script not present')).toBe(true);
		expect(isMissingWorkerError('[code: 10090] missing script')).toBe(true);
		expect(isMissingWorkerError('error 10090')).toBe(false);
		expect(isMissingWorkerError('A generic resource was not found')).toBe(false);
	});
});

describe('accountIdIsAuthorized', () => {
	it('matches case-insensitively against the accounts `cf accounts list` returned', () => {
		expect(
			accountIdIsAuthorized({ accounts: [{ id: ACCOUNT_ID.toUpperCase() }] }, ACCOUNT_ID)
		).toBe(true);
		expect(accountIdIsAuthorized({ accounts: [{ id: 'other' }] }, ACCOUNT_ID)).toBe(false);
	});
});
