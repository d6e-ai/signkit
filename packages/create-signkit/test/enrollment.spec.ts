import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runCreateSignkit } from '../src/cli/run.js';
import { parseArgv, type ParsedCommand } from '../src/cli/parse.js';
import {
	resolveRecoveryBindingPath,
	resolveRecoveryPath,
	ensureRecoveryBinding,
	ensureRecoverySecrets
} from '../src/recovery/bootstrap.js';
import {
	ENROLLMENT_TOKEN_PATTERN,
	resolveEnrollmentRecordPath,
	resolveEnrollmentToken
} from '../src/enrollment/console-enrollment.js';
import { boundedFetch, type HttpRequest, type HttpResponse } from '../src/runtime/http.js';
import {
	ACCOUNT_ID,
	FakeCloudflareClient,
	FakeHttp,
	MemoryFileSystem,
	fakeExtractor,
	fakeReleases,
	writeCloudflareState
} from './helpers.js';

const TOKEN = `d6ee_${'A'.repeat(20)}${'b'.repeat(20)}-_9`;
const CLIENT_ID = 'd6e_enrolled-client-id';
const CLIENT_SECRET = 'd6es_enrolled-client-secret-never-print';
const SERVER_ID = '0193a8f2-0000-7000-8000-000000000123';
const AUTH_ORIGIN = 'https://auth.example.com';
const ENROLL_URL = `${AUTH_ORIGIN}/api/v1/console/enrollments`;
const PUBLIC_ORIGIN = 'https://signkit.example.workers.dev';
const CONSOLE_ORIGIN = 'https://console.example.com';
const STATE_PATH = '/xdg/state/create-signkit/state.json';
const RECOVERY_PATH = resolveRecoveryPath(STATE_PATH);
const RECORD_PATH = resolveEnrollmentRecordPath(RECOVERY_PATH);

const BASE_ARGV = [
	'--cloudflare',
	'deploy',
	'--account-id',
	ACCOUNT_ID,
	'--email-from',
	'sign@example.com',
	'--public-origin',
	PUBLIC_ORIGIN,
	'--d6e-auth-base-url',
	AUTH_ORIGIN
];

function enrollmentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		server: {
			id: SERVER_ID,
			name: 'signkit.example.workers.dev',
			kind: 'signkit',
			origin: PUBLIC_ORIGIN
		},
		clientId: CLIENT_ID,
		clientSecret: CLIENT_SECRET,
		bootstrapOwnerEmail: 'Console.Owner@Example.com',
		d6eAuthBaseUrl: AUTH_ORIGIN,
		consoleOrigins: [CONSOLE_ORIGIN],
		...overrides
	};
}

/** Records how many Cloudflare calls had happened when D6E Auth was called. */
class OrderedHttp extends FakeHttp {
	callsAtEnrollment: number | undefined;
	constructor(private readonly cloudflare: FakeCloudflareClient) {
		super();
	}
	override async request(request: HttpRequest): Promise<HttpResponse> {
		if (request.url === ENROLL_URL) {
			this.callsAtEnrollment = this.cloudflare.calls.filter((call) =>
				/^(create|export|apply|deploy|upload)/.test(call)
			).length;
		}
		return super.request(request);
	}
}

interface RunOptions {
	argv?: string[];
	extraArgv?: string[];
	env?: NodeJS.ProcessEnv;
	fs?: MemoryFileSystem;
	cloudflare?: FakeCloudflareClient;
	http?: OrderedHttp;
	stdinText?: string;
	json?: boolean;
}

async function runEnrolled(options: RunOptions = {}) {
	const cloudflare = options.cloudflare ?? new FakeCloudflareClient();
	const fs = options.fs ?? new MemoryFileSystem();
	const http = options.http ?? new OrderedHttp(cloudflare);
	http.on(`${PUBLIC_ORIGIN}/api/v1/system/capabilities`, { name: 'signkit', apiVersion: '1' });
	cloudflare.fs = fs;
	const stdout: string[] = [];
	const stderr: string[] = [];
	const stdinReads: number[] = [];
	const argv = [
		...(options.argv ?? BASE_ARGV),
		...(options.extraArgv ?? []),
		'--yes',
		...(options.json === false ? [] : ['--json'])
	];
	const code = await runCreateSignkit({
		argv,
		stdout: { write: (chunk) => stdout.push(chunk) },
		stderr: { write: (chunk) => stderr.push(chunk) },
		env: { XDG_STATE_HOME: '/xdg/state', D6E_ENROLLMENT_TOKEN: TOKEN, ...options.env },
		runtime: {
			fs,
			cloudflare,
			releases: fakeReleases(),
			extractor: fakeExtractor(fs),
			http,
			now: () => new Date('2026-11-20T00:00:00.000Z'),
			smokeBackoffMs: 0,
			sleep: async () => undefined,
			readStdin: async (): Promise<Uint8Array> => {
				stdinReads.push(1);
				if (options.stdinText === undefined) {
					throw new Error('stdin must not be read in this test');
				}
				return new TextEncoder().encode(options.stdinText);
			}
		}
	});
	const out = stdout.join('');
	return {
		code,
		stdout: out,
		stderr: stderr.join(''),
		json: options.json === false ? undefined : (JSON.parse(out) as Record<string, unknown>),
		fs,
		cloudflare,
		http,
		stdinReads: stdinReads.length,
		enrollmentRequests: http.requests.filter((request) => request.url === ENROLL_URL)
	};
}

function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

function expectNoSecretsIn(text: string): void {
	expect(text).not.toContain(TOKEN);
	expect(text).not.toContain(CLIENT_SECRET);
	expect(text).not.toContain(CLIENT_ID);
}

function expectNoCloudflareMutation(cloudflare: FakeCloudflareClient): void {
	expect(
		cloudflare.calls.filter((call) => /^(create|export|apply|deploy|upload)/.test(call))
	).toEqual([]);
}

describe('console enrollment on a pristine initial deploy', () => {
	it('exchanges the env token for the OAuth pair, retains it, and applies the enrollment defaults', async () => {
		const cloudflare = new FakeCloudflareClient();
		const http = new OrderedHttp(cloudflare);
		http.on(ENROLL_URL, enrollmentBody(), 201);
		const result = await runEnrolled({ http, cloudflare });

		expect(result.code).toBe(0);
		expect(result.stdinReads).toBe(0);
		expect(result.enrollmentRequests).toHaveLength(1);
		const request = result.enrollmentRequests[0]!;
		expect(request.method).toBe('POST');
		expect(request.headers?.authorization).toBe(`Bearer ${TOKEN}`);
		expect(request.headers?.['content-type']).toBe('application/json');
		expect(request.followRedirects).toBe(false);
		expect([...request.allowedHosts]).toEqual(['auth.example.com']);
		expect(JSON.parse(request.body ?? '{}')).toEqual({
			kind: 'signkit',
			publicOrigin: PUBLIC_ORIGIN,
			name: 'signkit.example.workers.dev'
		});
		// Enrollment ran after every check and before any Cloudflare mutation.
		expect(http.callsAtEnrollment).toBe(0);

		const recovery = JSON.parse(await result.fs.readFile(RECOVERY_PATH)) as Record<string, string>;
		expect(recovery.D6E_AUTH_CLIENT_ID).toBe(CLIENT_ID);
		expect(recovery.D6E_AUTH_CLIENT_SECRET).toBe(CLIENT_SECRET);
		expect(JSON.parse(result.cloudflare.stagedSecrets[0] ?? '{}')).toEqual(recovery);

		const record = JSON.parse(await result.fs.readFile(RECORD_PATH)) as Record<string, unknown>;
		expect(record).toEqual({
			schemaVersion: 1,
			kind: 'signkit',
			serverId: SERVER_ID,
			publicOrigin: PUBLIC_ORIGIN,
			d6eAuthBaseUrl: AUTH_ORIGIN,
			bootstrapOwnerEmail: 'console.owner@example.com',
			consoleOrigins: [CONSOLE_ORIGIN]
		});
		expect((await result.fs.stat(RECORD_PATH)).mode & 0o777).toBe(0o600);
		expect(JSON.stringify(record)).not.toContain(CLIENT_SECRET);

		const config = JSON.parse(result.cloudflare.lastConfig ?? '{}') as {
			vars: Record<string, string>;
		};
		expect(config.vars).toMatchObject({
			D6E_AUTH_BASE_URL: AUTH_ORIGIN,
			SIGNKIT_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
			SIGNKIT_BOOTSTRAP_OWNER_EMAIL: 'console.owner@example.com',
			SIGNKIT_CONSOLE_ORIGINS: CONSOLE_ORIGIN
		});

		const state = JSON.parse(await result.fs.readFile(STATE_PATH)) as Record<string, unknown>;
		expect(state.bootstrapOwnerEmail).toBe('console.owner@example.com');
		expect(state.consoleOrigins).toEqual([CONSOLE_ORIGIN]);
		expect(state.d6eAuthBaseUrl).toBe(AUTH_ORIGIN);

		const json = result.json!;
		expect((json.mutations as string[]).slice(0, 2)).toEqual(['enrollment', 'recovery']);
		expect(json.enrollment).toEqual({
			status: 'enrolled',
			serverId: SERVER_ID,
			recordPath: RECORD_PATH
		});
		expectNoSecretsIn(result.stdout + result.stderr + JSON.stringify(state));
		expect(result.stdout).not.toContain('console.owner@example.com');
	});

	it('prints a human enrollment line without secrets or the owner address', async () => {
		const cloudflare = new FakeCloudflareClient();
		const http = new OrderedHttp(cloudflare);
		http.on(ENROLL_URL, enrollmentBody(), 201);
		const result = await runEnrolled({ http, cloudflare, json: false });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			`Console enrollment: registered server ${SERVER_ID} with D6E Auth (record: ${RECORD_PATH})`
		);
		expectNoSecretsIn(result.stdout + result.stderr);
		expect(result.stdout).not.toContain('console.owner@example.com');
	});

	it('lets explicit --bootstrap-owner-email, --console-origins, and --server-name win', async () => {
		const cloudflare = new FakeCloudflareClient();
		const http = new OrderedHttp(cloudflare);
		http.on(ENROLL_URL, enrollmentBody(), 201);
		const result = await runEnrolled({
			http,
			cloudflare,
			extraArgv: [
				'--bootstrap-owner-email',
				'Operator@Example.com',
				'--console-origins',
				'',
				'--server-name',
				'  Legal SignKit  '
			]
		});
		expect(result.code).toBe(0);
		expect(JSON.parse(result.enrollmentRequests[0]?.body ?? '{}').name).toBe('Legal SignKit');
		const config = JSON.parse(result.cloudflare.lastConfig ?? '{}') as {
			vars: Record<string, string>;
		};
		expect(config.vars.SIGNKIT_BOOTSTRAP_OWNER_EMAIL).toBe('operator@example.com');
		expect(config.vars.SIGNKIT_CONSOLE_ORIGINS).toBe('');
		const state = JSON.parse(await result.fs.readFile(STATE_PATH)) as Record<string, unknown>;
		expect(state.consoleOrigins).toEqual([]);
	});

	it('reads only the SMTP password from stdin when authenticated SMTP is configured', async () => {
		const cloudflare = new FakeCloudflareClient();
		const http = new OrderedHttp(cloudflare);
		http.on(ENROLL_URL, enrollmentBody(), 201);
		const result = await runEnrolled({
			http,
			cloudflare,
			extraArgv: [
				'--mail-provider',
				'smtp',
				'--smtp-host',
				'smtp.example.com',
				'--smtp-port',
				'587',
				'--smtp-secure',
				'false',
				'--smtp-username',
				'relay'
			],
			stdinText: JSON.stringify({ SIGNKIT_SMTP_PASSWORD: 'smtp-password-never-print' })
		});
		expect(result.code).toBe(0);
		expect(result.stdinReads).toBe(1);
		expect(JSON.parse(result.cloudflare.stagedSecrets[0] ?? '{}')).toMatchObject({
			D6E_AUTH_CLIENT_ID: CLIENT_ID,
			D6E_AUTH_CLIENT_SECRET: CLIENT_SECRET,
			SIGNKIT_SMTP_PASSWORD: 'smtp-password-never-print'
		});
		expect(result.stdout).not.toContain('smtp-password-never-print');
	});

	it('refuses OAuth keys in SMTP stdin before using the token', async () => {
		const cloudflare = new FakeCloudflareClient();
		const http = new OrderedHttp(cloudflare);
		http.on(ENROLL_URL, enrollmentBody(), 201);
		const result = await runEnrolled({
			http,
			cloudflare,
			extraArgv: [
				'--mail-provider',
				'smtp',
				'--smtp-host',
				'smtp.example.com',
				'--smtp-port',
				'587',
				'--smtp-secure',
				'false',
				'--smtp-username',
				'relay'
			],
			stdinText: JSON.stringify({
				D6E_AUTH_CLIENT_ID: 'x',
				D6E_AUTH_CLIENT_SECRET: 'y',
				SIGNKIT_SMTP_PASSWORD: 'z'
			})
		});
		expect(result.code).toBe(6);
		expect(result.json?.message).toMatch(/exactly SIGNKIT_SMTP_PASSWORD/);
		expect(result.json?.message).toMatch(/D6E_ENROLLMENT_TOKEN was not used/);
		expect(result.enrollmentRequests).toHaveLength(0);
		expect(await result.fs.exists(RECOVERY_PATH)).toBe(false);
	});
});

describe('console enrollment failures', () => {
	it.each([
		[
			401,
			{ error: 'invalid_token' },
			6,
			'enrollment_invalid_token',
			/invalid, expired, or already used/
		],
		[
			409,
			{ error: 'conflict' },
			4,
			'enrollment_conflict',
			/already registered for https:\/\/signkit\.example\.workers\.dev/
		],
		[
			400,
			{ error: 'invalid_request' },
			6,
			'enrollment_invalid_request',
			/invalid \(invalid_request\)/
		],
		[503, 'down', 5, 'enrollment_unavailable', /may or may not have consumed the token/],
		[302, '', 1, 'enrollment_redirect', /refusing to follow it/]
	] as const)(
		'maps HTTP %i to a clear error without touching Cloudflare or saving anything',
		async (status, body, exitCode, code, message) => {
			const cloudflare = new FakeCloudflareClient();
			const http = new OrderedHttp(cloudflare);
			http.on(
				ENROLL_URL,
				body,
				status,
				status === 302 ? { location: 'https://evil.example/' } : {}
			);
			const result = await runEnrolled({ http, cloudflare });

			expect(result.code).toBe(exitCode);
			expect(result.json).toMatchObject({ ok: false, code });
			expect(String(result.json?.message)).toMatch(message);
			expect(result.enrollmentRequests).toHaveLength(1);
			expect(http.requests.some((request) => request.url.startsWith('https://evil.example'))).toBe(
				false
			);
			expectNoCloudflareMutation(cloudflare);
			expect(await result.fs.exists(RECOVERY_PATH)).toBe(false);
			expect(await result.fs.exists(RECORD_PATH)).toBe(false);
			expect(await result.fs.exists(STATE_PATH)).toBe(false);
			expectNoSecretsIn(result.stdout + result.stderr);
		}
	);

	it('reports a network failure as unavailable and redacts the token from the cause', async () => {
		const cloudflare = new FakeCloudflareClient();
		const http = new OrderedHttp(cloudflare);
		http.fail(ENROLL_URL, new Error(`fetch failed: socket hang up (${TOKEN})`));
		const result = await runEnrolled({ http, cloudflare });

		expect(result.code).toBe(5);
		expect(result.json).toMatchObject({ ok: false, code: 'enrollment_unavailable' });
		expect(String(result.json?.message)).toMatch(/socket hang up \(\[redacted\]\)/);
		expect(String(result.json?.message)).toMatch(/remove that server in the SignKit console/);
		expectNoCloudflareMutation(cloudflare);
		expect(await result.fs.exists(RECOVERY_PATH)).toBe(false);
		expectNoSecretsIn(result.stdout + result.stderr);
	});

	it.each([
		['a missing client secret', { clientSecret: undefined }],
		['a mismatched D6E Auth origin', { d6eAuthBaseUrl: 'https://other.example.com' }],
		[
			'a different server origin',
			{ server: { id: SERVER_ID, kind: 'signkit', origin: 'https://x.example.com' } }
		],
		['a non-https console origin', { consoleOrigins: ['http://console.example.com'] }],
		['a console origin with a path', { consoleOrigins: ['https://console.example.com/app'] }],
		['a malformed owner email', { bootstrapOwnerEmail: 'not-an-email' }]
	])('rejects a 201 with %s and saves nothing', async (_name, overrides) => {
		const cloudflare = new FakeCloudflareClient();
		const http = new OrderedHttp(cloudflare);
		http.on(ENROLL_URL, enrollmentBody(overrides), 201);
		const result = await runEnrolled({ http, cloudflare });

		expect(result.code).toBe(1);
		expect(result.json).toMatchObject({ ok: false, code: 'enrollment_invalid_response' });
		expect(String(result.json?.message)).toContain(SERVER_ID);
		expectNoCloudflareMutation(cloudflare);
		expect(await result.fs.exists(RECOVERY_PATH)).toBe(false);
		expect(await result.fs.exists(RECORD_PATH)).toBe(false);
		expectNoSecretsIn(result.stdout + result.stderr);
	});

	it('does not send the token when a pre-enrollment check fails', async () => {
		const cloudflare = new FakeCloudflareClient();
		const http = new OrderedHttp(cloudflare);
		http.on(ENROLL_URL, enrollmentBody(), 201);
		const result = await runEnrolled({
			http,
			cloudflare,
			argv: BASE_ARGV.filter((arg) => arg !== '--email-from' && arg !== 'sign@example.com')
		});
		expect(result.code).toBe(6);
		expect(String(result.json?.message)).toMatch(/--email-from is required/);
		expect(result.enrollmentRequests).toHaveLength(0);
	});

	it('does not send the token when the D1 id cannot be created', async () => {
		const cloudflare = new FakeCloudflareClient();
		const http = new OrderedHttp(cloudflare);
		http.on(ENROLL_URL, enrollmentBody(), 201);
		const result = await runEnrolled({
			http,
			cloudflare,
			extraArgv: ['--d1', '44444444-4444-4444-4444-444444444444']
		});
		expect(result.code).toBe(4);
		expect(String(result.json?.message)).toMatch(/was not found/);
		expect(result.enrollmentRequests).toHaveLength(0);
		expect(await result.fs.exists(RECOVERY_PATH)).toBe(false);
	});
});

describe('console enrollment retries', () => {
	it('reuses the retained pair and record without a second enrollment call', async () => {
		const cloudflare = new FakeCloudflareClient();
		cloudflare.failFirstDeploy = true;
		const fs = new MemoryFileSystem();
		const firstHttp = new OrderedHttp(cloudflare);
		firstHttp.on(ENROLL_URL, enrollmentBody(), 201);
		const first = await runEnrolled({ http: firstHttp, cloudflare, fs });
		expect(first.code).toBe(1);
		expect(first.enrollmentRequests).toHaveLength(1);
		expect(await fs.exists(STATE_PATH)).toBe(false);
		const recoveryText: string = await fs.readFile(RECOVERY_PATH);

		// Retry with the (now used) token still exported: the retained pair is
		// reused and D6E Auth is not called again.
		const stillFailing = await runEnrolled({ http: new OrderedHttp(cloudflare), cloudflare, fs });
		expect(stillFailing.code).toBe(1);
		expect(stillFailing.enrollmentRequests).toHaveLength(0);
		expect(await fs.readFile(RECOVERY_PATH)).toBe(recoveryText);

		// Retry without the token succeeds from the retained record alone.
		cloudflare.failFirstDeploy = false;
		const retry = await runEnrolled({
			http: new OrderedHttp(cloudflare),
			cloudflare,
			fs,
			env: { D6E_ENROLLMENT_TOKEN: '' }
		});
		expect(retry.code).toBe(0);
		expect(retry.enrollmentRequests).toHaveLength(0);
		expect(retry.json?.recoveryFingerprint).toBe(sha256Hex(recoveryText));
		expect(retry.json?.enrollment).toEqual({
			status: 'reused',
			serverId: SERVER_ID,
			recordPath: RECORD_PATH
		});
		expect(retry.json?.mutations).not.toContain('enrollment');
		expect(retry.json?.mutations).not.toContain('recovery');
		const config = JSON.parse(cloudflare.lastConfig ?? '{}') as { vars: Record<string, string> };
		expect(config.vars.SIGNKIT_BOOTSTRAP_OWNER_EMAIL).toBe('console.owner@example.com');
		expect(config.vars.SIGNKIT_CONSOLE_ORIGINS).toBe(CONSOLE_ORIGIN);
		expect(cloudflare.stagedSecrets).toHaveLength(3);
		for (const staged of cloudflare.stagedSecrets) {
			expect(JSON.parse(staged)).toMatchObject({
				D6E_AUTH_CLIENT_ID: CLIENT_ID,
				D6E_AUTH_CLIENT_SECRET: CLIENT_SECRET
			});
		}
		const state = JSON.parse(await fs.readFile(STATE_PATH)) as Record<string, unknown>;
		expect(state.bootstrapOwnerEmail).toBe('console.owner@example.com');
		expect(state.consoleOrigins).toEqual([CONSOLE_ORIGIN]);
		expectNoSecretsIn(first.stdout + stillFailing.stdout + retry.stdout + retry.stderr);
	});

	it('refuses a retry whose public origin differs from the retained enrollment', async () => {
		const cloudflare = new FakeCloudflareClient();
		cloudflare.failFirstDeploy = true;
		const fs = new MemoryFileSystem();
		const http = new OrderedHttp(cloudflare);
		http.on(ENROLL_URL, enrollmentBody(), 201);
		expect((await runEnrolled({ http, cloudflare, fs })).code).toBe(1);

		const retry = await runEnrolled({
			cloudflare,
			fs,
			argv: BASE_ARGV.map((arg) => (arg === PUBLIC_ORIGIN ? 'https://other.example.com' : arg))
		});
		expect(retry.code).toBe(6);
		expect(String(retry.json?.message)).toMatch(
			/only accepts https:\/\/signkit\.example\.workers\.dev\/auth\/callback/
		);
		expect(retry.enrollmentRequests).toHaveLength(0);
	});

	it('refuses a token when stdin-created recovery material already exists', async () => {
		const fs = new MemoryFileSystem();
		await ensureRecoveryBinding({
			fs,
			recoveryPath: RECOVERY_PATH,
			accountId: ACCOUNT_ID,
			workerName: 'signkit',
			allowCreate: true
		});
		await ensureRecoverySecrets({
			fs,
			recoveryPath: RECOVERY_PATH,
			requiredSecrets: [
				'DELIVERY_ENCRYPTION_KEY',
				'SESSION_ENCRYPTION_KEY',
				'DELIVERY_WORKER_SECRET',
				'D6E_AUTH_CLIENT_ID',
				'D6E_AUTH_CLIENT_SECRET'
			],
			oauth: { D6E_AUTH_CLIENT_ID: 'stdin-id', D6E_AUTH_CLIENT_SECRET: 'stdin-secret' }
		});
		expect(await fs.exists(resolveRecoveryBindingPath(RECOVERY_PATH))).toBe(true);
		const result = await runEnrolled({ fs });
		expect(result.code).toBe(6);
		expect(String(result.json?.message)).toMatch(/without an enrollment record/);
		expect(String(result.json?.message)).toMatch(/The token was not used/);
		expect(result.enrollmentRequests).toHaveLength(0);
	});

	it('refuses a token on an existing deployment instead of ignoring it', async () => {
		const cloudflare = new FakeCloudflareClient();
		cloudflare.seedReadyWorker();
		const fs = await writeCloudflareState(new MemoryFileSystem());
		const result = await runEnrolled({
			cloudflare,
			fs,
			argv: ['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID]
		});
		expect(result.code).toBe(6);
		expect(String(result.json?.message)).toMatch(/only runs on a pristine initial deploy/);
		expect(result.enrollmentRequests).toHaveLength(0);
		expectNoCloudflareMutation(cloudflare);
	});
});

describe('console enrollment in plan and argv', () => {
	it('plans the enrollment step without calling D6E Auth or writing files', async () => {
		const cloudflare = new FakeCloudflareClient();
		const fs = new MemoryFileSystem();
		const http = new OrderedHttp(cloudflare);
		const stdout: string[] = [];
		const code = await runCreateSignkit({
			argv: [
				'--cloudflare',
				'plan',
				'--account-id',
				ACCOUNT_ID,
				'--public-origin',
				PUBLIC_ORIGIN,
				'--json'
			],
			stdout: { write: (chunk) => stdout.push(chunk) },
			stderr: { write: () => undefined },
			env: { XDG_STATE_HOME: '/xdg/state', D6E_ENROLLMENT_TOKEN: TOKEN },
			runtime: { fs, cloudflare, http, releases: fakeReleases(), extractor: fakeExtractor(fs) }
		});
		expect(code).toBe(0);
		const json = JSON.parse(stdout.join('')) as {
			plan: Array<{ id: string; mutating: boolean }>;
			bootstrapWarning: string;
		};
		expect(json.plan.find((step) => step.id === 'console-enrollment')).toMatchObject({
			mutating: true
		});
		expect(json.bootstrapWarning).toMatch(/issued the console enrollment token/);
		expect(http.requests).toHaveLength(0);
		expect(fs.writes).toEqual([]);
		expect(stdout.join('')).not.toContain(TOKEN);
	});

	it('refuses a malformed token without echoing it', async () => {
		const result = await runEnrolled({ env: { D6E_ENROLLMENT_TOKEN: 'd6ee_short-secret-value' } });
		expect(result.code).toBe(2);
		expect(String(result.json?.message)).toMatch(/is not a console enrollment token/);
		expect(result.stdout).not.toContain('short-secret-value');
		expect(result.enrollmentRequests).toHaveLength(0);
	});

	it('never accepts the token on argv', () => {
		for (const flag of ['--d6e-enrollment-token', '--enrollment-token', '--token']) {
			expect(() =>
				parseArgv(['--cloudflare', 'deploy', '--account-id', ACCOUNT_ID, flag, TOKEN])
			).toThrow(/never accepted on argv/);
		}
	});

	it('requires the token for --server-name', async () => {
		const result = await runEnrolled({
			env: { D6E_ENROLLMENT_TOKEN: undefined },
			extraArgv: ['--server-name', 'Legal'],
			stdinText: '{}'
		});
		expect(result.code).toBe(2);
		expect(String(result.json?.message)).toMatch(
			/--server-name is only sent with console enrollment/
		);
	});

	it('accepts only the issued token shape', () => {
		expect(ENROLLMENT_TOKEN_PATTERN.test(TOKEN)).toBe(true);
		expect(resolveEnrollmentToken({ D6E_ENROLLMENT_TOKEN: ` ${TOKEN}\n` })).toBe(TOKEN);
		expect(resolveEnrollmentToken({})).toBeUndefined();
		expect(resolveEnrollmentToken({ D6E_ENROLLMENT_TOKEN: '' })).toBeUndefined();
		for (const bad of [
			`d6ee_${'a'.repeat(42)}`,
			`d6ee_${'a'.repeat(44)}`,
			`d6ex_${'a'.repeat(43)}`
		]) {
			expect(() => resolveEnrollmentToken({ D6E_ENROLLMENT_TOKEN: bad })).toThrow(
				/not a console enrollment token/
			);
		}
	});
});

describe('--console-origins', () => {
	function parsed(value: string): ParsedCommand {
		const result = parseArgv([
			'--cloudflare',
			'plan',
			'--account-id',
			ACCOUNT_ID,
			'--console-origins',
			value
		]);
		if (result.kind !== 'command') throw new Error('expected a command');
		return result;
	}

	it('canonicalizes, de-duplicates, and allows http only for loopback', () => {
		expect(
			parsed('https://Console.Example.com/, https://console.example.com,http://localhost:5173')
				.consoleOrigins
		).toEqual(['https://console.example.com', 'http://localhost:5173']);
		expect(parsed('').consoleOrigins).toEqual([]);
		expect(parsed('').overrides.consoleOrigins).toBe(true);
	});

	it.each([
		'http://console.example.com',
		'https://console.example.com/path',
		'https://console.example.com?x=1',
		'https://user@console.example.com',
		'https://a.example.com,,https://b.example.com',
		'console.example.com',
		'https://*.example.com'
	])('rejects %s', (value) => {
		expect(() => parsed(value)).toThrow(/--console-origins/);
	});

	it('applies an explicit list on upgrade and records it in state', async () => {
		const cloudflare = new FakeCloudflareClient();
		cloudflare.seedReadyWorker();
		const fs = await writeCloudflareState(new MemoryFileSystem());
		const result = await runEnrolled({
			cloudflare,
			fs,
			env: { D6E_ENROLLMENT_TOKEN: undefined },
			argv: [
				'--cloudflare',
				'upgrade',
				'--account-id',
				ACCOUNT_ID,
				'--console-origins',
				CONSOLE_ORIGIN
			]
		});
		expect(result.code).toBe(0);
		const config = JSON.parse(cloudflare.lastConfig ?? '{}') as { vars: Record<string, string> };
		expect(config.vars.SIGNKIT_CONSOLE_ORIGINS).toBe(CONSOLE_ORIGIN);
		const state = JSON.parse(await fs.readFile(STATE_PATH)) as Record<string, unknown>;
		expect(state.consoleOrigins).toEqual([CONSOLE_ORIGIN]);
	});

	it('leaves the remote var alone when neither the flag nor state names it', async () => {
		const cloudflare = new FakeCloudflareClient();
		cloudflare.seedReadyWorker();
		const fs = await writeCloudflareState(new MemoryFileSystem());
		const result = await runEnrolled({
			cloudflare,
			fs,
			env: { D6E_ENROLLMENT_TOKEN: undefined },
			argv: ['--cloudflare', 'upgrade', '--account-id', ACCOUNT_ID]
		});
		expect(result.code).toBe(0);
		const config = JSON.parse(cloudflare.lastConfig ?? '{}') as { vars: Record<string, string> };
		expect(config.vars).not.toHaveProperty('SIGNKIT_CONSOLE_ORIGINS');
	});
});

describe('bounded POST transport', () => {
	it('sends the body and returns a redirect unfollowed when followRedirects is false', async () => {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
			seen.push({ url: String(url), init: init ?? {} });
			return new Response('', { status: 307, headers: { location: 'https://elsewhere.example/' } });
		}) as typeof fetch;
		const response = await boundedFetch(fetchImpl, {
			url: ENROLL_URL,
			method: 'POST',
			headers: { authorization: `Bearer ${TOKEN}` },
			body: '{"kind":"signkit"}',
			maxBytes: 1024,
			allowedHosts: new Set(['auth.example.com']),
			followRedirects: false
		});
		expect(response.status).toBe(307);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.init.method).toBe('POST');
		expect(seen[0]?.init.body).toBe('{"kind":"signkit"}');
	});
});
