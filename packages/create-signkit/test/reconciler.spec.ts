import { describe, expect, it } from 'vitest';
import { runCreateSignkit } from '../src/cli/run.js';
import { reconcileCloudflare } from '../src/providers/cloudflare/reconciler.js';
import {
	ACCOUNT_ID,
	D1_ID,
	FakeHttp,
	FakeWrangler,
	MemoryFileSystem,
	PREVIOUS_VERSION,
	WORKER_VERSION,
	command,
	fakeExtractor,
	fakeReleases,
	writeCloudflareState
} from './helpers.js';

async function run(
	argv: string[],
	wrangler: FakeWrangler,
	fs = new MemoryFileSystem(),
	releases = fakeReleases()
) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const http = new FakeHttp();
	http.on(
		'https://signkit.example.workers.dev/api/v1/system/capabilities',
		JSON.stringify({ name: 'signkit', apiVersion: '1' })
	);
	wrangler.fs = fs;
	const code = await runCreateSignkit({
		argv,
		stdout: { write: (chunk) => stdout.push(chunk) },
		stderr: { write: (chunk) => stderr.push(chunk) },
		env: { XDG_STATE_HOME: '/xdg/state' },
		runtime: {
			fs,
			wrangler,
			releases,
			extractor: fakeExtractor(fs),
			http,
			now: () => new Date('2026-09-15T00:00:00.000Z'),
			smokeBackoffMs: 0,
			sleep: async () => undefined
		}
	});
	return { code, stdout: stdout.join(''), stderr: stderr.join(''), fs, wrangler, releases };
}

const INITIAL_DEPLOY_FLAGS = [
	'--email-from',
	'sign@example.com',
	'--public-origin',
	'https://signkit.example.workers.dev',
	'--bootstrap-owner-email',
	'Owner@Example.com'
];

describe('plan is read-only', () => {
	it('does not create resources, apply migrations, deploy, or write state', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.pendingMigrations = ['0002_next.sql'];
		const fs = new MemoryFileSystem();
		const releases = fakeReleases();
		const result = await run(
			['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--json'],
			wrangler,
			fs,
			releases
		);
		expect(result.code).toBe(0);
		expect(releases.resolveCalls).toBe(1);
		expect(releases.downloads).toBe(0);
		expect(wrangler.calls.some((call) => call.startsWith('create'))).toBe(false);
		expect(wrangler.calls.some((call) => call.startsWith('applyMigrations'))).toBe(false);
		expect(wrangler.calls.some((call) => call.startsWith('deploy'))).toBe(false);
		expect(wrangler.calls.some((call) => call.startsWith('exportD1'))).toBe(false);
		expect(fs.writes).toEqual([]);
		expect(JSON.parse(result.stdout).mutations).toEqual([]);
		const plan = JSON.parse(result.stdout).plan as Array<{ id: string; mutating: boolean }>;
		expect(plan.find((step) => step.id === 'd1-export')?.mutating).toBe(true);
		expect(plan.find((step) => step.id === 'deploy')?.mutating).toBe(true);
		expect(plan.find((step) => step.id === 'd1-migrations')?.mutating).toBe(true);
		expect(plan.find((step) => step.id === 'state')?.mutating).toBe(true);
	});
});

describe('deploy, adopt, and upgrade state transitions', () => {
	it('deploy creates missing D1/R2, applies pending migrations, deploys, and records state', async () => {
		const wrangler = new FakeWrangler();
		wrangler.secrets.set('signkit', [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		wrangler.versions.set('signkit', []);
		wrangler.pendingMigrations = ['0001_core.sql'];
		const result = await run(
			[
				'--cloudflare',
				'deploy',
				'--account-id',
				ACCOUNT_ID,
				...INITIAL_DEPLOY_FLAGS,
				'--yes',
				'--json'
			],
			wrangler
		);
		expect(result.code).toBe(0);
		expect(wrangler.calls).toContain('createD1:signkit');
		expect(wrangler.calls).toContain('createR2:signkit-objects');
		expect(wrangler.calls.some((call) => call.startsWith('applyMigrations'))).toBe(true);
		expect(wrangler.calls).toContain('deploy:signkit');
		const state = JSON.parse(await result.fs.readFile('/xdg/state/create-signkit/state.json'));
		expect(state).toMatchObject({
			provider: 'cloudflare',
			accountId: ACCOUNT_ID,
			workerName: 'signkit',
			d1: { name: 'signkit', id: D1_ID },
			r2: { name: 'signkit-objects' },
			version: 'v1.2.3',
			lastCommand: 'deploy'
		});
		expect(JSON.stringify(state)).not.toMatch(/DELIVERY_ENCRYPTION_KEY|cf-|token/i);
	});

	it('adopt records explicit existing resources without deploying or resolving a release', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const releases = fakeReleases();
		const result = await run(
			['--cloudflare', 'adopt', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler,
			new MemoryFileSystem(),
			releases
		);
		expect(result.code).toBe(0);
		expect(releases.resolveCalls).toBe(0);
		expect(releases.downloads).toBe(0);
		expect(wrangler.calls).not.toContain('createD1:signkit');
		expect(wrangler.calls.some((call) => call.startsWith('deploy'))).toBe(false);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.version).toBeUndefined();
		expect(parsed.commit).toBeUndefined();
		const state = JSON.parse(await result.fs.readFile('/xdg/state/create-signkit/state.json'));
		expect(state.adopted).toBe(true);
		expect(state.lastCommand).toBe('adopt');
		expect(state.version).toBeUndefined();
		expect(state.commit).toBeUndefined();
		expect(parsed.plan.find((step: { id: string }) => step.id === 'adopt').mutating).toBe(true);
	});

	it('refuses no-state upgrade of an existing Worker until adopt records it', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const result = await run(
			['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler
		);
		expect(result.code).toBe(4);
		expect(result.stdout).toMatch(/adopt the existing Worker/);
		expect(wrangler.calls).not.toContain('uploadVersion:signkit');
		expect(wrangler.calls).not.toContain('whoami');
	});

	it('upgrade requires existing resources and uploads a new Worker version after pending migrations', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.pendingMigrations = ['0002_next.sql'];
		const fs = await writeCloudflareState(new MemoryFileSystem());
		const result = await run(
			['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler,
			fs
		);
		expect(result.code).toBe(0);
		expect(wrangler.calls).not.toContain('createD1:signkit');
		expect(wrangler.calls).not.toContain('createR2:signkit-objects');
		expect(wrangler.calls).toContain('uploadVersion:signkit');
		expect(wrangler.calls.some((call) => call.startsWith('deployVersion:signkit:'))).toBe(true);
		expect(
			JSON.parse(result.stdout).lastCommand ??
				JSON.parse(await result.fs.readFile('/xdg/state/create-signkit/state.json')).lastCommand
		).toBe('upgrade');
	});

	it('refuses upgrade resource overrides until adopt records the intended identity', async () => {
		const wrangler = new FakeWrangler();
		wrangler.d1 = [{ uuid: '44444444-4444-4444-4444-444444444444', name: 'signkit-prod-db' }];
		wrangler.r2.add('signkit-prod-objects');
		wrangler.secrets.set('signkit-prod', [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		wrangler.versions.set('signkit-prod', [{ id: PREVIOUS_VERSION }]);
		const fs = await writeCloudflareState(new MemoryFileSystem());
		const denied = await run(
			[
				'--cloudflare',
				'upgrade',
				'--account-id',
				ACCOUNT_ID,
				'--worker-name',
				'signkit-prod',
				'--d1',
				'signkit-prod-db',
				'--r2',
				'signkit-prod-objects',
				'--yes',
				'--json'
			],
			wrangler,
			fs
		);
		expect(denied.code).toBe(4);
		expect(denied.stdout).toMatch(/drifted/);
		expect(wrangler.calls).not.toContain('uploadVersion:signkit-prod');

		const adopted = await run(
			[
				'--cloudflare',
				'adopt',
				'--account-id',
				ACCOUNT_ID,
				'--worker-name',
				'signkit-prod',
				'--d1',
				'signkit-prod-db',
				'--r2',
				'signkit-prod-objects',
				'--yes',
				'--json'
			],
			wrangler,
			fs
		);
		expect(adopted.code).toBe(0);
		const upgraded = await run(
			['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler,
			fs
		);
		expect(upgraded.code).toBe(0);
		expect(wrangler.calls).toContain('uploadVersion:signkit-prod');
		const state = JSON.parse(await fs.readFile('/xdg/state/create-signkit/state.json'));
		expect(state.workerName).toBe('signkit-prod');
		expect(state.d1.name).toBe('signkit-prod-db');
		expect(state.r2.name).toBe('signkit-prod-objects');
	});
});

describe('drift refusal', () => {
	it('refuses unexpected remote D1 id changes unless adopt updates local state', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.d1 = [{ uuid: '55555555-5555-5555-5555-555555555555', name: 'signkit' }];
		const fs = new MemoryFileSystem();
		await fs.writeFile(
			'/xdg/state/create-signkit/state.json',
			JSON.stringify({
				schemaVersion: 1,
				provider: 'cloudflare',
				accountId: ACCOUNT_ID,
				workerName: 'signkit',
				d1: { name: 'signkit', id: D1_ID },
				r2: { name: 'signkit-objects' },
				channel: 'stable',
				updatedAt: '2026-09-15T00:00:00.000Z'
			})
		);
		const denied = await run(
			['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler,
			fs
		);
		expect(denied.code).toBe(4);
		expect(denied.stdout).toMatch(/drifted/);
		expect(wrangler.calls).not.toContain('uploadVersion:signkit');

		const adopted = await run(
			['--cloudflare', 'adopt', '--account-id', ACCOUNT_ID, '--d1', 'signkit', '--yes', '--json'],
			wrangler,
			fs
		);
		expect(adopted.code).toBe(0);
		const state = JSON.parse(await fs.readFile('/xdg/state/create-signkit/state.json'));
		expect(state.d1.id).toBe('55555555-5555-5555-5555-555555555555');
	});
});

describe('migration and deploy ordering', () => {
	it('exports D1, applies pending migrations, then uploads the Worker', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.pendingMigrations = ['0002_next.sql'];
		const fs = await writeCloudflareState(new MemoryFileSystem());
		await run(
			['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler,
			fs
		);
		const order = wrangler.calls.filter((call) =>
			['exportD1', 'applyMigrations', 'uploadVersion', 'deployVersion', 'deploy'].some((name) =>
				call.startsWith(name)
			)
		);
		expect(order[0]).toMatch(/^exportD1:/);
		expect(order[1]).toMatch(/^applyMigrations/);
		expect(order[2]).toMatch(/^uploadVersion:/);
		expect(order[3]).toMatch(/^deployVersion:/);
		expect(wrangler.migrationCalls).toHaveLength(3);
		expect(wrangler.calls.filter((call) => call.startsWith('listMigrations'))).toHaveLength(2);
		for (const call of wrangler.migrationCalls) {
			expect(call.cwd).toMatch(/^\/tmp\/create-signkit-/);
			expect(call.configPath).toBe(`${call.cwd}/wrangler.jsonc`);
			expect(call.database).toBe('signkit');
		}
		expect(wrangler.recordedInvocations[0]?.args).toContain('--config');
		expect(wrangler.recordedInvocations[0]?.cwd).toBe(wrangler.migrationCalls[0]?.cwd);
	});

	it('refuses remaining pending migrations after apply', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.pendingMigrations = ['0002_next.sql'];
		wrangler.leavePendingAfterApply = true;
		const fs = await writeCloudflareState(new MemoryFileSystem());
		const result = await run(
			['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler,
			fs
		);
		expect(result.code).toBe(1);
		expect(result.stdout).toMatch(/remain pending after apply/);
		expect(wrangler.calls).not.toContain('uploadVersion:signkit');
	});

	it('does not apply migrations during plan', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.pendingMigrations = ['0002_next.sql'];
		await reconcileCloudflare(command({ command: 'plan', yes: false }), {
			fs: new MemoryFileSystem(),
			http: new FakeHttp(),
			releases: fakeReleases(),
			wrangler,
			extractor: fakeExtractor(new MemoryFileSystem()),
			now: () => new Date('2026-09-15T00:00:00.000Z'),
			env: { XDG_STATE_HOME: '/xdg/state' }
		});
		expect(wrangler.calls.some((call) => call.startsWith('applyMigrations'))).toBe(false);
	});
});

describe('failure and rollback reporting', () => {
	it('rolls back the Worker after a failed smoke check and never claims D1 rollback', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const fs = await writeCloudflareState(new MemoryFileSystem());
		wrangler.fs = fs;
		const http = new FakeHttp();
		http.on('https://signkit.example.workers.dev/api/v1/system/capabilities', 'nope', 500);
		const result = await reconcileCloudflare(command({ command: 'upgrade' }), {
			fs,
			http,
			releases: fakeReleases(),
			wrangler,
			extractor: fakeExtractor(fs),
			now: () => new Date('2026-09-15T00:00:00.000Z'),
			env: { XDG_STATE_HOME: '/xdg/state' },
			smokeAttempts: 1,
			smokeBackoffMs: 0,
			sleep: async () => undefined
		});
		expect(result.exitCode).toBe(1);
		expect(result.rollback?.attempted).toBe(true);
		expect(result.rollback?.workerRolledBack).toBe(true);
		expect(result.rollback?.d1RolledBack).toBe(false);
		expect(result.rollback?.guidance).toMatch(/D1 was not rolled back/);
		expect(wrangler.calls.some((call) => call.startsWith('rollback:'))).toBe(true);
	});

	it('reports guidance when Worker rollback is not verifiably supported', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.failRollback = true;
		const http = new FakeHttp();
		http.on('https://signkit.example.workers.dev/api/v1/system/capabilities', 'nope', 500);
		const fs = await writeCloudflareState(new MemoryFileSystem());
		wrangler.fs = fs;
		const result = await reconcileCloudflare(command({ command: 'upgrade' }), {
			fs,
			http,
			releases: fakeReleases(),
			wrangler,
			extractor: fakeExtractor(fs),
			now: () => new Date('2026-09-15T00:00:00.000Z'),
			env: { XDG_STATE_HOME: '/xdg/state' },
			smokeAttempts: 1,
			smokeBackoffMs: 0,
			sleep: async () => undefined
		});
		expect(result.rollback?.attempted).toBe(true);
		expect(result.rollback?.performed).toBe(false);
		expect(result.rollback?.d1RolledBack).toBe(false);
		expect(result.message).toMatch(/smoke check failed/i);
		expect(result.rollback?.guidance).toMatch(/rollback to .* was attempted and failed/);
	});

	it('lists missing secret names and does not upload a Worker', async () => {
		const wrangler = new FakeWrangler();
		wrangler.d1 = [{ uuid: D1_ID, name: 'signkit' }];
		wrangler.r2.add('signkit-objects');
		const result = await run(
			[
				'--cloudflare',
				'deploy',
				'--account-id',
				ACCOUNT_ID,
				'--email-from',
				'sign@example.com',
				'--public-origin',
				'https://signkit.example.workers.dev',
				'--bootstrap-owner-email',
				'owner@example.com',
				'--yes',
				'--json'
			],
			wrangler
		);
		expect(result.code).toBe(6);
		expect(result.stdout).toMatch(/DELIVERY_ENCRYPTION_KEY/);
		expect(result.stdout).toMatch(/never accepted on argv/);
		expect(wrangler.calls.some((call) => call.startsWith('deploy'))).toBe(false);
	});

	it('does not create D1 or R2 when required secrets are missing', async () => {
		const wrangler = new FakeWrangler();
		const result = await run(
			[
				'--cloudflare',
				'deploy',
				'--account-id',
				ACCOUNT_ID,
				...INITIAL_DEPLOY_FLAGS,
				'--yes',
				'--json'
			],
			wrangler
		);
		expect(result.code).toBe(6);
		expect(result.stdout).toMatch(/DELIVERY_ENCRYPTION_KEY/);
		expect(wrangler.calls).not.toContain('createD1:signkit');
		expect(wrangler.calls).not.toContain('createR2:signkit-objects');
		expect(wrangler.calls.some((call) => call.startsWith('deploy'))).toBe(false);
	});
});

describe('mutating confirmation', () => {
	it('requires --yes for deploy', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const result = await run(
			['--cloudflare', 'deploy', '--account-id', ACCOUNT_ID, '--json'],
			wrangler
		);
		expect(result.code).toBe(2);
		expect(result.stdout).toMatch(/--yes/);
	});
});

describe('effective config inheritance', () => {
	it('inherits omitted worker/D1/R2 from XDG state before remote inspection', async () => {
		const wrangler = new FakeWrangler();
		wrangler.d1 = [{ uuid: '44444444-4444-4444-4444-444444444444', name: 'signkit-prod-db' }];
		wrangler.r2.add('signkit-prod-objects');
		wrangler.secrets.set('signkit-prod', [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		wrangler.versions.set('signkit-prod', [{ id: PREVIOUS_VERSION }]);
		const fs = new MemoryFileSystem();
		await fs.writeFile(
			'/xdg/state/create-signkit/state.json',
			JSON.stringify({
				schemaVersion: 1,
				provider: 'cloudflare',
				accountId: ACCOUNT_ID,
				workerName: 'signkit-prod',
				d1: { name: 'signkit-prod-db', id: '44444444-4444-4444-4444-444444444444' },
				r2: { name: 'signkit-prod-objects' },
				domain: 'sign.example.com',
				publicOrigin: 'https://sign.example.com',
				channel: 'stable',
				updatedAt: '2026-09-15T00:00:00.000Z'
			})
		);
		const result = await run(
			['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--json'],
			wrangler,
			fs
		);
		expect(result.code).toBe(0);
		expect(wrangler.calls.indexOf('whoami')).toBeLessThan(
			wrangler.calls.indexOf('listVersions:signkit-prod')
		);
		expect(wrangler.calls).toContain('listVersions:signkit-prod');
		expect(wrangler.calls).toContain('r2Exists:signkit-prod-objects');
		expect(wrangler.calls).not.toContain('listVersions:signkit');
		expect(wrangler.calls).not.toContain('r2Exists:signkit-objects');
	});
});

describe('D1 backup retention', () => {
	it('persists the D1 export beside XDG state and does not delete it with the temp bundle', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const fs = await writeCloudflareState(new MemoryFileSystem());
		const result = await run(
			['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler,
			fs
		);
		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.d1BackupPath).toBe(
			'/xdg/state/create-signkit/backups/d1-signkit-20260915T000000000Z.sql'
		);
		expect(await result.fs.readFile(parsed.d1BackupPath)).toMatch(/d1 backup signkit/);
		const state = JSON.parse(await result.fs.readFile('/xdg/state/create-signkit/state.json'));
		expect(state.lastD1BackupPath).toBe(parsed.d1BackupPath);
		expect(result.fs.modes.get('/xdg/state/create-signkit/backups')).toBe(0o700);
		expect(result.fs.modes.get(parsed.d1BackupPath)).toBe(0o600);
		expect(result.fs.mkdirCalls).toContainEqual({
			path: '/xdg/state/create-signkit/backups',
			mode: 0o700
		});
		expect(
			[...result.fs.files.keys()].some((path) => path.startsWith('/tmp/create-signkit-'))
		).toBe(false);
	});

	it('fails closed when chmod of the backups directory fails', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const fs = await writeCloudflareState(new MemoryFileSystem());
		fs.chmodFailures.add('/xdg/state/create-signkit/backups');
		const result = await run(
			['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler,
			fs
		);
		expect(result.code).toBe(1);
		expect(result.stdout).toMatch(/EPERM chmod/);
		expect(wrangler.calls.some((call) => call.startsWith('exportD1'))).toBe(false);
		expect(wrangler.calls.some((call) => call.startsWith('applyMigrations'))).toBe(false);
		expect(wrangler.calls.some((call) => call.startsWith('deploy'))).toBe(false);
		expect(wrangler.calls.some((call) => call.startsWith('uploadVersion'))).toBe(false);
	});
});

describe('account authorization', () => {
	it('refuses when --account-id is absent from wrangler whoami without printing other accounts', async () => {
		const wrangler = new FakeWrangler();
		wrangler.accounts = [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'other-lab' }];
		wrangler.seedReadyWorker();
		const result = await run(
			['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--json'],
			wrangler
		);
		expect(result.code).toBe(6);
		expect(result.stdout).toMatch(/not present in this Wrangler session/);
		expect(result.stdout).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		expect(result.stdout).not.toContain('other-lab');
		expect(result.stdout).not.toContain(ACCOUNT_ID);
		expect(wrangler.calls).not.toContain('listD1');
	});
});

describe('initial managed deploy vars', () => {
	it('requires --email-from and a public origin when local state is absent', async () => {
		const wrangler = new FakeWrangler();
		const result = await run(
			['--cloudflare', 'deploy', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler
		);
		expect(result.code).toBe(6);
		expect(result.stdout).toMatch(/--email-from is required for the initial managed deploy/);
		expect(wrangler.calls).not.toContain('createD1:signkit');
		expect(wrangler.calls.some((call) => call.startsWith('deploy'))).toBe(false);
	});

	it('still requires origin and email flags for a secret-bearing Worker stub with no state', async () => {
		const wrangler = new FakeWrangler();
		wrangler.secrets.set('signkit', [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		const denied = await run(
			['--cloudflare', 'deploy', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler
		);
		expect(denied.code).toBe(6);
		expect(denied.stdout).toMatch(/--email-from is required for the initial managed deploy/);
		expect(wrangler.calls).not.toContain('createD1:signkit');

		const allowed = await run(
			[
				'--cloudflare',
				'deploy',
				'--account-id',
				ACCOUNT_ID,
				...INITIAL_DEPLOY_FLAGS,
				'--yes',
				'--json'
			],
			wrangler
		);
		expect(allowed.code).toBe(0);
		expect(wrangler.calls).toContain('createD1:signkit');
		expect(wrangler.lastConfig).toMatch(/SIGNKIT_MAIL_PROVIDER/);
		expect(wrangler.lastConfig).toMatch(/https:\/\/signkit\.example\.workers\.dev/);
		expect(wrangler.lastConfig).toMatch(/sign@example.com/);
		expect(wrangler.lastConfig).toMatch(/https:\/\/www\.d6e\.ai/);
		expect(wrangler.lastConfig).toMatch(/SignKit/);
	});
});

describe('plan reports drift without mutating', () => {
	it('returns drift on plan instead of exiting conflict', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.d1 = [{ uuid: '55555555-5555-5555-5555-555555555555', name: 'signkit' }];
		const fs = new MemoryFileSystem();
		await fs.writeFile(
			'/xdg/state/create-signkit/state.json',
			JSON.stringify({
				schemaVersion: 1,
				provider: 'cloudflare',
				accountId: ACCOUNT_ID,
				workerName: 'signkit',
				d1: { name: 'signkit', id: D1_ID },
				r2: { name: 'signkit-objects' },
				channel: 'stable',
				updatedAt: '2026-09-15T00:00:00.000Z'
			})
		);
		const result = await run(
			['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--json'],
			wrangler,
			fs
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).drift.join(' ')).toMatch(/d1 id/);
		expect(JSON.parse(result.stdout).mutations).toEqual([]);
	});
});

describe('state provider isolation', () => {
	it('refuses to inherit non-cloudflare state', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const fs = new MemoryFileSystem();
		await fs.writeFile(
			'/xdg/state/create-signkit/state.json',
			JSON.stringify({
				schemaVersion: 1,
				provider: 'node',
				accountId: ACCOUNT_ID,
				workerName: 'signkit',
				d1: { name: 'signkit', id: D1_ID },
				r2: { name: 'signkit-objects' },
				channel: 'stable',
				updatedAt: '2026-09-15T00:00:00.000Z'
			})
		);
		const result = await run(
			['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--json'],
			wrangler,
			fs
		);
		expect(result.code).toBe(4);
		expect(result.stdout).toMatch(/provider is not cloudflare/);
		expect(wrangler.calls).not.toContain('whoami');
		expect(wrangler.calls).not.toContain('listD1');
	});
});

describe('adopt retarget clears invented release metadata', () => {
	it('clears previous version metadata when recording a different identity', async () => {
		const wrangler = new FakeWrangler();
		wrangler.d1 = [{ uuid: '44444444-4444-4444-4444-444444444444', name: 'signkit-prod-db' }];
		wrangler.r2.add('signkit-prod-objects');
		wrangler.secrets.set('signkit-prod', [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		wrangler.versions.set('signkit-prod', [{ id: PREVIOUS_VERSION }]);
		const fs = new MemoryFileSystem();
		await fs.writeFile(
			'/xdg/state/create-signkit/state.json',
			JSON.stringify({
				schemaVersion: 1,
				provider: 'cloudflare',
				accountId: ACCOUNT_ID,
				workerName: 'signkit',
				d1: { name: 'signkit', id: D1_ID },
				r2: { name: 'signkit-objects' },
				channel: 'stable',
				version: 'v0.0.1',
				commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				lastWorkerVersionId: PREVIOUS_VERSION,
				updatedAt: '2026-09-15T00:00:00.000Z'
			})
		);
		const result = await run(
			[
				'--cloudflare',
				'adopt',
				'--account-id',
				ACCOUNT_ID,
				'--worker-name',
				'signkit-prod',
				'--d1',
				'signkit-prod-db',
				'--r2',
				'signkit-prod-objects',
				'--yes',
				'--json'
			],
			wrangler,
			fs
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).version).toBeUndefined();
		const state = JSON.parse(await fs.readFile('/xdg/state/create-signkit/state.json'));
		expect(state.workerName).toBe('signkit-prod');
		expect(state.version).toBeUndefined();
		expect(state.commit).toBeUndefined();
		expect(state.lastWorkerVersionId).toBeUndefined();
	});
});

describe('takeover and secret-only stub', () => {
	it('refuses deploy takeover when remote versions exist and local state does not', async () => {
		const wrangler = new FakeWrangler();
		wrangler.secrets.set('signkit', [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		wrangler.versions.set('signkit', [{ id: PREVIOUS_VERSION }]);
		const result = await run(
			[
				'--cloudflare',
				'deploy',
				'--account-id',
				ACCOUNT_ID,
				...INITIAL_DEPLOY_FLAGS,
				'--yes',
				'--json'
			],
			wrangler
		);
		expect(result.code).toBe(4);
		expect(result.stdout).toMatch(/adopt the existing deployment/);
		expect(wrangler.calls.some((call) => call.startsWith('deploy'))).toBe(false);
		expect(wrangler.calls).not.toContain('createD1:signkit');
	});

	it('allows the secret-only stub case with no published versions', async () => {
		const wrangler = new FakeWrangler();
		wrangler.secrets.set('signkit', [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		const result = await run(
			[
				'--cloudflare',
				'deploy',
				'--account-id',
				ACCOUNT_ID,
				...INITIAL_DEPLOY_FLAGS,
				'--yes',
				'--json'
			],
			wrangler
		);
		expect(result.code).toBe(0);
		expect(wrangler.calls).toContain('deploy:signkit');
	});
});

describe('upgrade routing flags', () => {
	it('refuses an explicit --domain that differs from stored state', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const fs = new MemoryFileSystem();
		await fs.writeFile(
			'/xdg/state/create-signkit/state.json',
			JSON.stringify({
				schemaVersion: 1,
				provider: 'cloudflare',
				accountId: ACCOUNT_ID,
				workerName: 'signkit',
				d1: { name: 'signkit', id: D1_ID },
				r2: { name: 'signkit-objects' },
				domain: 'sign.example.com',
				publicOrigin: 'https://sign.example.com',
				channel: 'stable',
				updatedAt: '2026-09-15T00:00:00.000Z'
			})
		);
		const result = await run(
			[
				'--cloudflare',
				'upgrade',
				'--account-id',
				ACCOUNT_ID,
				'--domain',
				'other.example.com',
				'--yes',
				'--json'
			],
			wrangler,
			fs
		);
		expect(result.code).toBe(4);
		expect(result.stdout).toMatch(/deploy or adopt to change routing/);
	});
});

describe('bootstrap owner email', () => {
	it('requires --bootstrap-owner-email for a fresh deploy', async () => {
		const wrangler = new FakeWrangler();
		wrangler.secrets.set('signkit', [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		const denied = await run(
			[
				'--cloudflare',
				'deploy',
				'--account-id',
				ACCOUNT_ID,
				'--email-from',
				'sign@example.com',
				'--public-origin',
				'https://signkit.example.workers.dev',
				'--yes',
				'--json'
			],
			wrangler
		);
		expect(denied.code).toBe(6);
		expect(denied.stdout).toMatch(/--bootstrap-owner-email is required/);
		expect(wrangler.calls).not.toContain('createD1:signkit');
		expect(wrangler.calls.some((call) => call.startsWith('deploy'))).toBe(false);
	});

	it('canonicalizes the flag, records it in state, and applies it as a non-secret Worker var', async () => {
		const wrangler = new FakeWrangler();
		wrangler.secrets.set('signkit', [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		wrangler.versions.set('signkit', []);
		const result = await run(
			[
				'--cloudflare',
				'deploy',
				'--account-id',
				ACCOUNT_ID,
				'--email-from',
				'sign@example.com',
				'--public-origin',
				'https://signkit.example.workers.dev',
				'--bootstrap-owner-email',
				'Owner@Example.com',
				'--yes',
				'--json'
			],
			wrangler
		);
		expect(result.code).toBe(0);
		const state = JSON.parse(await result.fs.readFile('/xdg/state/create-signkit/state.json'));
		expect(state.bootstrapOwnerEmail).toBe('owner@example.com');
		expect(wrangler.lastConfig).toMatch(/"SIGNKIT_BOOTSTRAP_OWNER_EMAIL": "owner@example\.com"/);
		expect(wrangler.lastConfig).not.toContain('Owner@Example.com');
		// The address is configuration, not a log line: human and JSON output
		// name the var/flag but never repeat the address.
		expect(result.stdout).not.toContain('owner@example.com');
		expect(result.stdout).not.toContain('Owner@Example.com');
		expect(result.stdout).toMatch(/bootstrap owner/i);
	});

	it('inherits the recorded address on upgrade so the flag is passed once', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const fs = await writeCloudflareState(new MemoryFileSystem());
		const result = await run(
			['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler,
			fs
		);
		expect(result.code).toBe(0);
		expect(wrangler.calls).toContain('uploadVersion:signkit');
		expect(result.stdout).not.toContain('owner@example.com');
	});

	it('rejects an adversarially long recorded address before upgrading', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const adversarialAddress = `owner@${'.'.repeat(100_000)}\ninvalid`;
		const fs = await writeCloudflareState(new MemoryFileSystem(), {
			bootstrapOwnerEmail: adversarialAddress
		});
		const denied = await run(
			['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler,
			fs
		);

		expect(denied.code).toBe(6);
		expect(denied.stdout).toMatch(/--bootstrap-owner-email is required/);
		expect(denied.stdout).not.toContain(adversarialAddress);
		expect(wrangler.calls.some((call) => call.startsWith('uploadVersion'))).toBe(false);
	});

	it('requires the flag on upgrade when no address is recorded (pre-requirement state)', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const fs = new MemoryFileSystem();
		await fs.writeFile(
			'/xdg/state/create-signkit/state.json',
			JSON.stringify({
				schemaVersion: 1,
				provider: 'cloudflare',
				accountId: ACCOUNT_ID,
				workerName: 'signkit',
				d1: { name: 'signkit', id: D1_ID },
				r2: { name: 'signkit-objects' },
				publicOrigin: 'https://signkit.example.workers.dev',
				channel: 'stable',
				updatedAt: '2026-09-15T00:00:00.000Z'
			})
		);
		const denied = await run(
			['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler,
			fs
		);
		expect(denied.code).toBe(6);
		expect(denied.stdout).toMatch(/--bootstrap-owner-email is required/);
		expect(wrangler.calls.some((call) => call.startsWith('uploadVersion'))).toBe(false);

		const allowed = await run(
			[
				'--cloudflare',
				'upgrade',
				'--account-id',
				ACCOUNT_ID,
				'--bootstrap-owner-email',
				'owner@example.com',
				'--yes',
				'--json'
			],
			wrangler,
			fs
		);
		expect(allowed.code).toBe(0);
		const state = JSON.parse(await fs.readFile('/xdg/state/create-signkit/state.json'));
		expect(state.bootstrapOwnerEmail).toBe('owner@example.com');
	});

	it('accepts the flag on adopt without requiring it', async () => {
		const wrangler = new FakeWrangler();
		wrangler.d1 = [{ uuid: '44444444-4444-4444-4444-444444444444', name: 'signkit-prod-db' }];
		wrangler.r2.add('signkit-prod-objects');
		wrangler.secrets.set('signkit-prod', [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		wrangler.versions.set('signkit-prod', [{ id: PREVIOUS_VERSION }]);
		const fs = new MemoryFileSystem();
		const result = await run(
			[
				'--cloudflare',
				'adopt',
				'--account-id',
				ACCOUNT_ID,
				'--worker-name',
				'signkit-prod',
				'--d1',
				'signkit-prod-db',
				'--r2',
				'signkit-prod-objects',
				'--bootstrap-owner-email',
				'owner@example.com',
				'--yes',
				'--json'
			],
			wrangler,
			fs
		);
		expect(result.code).toBe(0);
		const state = JSON.parse(await fs.readFile('/xdg/state/create-signkit/state.json'));
		expect(state.bootstrapOwnerEmail).toBe('owner@example.com');
		expect(result.stdout).not.toContain('owner@example.com');
	});
});

describe('human plan output', () => {
	it('writes non-JSON plan output to stdout, not stderr', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const result = await run(['--cloudflare', 'plan', '--account-id', ACCOUNT_ID], wrangler);
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/Plan:/);
		expect(result.stdout).toMatch(/plan only/);
		expect(result.stderr).toBe('');
	});

	it('prints drift in human plan output', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.d1 = [{ uuid: '55555555-5555-5555-5555-555555555555', name: 'signkit' }];
		const fs = await writeCloudflareState(new MemoryFileSystem(), {
			d1: { name: 'signkit', id: D1_ID }
		});
		const result = await run(['--cloudflare', 'plan', '--account-id', ACCOUNT_ID], wrangler, fs);
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/Drift:/);
		expect(result.stdout).toMatch(/d1 id/);
		expect(result.stderr).toBe('');
	});
});

describe('applied migrations on smoke failure', () => {
	it('records newly applied pending migrations on both success and smoke failure', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.pendingMigrations = ['0002_next.sql'];
		const fs = await writeCloudflareState(new MemoryFileSystem());
		wrangler.fs = fs;
		const http = new FakeHttp();
		http.on('https://signkit.example.workers.dev/api/v1/system/capabilities', 'nope', 500);
		const failed = await reconcileCloudflare(command({ command: 'upgrade' }), {
			fs,
			http,
			releases: fakeReleases(),
			wrangler,
			extractor: fakeExtractor(fs),
			now: () => new Date('2026-09-15T00:00:00.000Z'),
			env: { XDG_STATE_HOME: '/xdg/state' },
			smokeAttempts: 1,
			smokeBackoffMs: 0,
			sleep: async () => undefined
		});
		expect(failed.exitCode).toBe(1);
		const failedState = JSON.parse(await fs.readFile('/xdg/state/create-signkit/state.json'));
		expect(failedState.appliedMigrations).toEqual(['0002_next.sql']);

		const successWrangler = new FakeWrangler();
		successWrangler.seedReadyWorker();
		successWrangler.pendingMigrations = ['0002_next.sql'];
		const successFs = await writeCloudflareState(new MemoryFileSystem());
		successWrangler.fs = successFs;
		const successHttp = new FakeHttp();
		successHttp.on(
			'https://signkit.example.workers.dev/api/v1/system/capabilities',
			JSON.stringify({ name: 'signkit', apiVersion: '1' })
		);
		const succeeded = await reconcileCloudflare(command({ command: 'upgrade' }), {
			fs: successFs,
			http: successHttp,
			releases: fakeReleases(),
			wrangler: successWrangler,
			extractor: fakeExtractor(successFs),
			now: () => new Date('2026-09-15T00:00:00.000Z'),
			env: { XDG_STATE_HOME: '/xdg/state' },
			smokeAttempts: 1,
			smokeBackoffMs: 0,
			sleep: async () => undefined
		});
		expect(succeeded.exitCode).toBe(0);
		const successState = JSON.parse(
			await successFs.readFile('/xdg/state/create-signkit/state.json')
		);
		expect(successState.appliedMigrations).toEqual(['0002_next.sql']);
	});
});

describe('custom-domain smoke fallback', () => {
	it('treats a healthy workers.dev origin as success without rollback', async () => {
		const wrangler = new FakeWrangler();
		wrangler.secrets.set('signkit', [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		const fs = new MemoryFileSystem();
		wrangler.fs = fs;
		const http = new FakeHttp();
		http.on('https://sign.example.com/api/v1/system/capabilities', 'nope', 503);
		http.on(
			'https://signkit.example.workers.dev/api/v1/system/capabilities',
			JSON.stringify({ name: 'signkit', apiVersion: '1' })
		);
		const result = await reconcileCloudflare(
			command({
				command: 'deploy',
				domain: 'sign.example.com',
				publicOrigin: 'https://sign.example.com',
				emailFrom: 'sign@example.com',
				bootstrapOwnerEmail: 'owner@example.com',
				overrides: {
					domain: true,
					publicOrigin: true,
					emailFrom: true,
					bootstrapOwnerEmail: true
				}
			}),
			{
				fs,
				http,
				releases: fakeReleases(),
				wrangler,
				extractor: fakeExtractor(fs),
				now: () => new Date('2026-09-15T00:00:00.000Z'),
				env: { XDG_STATE_HOME: '/xdg/state' },
				smokeAttempts: 1,
				smokeBackoffMs: 0,
				sleep: async () => undefined
			}
		);
		expect(result.exitCode).toBe(0);
		expect(wrangler.calls.some((call) => call.startsWith('rollback:'))).toBe(false);
	});
});

describe('production smoke origin', () => {
	it('fails closed when only a version-preview URL is known', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.deployResult = {
			workerVersionId: WORKER_VERSION,
			workerUrl: `https://${WORKER_VERSION}-signkit.example.workers.dev`,
			stdout: `Uploaded\nVersion ID: ${WORKER_VERSION}\nhttps://${WORKER_VERSION}-signkit.example.workers.dev`,
			aborted: false
		};
		const fs = await writeCloudflareState(new MemoryFileSystem(), { publicOrigin: undefined });
		wrangler.fs = fs;
		const result = await reconcileCloudflare(command({ command: 'upgrade' }), {
			fs,
			http: new FakeHttp(),
			releases: fakeReleases(),
			wrangler,
			extractor: fakeExtractor(fs),
			now: () => new Date('2026-09-15T00:00:00.000Z'),
			env: { XDG_STATE_HOME: '/xdg/state' },
			smokeAttempts: 1,
			smokeBackoffMs: 0,
			sleep: async () => undefined
		});
		expect(result.exitCode).toBe(1);
		expect(result.message).toMatch(/smoke check skipped/i);
		expect(result.message).toMatch(/version-preview/);
		expect(wrangler.calls.some((call) => call.startsWith('rollback:'))).toBe(true);
	});
});

describe('same-second D1 backup names', () => {
	it('does not overwrite an existing backup from the same timestamp', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const fs = await writeCloudflareState(new MemoryFileSystem());
		await fs.writeFile(
			'/xdg/state/create-signkit/backups/d1-signkit-20260915T000000000Z.sql',
			'-- previous\n'
		);
		const result = await run(
			['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json'],
			wrangler,
			fs
		);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).d1BackupPath).toBe(
			'/xdg/state/create-signkit/backups/d1-signkit-20260915T000000000Z-2.sql'
		);
		expect(
			await fs.readFile('/xdg/state/create-signkit/backups/d1-signkit-20260915T000000000Z.sql')
		).toMatch(/previous/);
	});
});
