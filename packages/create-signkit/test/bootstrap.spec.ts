import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runCreateSignkit } from '../src/cli/run.js';
import {
	ensureRecoveryBinding,
	ensureRecoverySecrets,
	resolveRecoveryBindingPath,
	resolveRecoveryPath
} from '../src/recovery/bootstrap.js';
import {
	ACCOUNT_ID,
	FakeHttp,
	FakeWrangler,
	MemoryFileSystem,
	PREVIOUS_VERSION,
	fakeExtractor,
	fakeReleases,
	sampleManifest,
	writeCloudflareState
} from './helpers.js';

const OAUTH = {
	D6E_AUTH_CLIENT_ID: 'bootstrap-oauth-client-id',
	D6E_AUTH_CLIENT_SECRET: 'bootstrap-oauth-client-secret'
};
const OAUTH_JSON = JSON.stringify(OAUTH);
const STATE_PATH = '/xdg/state/create-signkit/state.json';
const RECOVERY_PATH = resolveRecoveryPath(STATE_PATH);
const RECOVERY_BINDING_PATH = resolveRecoveryBindingPath(RECOVERY_PATH);

const INITIAL_DEPLOY_ARGV = [
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
];

function encode(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function runDeploy(options: {
	wrangler?: FakeWrangler;
	fs?: MemoryFileSystem;
	stdinText?: string;
	argv?: string[];
	releases?: ReturnType<typeof fakeReleases>;
}): Promise<{
	code: number;
	stdout: string;
	stderr: string;
	fs: MemoryFileSystem;
	wrangler: FakeWrangler;
}> {
	const wrangler = options.wrangler ?? new FakeWrangler();
	const fs = options.fs ?? new MemoryFileSystem();
	const stdout: string[] = [];
	const stderr: string[] = [];
	const http = new FakeHttp();
	http.on(
		'https://signkit.example.workers.dev/api/v1/system/capabilities',
		JSON.stringify({ name: 'signkit', apiVersion: '1' })
	);
	wrangler.fs = fs;
	const code = await runCreateSignkit({
		argv: options.argv ?? INITIAL_DEPLOY_ARGV,
		stdout: { write: (chunk) => stdout.push(chunk) },
		stderr: { write: (chunk) => stderr.push(chunk) },
		env: { XDG_STATE_HOME: '/xdg/state' },
		runtime: {
			fs,
			wrangler,
			releases: options.releases ?? fakeReleases(),
			extractor: fakeExtractor(fs),
			http,
			now: () => new Date('2026-09-15T00:00:00.000Z'),
			smokeBackoffMs: 0,
			sleep: async () => undefined,
			readStdin:
				options.stdinText === undefined
					? async (): Promise<Uint8Array> => {
							throw new Error('stdin must not be read in this test');
						}
					: async (): Promise<Uint8Array> => encode(options.stdinText as string)
		}
	});
	return { code, stdout: stdout.join(''), stderr: stderr.join(''), fs, wrangler };
}

describe('pristine initial deploy recovery lifecycle', () => {
	it('creates the recovery file before any Cloudflare mutation and uploads via --secrets-file', async () => {
		const result = await runDeploy({ stdinText: OAUTH_JSON });
		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.recoveryPath).toBe(RECOVERY_PATH);
		expect(parsed.recoveryFingerprint).toMatch(/^[0-9a-f]{64}$/);
		const text: string = await result.fs.readFile(RECOVERY_PATH);
		const flat = JSON.parse(text) as Record<string, unknown>;
		expect(parsed.recoveryFingerprint).toBe(sha256Hex(text));
		const mutations: string[] = parsed.mutations;
		expect(mutations[0]).toBe('recovery');
		expect(mutations).toContain('create-d1');
		expect(mutations).toContain('deploy');
		expect(result.wrangler.deployOptions).toHaveLength(1);
		const stagedPath = result.wrangler.deployOptions[0]?.secretsFile;
		expect(stagedPath).toMatch(/^\/tmp\/create-signkit-secrets-\d+\/secrets\.json$/);
		expect(stagedPath).not.toBe(RECOVERY_PATH);
		expect(await result.fs.exists(stagedPath as string)).toBe(false);
		expect(JSON.parse(result.wrangler.stagedSecrets[0] as string)).toEqual(flat);
		expect((await result.fs.stat(RECOVERY_PATH)).mode & 0o777).toBe(0o600);
		expect((await result.fs.stat(RECOVERY_BINDING_PATH)).mode & 0o777).toBe(0o600);
		const config = result.wrangler.lastConfig as string;
		const configJson = JSON.parse(config) as { secrets?: { required?: unknown } };
		expect(configJson.secrets?.required).toEqual([
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		expect(Object.keys(flat).sort()).toEqual([
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET',
			'DELIVERY_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'SESSION_ENCRYPTION_KEY'
		]);
		expect(result.stdout).not.toContain(OAUTH.D6E_AUTH_CLIENT_ID);
		expect(result.stdout).not.toContain(OAUTH.D6E_AUTH_CLIENT_SECRET);
		expect(result.stdout).not.toContain((flat.DELIVERY_ENCRYPTION_KEY as string).slice(0, 12));
	});

	it('keeps plan read-only: never reads stdin and never creates files', async () => {
		const fs = new MemoryFileSystem();
		const wrangler = new FakeWrangler();
		const stdout: string[] = [];
		const code = await runCreateSignkit({
			argv: ['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--json'],
			stdout: { write: (chunk) => stdout.push(chunk) },
			stderr: { write: () => undefined },
			env: { XDG_STATE_HOME: '/xdg/state' },
			runtime: {
				fs,
				wrangler,
				releases: fakeReleases(),
				extractor: fakeExtractor(fs),
				readStdin: async (): Promise<Uint8Array> => {
					throw new Error('plan must never read stdin');
				}
			}
		});
		expect(code).toBe(0);
		expect(fs.writes).toEqual([]);
		expect(await fs.exists(RECOVERY_PATH)).toBe(false);
		const parsed = JSON.parse(stdout.join(''));
		expect(parsed.recoveryPath).toBeUndefined();
		expect(parsed.recoveryFingerprint).toBeUndefined();
	});

	it('fails plan read-only when the manifest declares an unknown secret type', async () => {
		const releases = fakeReleases(
			sampleManifest({ requiredSecrets: [...sampleManifest().requiredSecrets, 'UNKNOWN_TYPE'] })
		);
		const result = await runDeploy({
			releases,
			argv: ['--cloudflare', 'plan', '--account-id', ACCOUNT_ID, '--json']
		});
		expect(result.code).toBe(6);
		expect(result.stdout).toMatch(/unknown required secret names: UNKNOWN_TYPE/);
		expect(result.fs.writes).toEqual([]);
		expect(await result.fs.exists(RECOVERY_PATH)).toBe(false);
		expect(result.wrangler.calls).not.toContain('createD1:signkit');
	});

	it('fails bundle verification before recovery or Cloudflare mutation, then retries cleanly', async () => {
		const fs = new MemoryFileSystem();
		const wrangler = new FakeWrangler();
		const failingReleases = fakeReleases();
		const prepareBundle = failingReleases.prepareBundle.bind(failingReleases);
		let downloads = 0;
		failingReleases.prepareBundle = async () => {
			downloads += 1;
			if (downloads === 1) {
				throw new Error('simulated provenance verification failure');
			}
			return prepareBundle();
		};
		const first = await runDeploy({
			wrangler,
			fs,
			releases: failingReleases
		});
		expect(first.code).toBe(1);
		expect(first.stdout).toMatch(/simulated provenance verification failure/);
		expect(first.wrangler.calls).not.toContain('createD1:signkit');
		expect(first.wrangler.calls.some((call) => call.startsWith('deploy'))).toBe(false);
		expect(await fs.exists(RECOVERY_PATH)).toBe(false);
		const second = await runDeploy({ wrangler, fs, stdinText: OAUTH_JSON });
		expect(second.code).toBe(0);
		const secondParsed = JSON.parse(second.stdout);
		expect(secondParsed.mutations).toContain('recovery');
		expect(secondParsed.mutations).toContain('create-d1');
		expect(secondParsed.mutations).toContain('create-r2');
		expect(second.wrangler.deployOptions[0]?.secretsFile).not.toBe(RECOVERY_PATH);
	});

	it('refuses to reuse a failed bootstrap recovery file for another Worker', async () => {
		const fs = new MemoryFileSystem();
		const wrangler = new FakeWrangler();
		wrangler.createD1 = async (): Promise<never> => {
			throw new Error('leave recovery before resource creation');
		};
		const first = await runDeploy({ wrangler, fs, stdinText: OAUTH_JSON });
		expect(first.code).toBe(1);
		expect(await fs.exists(RECOVERY_PATH)).toBe(true);
		const second = await runDeploy({
			wrangler,
			fs,
			argv: [
				'--cloudflare',
				'deploy',
				'--account-id',
				ACCOUNT_ID,
				'--worker-name',
				'signkit-other',
				...INITIAL_DEPLOY_ARGV.slice(4)
			]
		});
		expect(second.code).toBe(6);
		expect(second.stdout).toMatch(/does not match the selected Cloudflare account and Worker/);
		expect(wrangler.calls).not.toContain('deploy:signkit-other');
	});

	it('never auto-generates recovery for an existing deployment', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const fs = await writeCloudflareState(new MemoryFileSystem());
		const result = await runDeploy({ wrangler, fs });
		expect(result.code).toBe(0);
		expect(await fs.exists(RECOVERY_PATH)).toBe(false);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.recoveryPath).toBeUndefined();
		expect(parsed.recoveryFingerprint).toBeUndefined();
	});

	it('never auto-generates recovery or passes secretsFile on upgrade', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const fs = await writeCloudflareState(new MemoryFileSystem());
		const result = await runDeploy({
			wrangler,
			fs,
			argv: ['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json']
		});
		expect(result.code).toBe(0);
		expect(await fs.exists(RECOVERY_PATH)).toBe(false);
		expect(wrangler.deployOptions).toHaveLength(1);
		expect(wrangler.deployOptions[0]?.secretsFile).toBeUndefined();
		const parsed = JSON.parse(result.stdout);
		expect(parsed.recoveryPath).toBeUndefined();
		expect(parsed.recoveryFingerprint).toBeUndefined();
	});

	it('uses an existing recovery file to restore missing secrets during upgrade', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.secrets.set('signkit', [
			'DELIVERY_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET',
			'D6E_AUTH_CLIENT_ID',
			'D6E_AUTH_CLIENT_SECRET'
		]);
		const fs = await writeCloudflareState(new MemoryFileSystem());
		let draw = 0;
		await ensureRecoveryBinding({
			fs,
			recoveryPath: RECOVERY_PATH,
			accountId: ACCOUNT_ID,
			workerName: 'signkit',
			allowCreate: true
		});
		const recovery = await ensureRecoverySecrets({
			fs,
			recoveryPath: RECOVERY_PATH,
			requiredSecrets: sampleManifest().requiredSecrets,
			oauth: OAUTH,
			randomBytes: (size: number): Uint8Array => new Uint8Array(size).fill(++draw)
		});
		const recoveryText = await fs.readFile(RECOVERY_PATH);
		const exclusiveWritesBefore = fs.exclusiveWrites.length;
		const result = await runDeploy({
			wrangler,
			fs,
			argv: ['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json']
		});
		expect(result.code).toBe(0);
		expect(await fs.readFile(RECOVERY_PATH)).toBe(recoveryText);
		expect(fs.exclusiveWrites).toHaveLength(exclusiveWritesBefore + 1);
		expect(wrangler.deployOptions[0]?.secretsFile).not.toBe(RECOVERY_PATH);
		expect(JSON.parse(wrangler.stagedSecrets[0] as string)).toEqual({
			SESSION_ENCRYPTION_KEY: (JSON.parse(recoveryText) as Record<string, string>)[
				'SESSION_ENCRYPTION_KEY'
			]
		});
		const parsed = JSON.parse(result.stdout);
		expect(parsed.recoveryPath).toBe(RECOVERY_PATH);
		expect(parsed.recoveryFingerprint).toBe(recovery.fingerprint);
		expect(parsed.mutations).not.toContain('recovery');
	});

	it('fails existing deployments with missing secrets when recovery is unavailable', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		wrangler.secrets.set('signkit', ['DELIVERY_ENCRYPTION_KEY']);
		const fs = await writeCloudflareState(new MemoryFileSystem());
		const result = await runDeploy({ wrangler, fs });
		expect(result.code).toBe(6);
		expect(result.stdout).toMatch(/Restore the flat recovery JSON/);
		expect(result.stdout).not.toContain('wrangler secret put');
		expect(wrangler.calls.some((call) => call.startsWith('exportD1:'))).toBe(false);
		expect(wrangler.calls.some((call) => call.startsWith('deploy:'))).toBe(false);
	});

	it('treats remote Worker versions or secrets with no local state as not pristine', async () => {
		for (const seed of ['versions', 'secrets'] as const) {
			const wrangler = new FakeWrangler();
			if (seed === 'versions') {
				wrangler.versions.set('signkit', [{ id: PREVIOUS_VERSION }]);
			} else {
				wrangler.secrets.set('signkit', [
					'DELIVERY_ENCRYPTION_KEY',
					'SESSION_ENCRYPTION_KEY',
					'DELIVERY_WORKER_SECRET',
					'D6E_AUTH_CLIENT_ID',
					'D6E_AUTH_CLIENT_SECRET'
				]);
			}
			const result = await runDeploy({ wrangler });
			expect(result.code).toBe(4);
			expect(result.stdout).toMatch(/adopt the existing deployment/);
			expect(await result.fs.exists(RECOVERY_PATH)).toBe(false);
			expect(wrangler.calls).not.toContain('createD1:signkit');
		}
	});

	it('fails unknown manifest secret types pre-mutation with restore guidance', async () => {
		const releases = fakeReleases(
			sampleManifest({ requiredSecrets: [...sampleManifest().requiredSecrets, 'UNKNOWN_TYPE'] })
		);
		const result = await runDeploy({ stdinText: OAUTH_JSON, releases });
		expect(result.code).toBe(6);
		expect(result.stdout).toMatch(/unknown required secret names: UNKNOWN_TYPE/);
		expect(result.stdout).toMatch(/Restore the recovery file/);
		expect(result.stdout).toMatch(RECOVERY_PATH);
		expect(result.wrangler.calls).not.toContain('createD1:signkit');
		expect(result.wrangler.calls.some((call) => call.startsWith('deploy'))).toBe(false);
		expect(await result.fs.exists(RECOVERY_PATH)).toBe(false);
	});

	it('fails unknown manifest secret types on upgrade before any mutation', async () => {
		const wrangler = new FakeWrangler();
		wrangler.seedReadyWorker();
		const fs = await writeCloudflareState(new MemoryFileSystem());
		const releases = fakeReleases(
			sampleManifest({ requiredSecrets: [...sampleManifest().requiredSecrets, 'UNKNOWN_TYPE'] })
		);
		const result = await runDeploy({
			wrangler,
			fs,
			releases,
			argv: ['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID, '--yes', '--json']
		});
		expect(result.code).toBe(6);
		expect(result.stdout).toMatch(/unknown required secret names: UNKNOWN_TYPE/);
		expect(result.stdout).not.toContain('wrangler secret put');
		expect(await fs.exists(RECOVERY_PATH)).toBe(false);
		expect(wrangler.calls.some((call) => call.startsWith('exportD1:'))).toBe(false);
		expect(wrangler.calls.some((call) => call.startsWith('listMigrations:'))).toBe(false);
		expect(wrangler.calls.some((call) => call.startsWith('applyMigrations:'))).toBe(false);
		expect(wrangler.calls.some((call) => call.startsWith('uploadVersion:'))).toBe(false);
	});

	it('rejects invalid stdin without creating files or mutating Cloudflare', async () => {
		const oversized = `{"D6E_AUTH_CLIENT_ID":"${'i'.repeat(16 * 1024)}","D6E_AUTH_CLIENT_SECRET":"s"}`;
		for (const stdinText of [
			oversized,
			'not-json',
			JSON.stringify({ D6E_AUTH_CLIENT_ID: 'only-one' }),
			JSON.stringify({ ...OAUTH, EXTRA: 'x' }),
			JSON.stringify({ D6E_AUTH_CLIENT_ID: '', D6E_AUTH_CLIENT_SECRET: 's' })
		]) {
			const result = await runDeploy({ stdinText });
			expect(result.code).toBe(6);
			expect(await result.fs.exists(RECOVERY_PATH)).toBe(false);
			expect(result.wrangler.calls).not.toContain('createD1:signkit');
			expect(result.wrangler.calls.some((call) => call.startsWith('deploy'))).toBe(false);
		}
	});

	it('fails closed with restore guidance and keeps a corrupt existing recovery file', async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir('/xdg/state/create-signkit', { mode: 0o700 });
		await fs.chmod('/xdg/state/create-signkit', 0o700);
		await fs.writeFileExclusive(RECOVERY_PATH, '{"tampered":true}', 0o600);
		const result = await runDeploy({ fs, stdinText: OAUTH_JSON });
		expect(result.code).toBe(6);
		expect(result.stdout).toMatch(/Restore the recovery file/);
		expect(result.stdout).toMatch(RECOVERY_PATH);
		expect(await fs.readFile(RECOVERY_PATH)).toBe('{"tampered":true}');
		expect(result.wrangler.calls).not.toContain('createD1:signkit');
	});

	it('never leaks OAuth values in success metadata or failure errors', async () => {
		const oauth = {
			D6E_AUTH_CLIENT_ID: 'unique-oauth-id-7f3a9c',
			D6E_AUTH_CLIENT_SECRET: 'unique-oauth-secret-7f3a9c'
		};
		const success = await runDeploy({ stdinText: JSON.stringify(oauth) });
		expect(success.code).toBe(0);
		expect(success.stdout).not.toContain(oauth.D6E_AUTH_CLIENT_ID);
		expect(success.stdout).not.toContain(oauth.D6E_AUTH_CLIENT_SECRET);
		expect(success.stderr).not.toContain(oauth.D6E_AUTH_CLIENT_ID);
		expect(success.stderr).not.toContain(oauth.D6E_AUTH_CLIENT_SECRET);
		const badStdin = JSON.stringify({ ...oauth, EXTRA_KEY: 'intruder' });
		const failed = await runDeploy({ stdinText: badStdin });
		expect(failed.code).toBe(6);
		expect(failed.stdout).not.toContain(oauth.D6E_AUTH_CLIENT_ID);
		expect(failed.stdout).not.toContain(oauth.D6E_AUTH_CLIENT_SECRET);
		const stateText = await success.fs.readFile(STATE_PATH).catch(() => '');
		expect(stateText).not.toContain(oauth.D6E_AUTH_CLIENT_ID);
		expect(stateText).not.toContain(oauth.D6E_AUTH_CLIENT_SECRET);
	});
});
