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
const DEPLOYMENT_ID = '33333333-3333-3333-3333-333333333333';
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
	it('keeps legacy Worker version listing on Wrangler until cf API parity is verified', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout: JSON.stringify([{ id: WORKER_VERSION }]),
			stderr: ''
		});
		const cloudflare = client(runner);
		await expect(cloudflare.listVersions('signkit')).resolves.toEqual([{ id: WORKER_VERSION }]);
		for (const request of runner.requests) {
			expect(request.argv[0]).toBe(WRANGLER_BIN);
		}
	});

	it('treats listSecrets/listVersions fresh-account errors as an empty Worker', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			if (request.argv.includes('secrets')) {
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

	it('runs first deploy and version upload through Wrangler and accepts only a labelled Worker Version ID', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout: `Uploaded signkit\nVersion ID: ${WORKER_VERSION}\nhttps://signkit.example.workers.dev\n`,
			stderr: ''
		});
		const cloudflare = client(runner);
		const result = assertSuccessfulUpload(
			await cloudflare.deployFirst({
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

	it('publishes traffic through cf then reconciles triggers through Wrangler', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			if (request.argv[0] !== CF_BIN) return { code: 0, stdout: '', stderr: '' };
			if (request.argv.includes('list')) {
				return {
					code: 0,
					stdout: JSON.stringify({
						deployments: [
							{
								id: DEPLOYMENT_ID,
								strategy: 'percentage',
								versions: [{ version_id: WORKER_VERSION, percentage: 100 }]
							}
						]
					}),
					stderr: ''
				};
			}
			return { code: 0, stdout: JSON.stringify({ id: DEPLOYMENT_ID }), stderr: '' };
		};
		const cloudflare = client(runner);
		await cloudflare.deployVersion('signkit', WORKER_VERSION);
		await cloudflare.deployTriggers({
			cwd: '/tmp/bundle',
			configPath: '/tmp/bundle/wrangler.jsonc',
			workerName: 'signkit'
		});
		expect(runner.requests[0]?.argv).toEqual([
			CF_BIN,
			'workers',
			'deployments',
			'create',
			'--worker',
			'signkit',
			'--strategy',
			'percentage',
			'--versions',
			JSON.stringify([{ version_id: WORKER_VERSION, percentage: 100 }])
		]);
		expect(runner.requests[1]?.argv).toEqual([
			CF_BIN,
			'workers',
			'deployments',
			'list',
			'--worker',
			'signkit'
		]);
		expect(runner.requests[2]?.argv).toEqual([
			WRANGLER_BIN,
			'triggers',
			'deploy',
			'--config',
			'/tmp/bundle/wrangler.jsonc',
			'--name',
			'signkit'
		]);
		expect(runner.requests[2]?.cwd).toBe('/tmp/bundle');
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

describe('cf Worker administration', () => {
	it('accepts an explicitly empty successful secret list without inventing secrets', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({ code: 0, stdout: '[]', stderr: '' });
		await expect(client(runner).listSecrets('signkit')).resolves.toEqual([]);
		expect(runner.requests).toHaveLength(1);
		expect(runner.requests[0]?.argv[0]).toBe(CF_BIN);
	});

	it('reads only secret names from cf with explicit Worker identity and isolated cwd', async () => {
		const { access } = await import('node:fs/promises');
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({
			code: 0,
			stdout: JSON.stringify([{ name: 'SESSION_ENCRYPTION_KEY', type: 'secret_text' }]),
			stderr: ''
		});
		await expect(client(runner).listSecrets('signkit')).resolves.toEqual([
			'SESSION_ENCRYPTION_KEY'
		]);
		const request = runner.requests[0]!;
		expect(request.argv).toEqual([CF_BIN, 'workers', 'secrets', 'list', '--worker', 'signkit']);
		expect(request.cwd).toMatch(/create-signkit-cf-/);
		await expect(access(request.cwd!)).rejects.toThrow();
	});

	it.each(
		[
			{},
			{ success: false, result: [] },
			[null],
			[{ name: '' }],
			[{ name: 'DUPLICATE' }, { name: 'DUPLICATE' }],
			Array.from({ length: 1001 }, (_, index) => ({ name: `KEY_${index}` }))
		].map((output) => ({ output }))
	)(
		'rejects malformed secret-name metadata instead of inventing a pristine Worker (%#)',
		async ({ output }) => {
			const runner = new RecordingProcessRunner();
			runner.handler = () => ({ code: 0, stdout: JSON.stringify(output), stderr: '' });
			await expect(client(runner).listSecrets('signkit')).rejects.toThrow(
				/malformed|oversized|duplicate/
			);
		}
	);

	it.each(['generic resource not found', 'account not found', 'error 10007', 'permission denied'])(
		'does not treat an unrelated cf failure as a missing Worker (%s)',
		async (stderr) => {
			const runner = new RecordingProcessRunner();
			runner.handler = () => ({ code: 1, stdout: '', stderr });
			await expect(client(runner).listSecrets('signkit')).rejects.toThrow(/failed/);
		}
	);

	it('rejects invalid version identity before invoking cf', async () => {
		const runner = new RecordingProcessRunner();
		await expect(client(runner).deployVersion('signkit', 'invalid-version')).rejects.toThrow(
			/valid Worker version id/
		);
		expect(runner.requests).toEqual([]);
	});
});

describe('cf Worker deployment publication', () => {
	it('confirms traffic from the deployments list readback, not the POST echo', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			if (request.argv.includes('list')) {
				return {
					code: 0,
					stdout: JSON.stringify({
						deployments: [
							{
								id: DEPLOYMENT_ID,
								strategy: 'percentage',
								versions: [{ version_id: WORKER_VERSION, percentage: 100 }]
							}
						]
					}),
					stderr: ''
				};
			}
			// A minimal create reply is not a substitute for active traffic readback.
			return { code: 0, stdout: JSON.stringify({ id: DEPLOYMENT_ID }), stderr: '' };
		};
		await expect(client(runner).deployVersion('signkit', WORKER_VERSION)).resolves.toBeUndefined();
		expect(runner.requests).toHaveLength(2);
		expect(runner.requests[1]?.argv).toEqual([
			CF_BIN,
			'workers',
			'deployments',
			'list',
			'--worker',
			'signkit'
		]);
	});

	it('accepts a {success,result} envelope for both the create and list responses', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			if (request.argv.includes('list')) {
				return {
					code: 0,
					stdout: JSON.stringify({
						success: true,
						result: {
							deployments: [
								{
									id: DEPLOYMENT_ID,
									strategy: 'percentage',
									versions: [{ version_id: WORKER_VERSION, percentage: 100 }]
								}
							]
						}
					}),
					stderr: ''
				};
			}
			return {
				code: 0,
				stdout: JSON.stringify({ success: true, result: { id: DEPLOYMENT_ID } }),
				stderr: ''
			};
		};
		await expect(client(runner).deployVersion('signkit', WORKER_VERSION)).resolves.toBeUndefined();
	});

	it('never adds deployment-check bypass or provisioning flags to the create command', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			if (request.argv.includes('list')) {
				return {
					code: 0,
					stdout: JSON.stringify({
						deployments: [
							{
								id: DEPLOYMENT_ID,
								strategy: 'percentage',
								versions: [{ version_id: WORKER_VERSION, percentage: 100 }]
							}
						]
					}),
					stderr: ''
				};
			}
			return { code: 0, stdout: JSON.stringify({ id: DEPLOYMENT_ID }), stderr: '' };
		};
		await client(runner).deployVersion('signkit', WORKER_VERSION);
		expect(runner.requests[0]?.argv).not.toContain('--bypass-deployment-checks');
		expect(runner.requests[0]?.argv).not.toContain('--provision');
	});

	it.each([
		{
			name: 'an explicit success:false error envelope',
			output: { success: false },
			error: /unsuccessful response/
		},
		{
			name: 'a JSON array instead of an object',
			output: [{ id: DEPLOYMENT_ID }],
			error: /expected a JSON object/
		},
		{ name: 'an object with no id', output: {}, error: /did not return a valid deployment id/ },
		{
			name: 'a non-UUID id',
			output: { id: 'not-a-uuid' },
			error: /did not return a valid deployment id/
		},
		{
			name: 'a successful envelope without a result object',
			output: { success: true },
			error: /without a result object/
		}
	])('rejects a create (POST) response that is $name', async ({ output, error }) => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({ code: 0, stdout: JSON.stringify(output), stderr: '' });
		await expect(client(runner).deployVersion('signkit', WORKER_VERSION)).rejects.toThrow(error);
		expect(runner.requests).toHaveLength(1);
	});

	it('rejects malformed create (POST) JSON without silently ignoring it', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = () => ({ code: 0, stdout: 'not json', stderr: '' });
		await expect(client(runner).deployVersion('signkit', WORKER_VERSION)).rejects.toThrow(
			/expected JSON output/
		);
		expect(runner.requests).toHaveLength(1);
	});

	it.each([
		{
			name: 'an explicit success:false error envelope',
			output: { success: false },
			error: /unsuccessful response/
		},
		{ name: 'a JSON array instead of an object', output: [], error: /expected a JSON object/ },
		{ name: 'a missing deployments array', output: {}, error: /did not return any deployments/ },
		{
			name: 'an empty deployments array',
			output: { deployments: [] },
			error: /did not return any deployments/
		},
		{
			name: 'a stale deployment id that does not match the one just created',
			output: {
				deployments: [
					{
						id: D1_UUID,
						strategy: 'percentage',
						versions: [{ version_id: WORKER_VERSION, percentage: 100 }]
					}
				]
			},
			error: /exact requested version at 100%/
		},
		{
			name: 'the wrong version id',
			output: {
				deployments: [
					{
						id: DEPLOYMENT_ID,
						strategy: 'percentage',
						versions: [{ version_id: D1_UUID, percentage: 100 }]
					}
				]
			},
			error: /exact requested version at 100%/
		},
		{
			name: 'split traffic across two versions',
			output: {
				deployments: [
					{
						id: DEPLOYMENT_ID,
						strategy: 'percentage',
						versions: [
							{ version_id: WORKER_VERSION, percentage: 50 },
							{ version_id: D1_UUID, percentage: 50 }
						]
					}
				]
			},
			error: /exact requested version at 100%/
		},
		{
			name: 'a non-numeric percentage',
			output: {
				deployments: [
					{
						id: DEPLOYMENT_ID,
						strategy: 'percentage',
						versions: [{ version_id: WORKER_VERSION, percentage: '100' }]
					}
				]
			},
			error: /exact requested version at 100%/
		},
		{
			name: 'a non-percentage strategy',
			output: {
				deployments: [
					{
						id: DEPLOYMENT_ID,
						strategy: 'rolling',
						versions: [{ version_id: WORKER_VERSION, percentage: 100 }]
					}
				]
			},
			error: /exact requested version at 100%/
		}
	])('rejects a deployments list readback with $name', async ({ output, error }) => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			if (request.argv.includes('list')) {
				return { code: 0, stdout: JSON.stringify(output), stderr: '' };
			}
			return { code: 0, stdout: JSON.stringify({ id: DEPLOYMENT_ID }), stderr: '' };
		};
		await expect(client(runner).deployVersion('signkit', WORKER_VERSION)).rejects.toThrow(error);
	});

	it('rejects malformed deployments list JSON without silently ignoring it', async () => {
		const runner = new RecordingProcessRunner();
		runner.handler = (request) => {
			if (request.argv.includes('list')) {
				return { code: 0, stdout: 'not json', stderr: '' };
			}
			return { code: 0, stdout: JSON.stringify({ id: DEPLOYMENT_ID }), stderr: '' };
		};
		await expect(client(runner).deployVersion('signkit', WORKER_VERSION)).rejects.toThrow(
			/expected JSON output/
		);
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
