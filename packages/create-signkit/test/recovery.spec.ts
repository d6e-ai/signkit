import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	MAX_RECOVERY_FILE_BYTES,
	MAX_STDIN_BYTES,
	RECOVERY_SECRET_NAMES,
	assertRecoveryPlatform,
	canonicalSecretJson,
	ensureRecoverySecrets,
	parseOAuthStdinBytes,
	readOAuthSecrets,
	resolveRecoveryPath,
	stageRecoverySecrets,
	type RecoverySecretMap
} from '../src/recovery/bootstrap.js';
import { MemoryFileSystem } from './helpers.js';

const RECOVERY_PATH = '/home/operator/.config/create-signkit/recovery.json';
const PARENT_DIR = dirname(RECOVERY_PATH);
const REQUIRED_SECRETS: readonly string[] = [...RECOVERY_SECRET_NAMES];
const OAUTH = {
	D6E_AUTH_CLIENT_ID: 'test-client-id-abc',
	D6E_AUTH_CLIENT_SECRET: 'test-client-secret-xyz'
};

function makeCounterRandom(): {
	randomBytes: (size: number) => Uint8Array;
	sizes: number[];
} {
	const sizes: number[] = [];
	let calls = 0;
	const randomBytes = (size: number): Uint8Array => {
		sizes.push(size);
		calls += 1;
		return new Uint8Array(32).fill(calls);
	};
	return { randomBytes, sizes };
}

function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

function decodeBase64Length(value: string): number {
	return Buffer.from(value, 'base64').byteLength;
}

async function seedValidRecovery(
	fs: MemoryFileSystem,
	oauth: Record<string, string> = OAUTH
): Promise<{ text: string; fingerprint: string }> {
	const { randomBytes } = makeCounterRandom();
	const created = await ensureRecoverySecrets({
		fs,
		recoveryPath: RECOVERY_PATH,
		requiredSecrets: REQUIRED_SECRETS,
		oauth,
		randomBytes
	});
	expect(created.created).toBe(true);
	const text: string = await fs.readFile(RECOVERY_PATH);
	return { text, fingerprint: created.fingerprint };
}

describe('recovery secrets bootstrap (slice 1)', () => {
	it('generates 32-byte standard padded base64 secrets with independent values', async () => {
		const fs = new MemoryFileSystem();
		const { randomBytes, sizes } = makeCounterRandom();
		const result = await ensureRecoverySecrets({
			fs,
			recoveryPath: RECOVERY_PATH,
			requiredSecrets: REQUIRED_SECRETS,
			oauth: { ...OAUTH },
			randomBytes
		});
		expect(sizes).toEqual([32, 32, 32]);
		const text: string = await fs.readFile(RECOVERY_PATH);
		const parsed = JSON.parse(text) as RecoverySecretMap;
		for (const name of [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET'
		] as const) {
			expect(parsed[name]).toHaveLength(44);
			expect(parsed[name].endsWith('=')).toBe(true);
			expect(/^[A-Za-z0-9+/]{43}=$/.test(parsed[name])).toBe(true);
			expect(decodeBase64Length(parsed[name])).toBe(32);
		}
		expect(parsed.DELIVERY_ENCRYPTION_KEY).not.toBe(parsed.SESSION_ENCRYPTION_KEY);
		expect(parsed.DELIVERY_ENCRYPTION_KEY).not.toBe(parsed.DELIVERY_WORKER_SECRET);
		expect(parsed.SESSION_ENCRYPTION_KEY).not.toBe(parsed.DELIVERY_WORKER_SECRET);
		expect(parsed.D6E_AUTH_CLIENT_ID).toBe(OAUTH.D6E_AUTH_CLIENT_ID);
		expect(parsed.D6E_AUTH_CLIENT_SECRET).toBe(OAUTH.D6E_AUTH_CLIENT_SECRET);
		expect(result.path).toBe(RECOVERY_PATH);
		expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
	});

	it('produces Wrangler-compatible flat JSON with exactly the required keys', async () => {
		const fs = new MemoryFileSystem();
		await ensureRecoverySecrets({
			fs,
			recoveryPath: RECOVERY_PATH,
			requiredSecrets: REQUIRED_SECRETS,
			oauth: { ...OAUTH },
			randomBytes: makeCounterRandom().randomBytes
		});
		const text: string = await fs.readFile(RECOVERY_PATH);
		const parsed: unknown = JSON.parse(text);
		expect(typeof parsed).toBe('object');
		const keys: string[] = Object.keys(parsed as Record<string, unknown>).sort();
		expect(keys).toEqual([...RECOVERY_SECRET_NAMES].sort());
		for (const value of Object.values(parsed as Record<string, unknown>)) {
			expect(typeof value).toBe('string');
		}
		expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_RECOVERY_FILE_BYTES);
	});

	it('requires OAuth input and never generates client id/secret', async () => {
		for (const badOauth of [undefined, null, {}, 'secret', []] as unknown[]) {
			const fs = new MemoryFileSystem();
			await expect(
				ensureRecoverySecrets({
					fs,
					recoveryPath: RECOVERY_PATH,
					requiredSecrets: REQUIRED_SECRETS,
					oauth: badOauth,
					randomBytes: makeCounterRandom().randomBytes
				})
			).rejects.toThrow();
			expect(await fs.exists(RECOVERY_PATH)).toBe(false);
		}
	});

	it('rejects OAuth inputs with inexact keys or out-of-bounds values', async () => {
		const cases: unknown[] = [
			{ D6E_AUTH_CLIENT_ID: 'id' },
			{ D6E_AUTH_CLIENT_SECRET: 'secret' },
			{ D6E_AUTH_CLIENT_ID: 'id', D6E_AUTH_CLIENT_SECRET: 's', EXTRA: 'x' },
			{ D6E_AUTH_CLIENT_ID: '', D6E_AUTH_CLIENT_SECRET: 's' },
			{ D6E_AUTH_CLIENT_ID: 'id', D6E_AUTH_CLIENT_SECRET: '' },
			{ D6E_AUTH_CLIENT_ID: 'x'.repeat(1025), D6E_AUTH_CLIENT_SECRET: 's' },
			{ D6E_AUTH_CLIENT_ID: 'id', D6E_AUTH_CLIENT_SECRET: 'y'.repeat(1025) },
			{ D6E_AUTH_CLIENT_ID: 42, D6E_AUTH_CLIENT_SECRET: 's' },
			{ D6E_AUTH_CLIENT_ID: 'id', D6E_AUTH_CLIENT_SECRET: null },
			{ D6E_AUTH_CLIENT_ID: 'a\u0000b', D6E_AUTH_CLIENT_SECRET: 's' }
		];
		for (const oauth of cases) {
			const fs = new MemoryFileSystem();
			await expect(
				ensureRecoverySecrets({
					fs,
					recoveryPath: RECOVERY_PATH,
					requiredSecrets: REQUIRED_SECRETS,
					oauth,
					randomBytes: makeCounterRandom().randomBytes
				})
			).rejects.toThrow();
			expect(await fs.exists(RECOVERY_PATH)).toBe(false);
		}
	});

	it('fails closed on unknown, missing, or extra manifest secret names', async () => {
		const variants: readonly string[][] = [
			[...REQUIRED_SECRETS, 'UNKNOWN_SECRET'],
			['DELIVERY_ENCRYPTION_KEY'],
			REQUIRED_SECRETS.filter((name) => name !== 'D6E_AUTH_CLIENT_SECRET'),
			[...REQUIRED_SECRETS.slice(1), 'SOMETHING_ELSE'],
			[]
		];
		for (const requiredSecrets of variants) {
			const fs = new MemoryFileSystem();
			const error = await ensureRecoverySecrets({
				fs,
				recoveryPath: RECOVERY_PATH,
				requiredSecrets,
				oauth: { ...OAUTH },
				randomBytes: makeCounterRandom().randomBytes
			}).catch((caught: unknown) => caught);
			expect(error instanceof Error).toBe(true);
			if (
				requiredSecrets.includes('UNKNOWN_SECRET') ||
				requiredSecrets.includes('SOMETHING_ELSE')
			) {
				expect((error as Error).message).toMatch(/unknown required secret names/);
			}
			expect(await fs.exists(RECOVERY_PATH)).toBe(false);
		}
	});

	it('creates the parent dir 0700 and the file 0600, then fsyncs both', async () => {
		const fs = new MemoryFileSystem();
		const result = await ensureRecoverySecrets({
			fs,
			recoveryPath: RECOVERY_PATH,
			requiredSecrets: REQUIRED_SECRETS,
			oauth: { ...OAUTH },
			randomBytes: makeCounterRandom().randomBytes
		});
		expect(result.created).toBe(true);
		expect(fs.mkdirCalls[0]).toEqual({ path: PARENT_DIR, mode: 0o700 });
		expect(fs.modes.get(PARENT_DIR)).toBe(0o700);
		expect(fs.chmodCalls).toContainEqual({ path: PARENT_DIR, mode: 0o700 });
		expect(fs.modes.get(RECOVERY_PATH)).toBe(0o600);
		expect(fs.exclusiveWrites).toEqual([{ path: RECOVERY_PATH, mode: 0o600 }]);
		expect(fs.fsyncCalls).toContain(RECOVERY_PATH);
		expect(fs.fsyncCalls).toContain(PARENT_DIR);
		const stat = await fs.stat(RECOVERY_PATH);
		expect(stat.isFile).toBe(true);
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it('never overwrites an existing file: exclusive creation races reuse it', async () => {
		const fs = new MemoryFileSystem();
		const first = await seedValidRecovery(fs);
		const writesBefore: number = fs.writes.length;
		const second = await ensureRecoverySecrets({
			fs,
			recoveryPath: RECOVERY_PATH,
			requiredSecrets: REQUIRED_SECRETS,
			oauth: { ...OAUTH },
			randomBytes: (): Uint8Array => {
				throw new Error('must not draw randomness when reusing');
			}
		});
		expect(second.created).toBe(false);
		expect(second.path).toBe(RECOVERY_PATH);
		expect(second.fingerprint).toBe(first.fingerprint);
		expect(await fs.readFile(RECOVERY_PATH)).toBe(first.text);
		expect(fs.writes).toHaveLength(writesBefore);
	});

	it('reuses an existing valid file exactly without extra randomness', async () => {
		const fs = new MemoryFileSystem();
		const seeded = await seedValidRecovery(fs);
		const parsed = JSON.parse(seeded.text) as RecoverySecretMap;
		const canonical: string = canonicalSecretJson(parsed);
		expect(seeded.text).toBe(canonical);
		expect(seeded.fingerprint).toBe(sha256Hex(canonical));
		let draws = 0;
		const reused = await ensureRecoverySecrets({
			fs,
			recoveryPath: RECOVERY_PATH,
			requiredSecrets: REQUIRED_SECRETS,
			oauth: { ...OAUTH },
			randomBytes: (size: number): Uint8Array => {
				draws += 1;
				return new Uint8Array(size).fill(9);
			}
		});
		expect(draws).toBe(0);
		expect(reused.created).toBe(false);
		expect(reused.fingerprint).toBe(seeded.fingerprint);
	});

	it('fails closed on invalid content and keeps the file', async () => {
		const fs = new MemoryFileSystem();
		await fs.mkdir(PARENT_DIR, { mode: 0o700 });
		await fs.chmod(PARENT_DIR, 0o700);
		await fs.writeFileExclusive(RECOVERY_PATH, '{not-json', 0o600);
		const before: string = await fs.readFile(RECOVERY_PATH);
		const writesBefore: number = fs.writes.length;
		await expect(
			ensureRecoverySecrets({
				fs,
				recoveryPath: RECOVERY_PATH,
				requiredSecrets: REQUIRED_SECRETS,
				oauth: { ...OAUTH },
				randomBytes: makeCounterRandom().randomBytes
			})
		).rejects.toThrow();
		expect(await fs.readFile(RECOVERY_PATH)).toBe(before);
		expect(fs.writes).toHaveLength(writesBefore);
	});

	it('fails closed on missing/extra keys and oversized files and keeps them', async () => {
		const valid = await (async (): Promise<string> => {
			const fs = new MemoryFileSystem();
			const seeded = await seedValidRecovery(fs);
			return seeded.text;
		})();
		const parsed = JSON.parse(valid) as Record<string, string>;
		const missing = { ...parsed };
		delete missing['SESSION_ENCRYPTION_KEY'];
		const extra = { ...parsed, EXTRA_KEY: 'x' };
		const badValues = { ...parsed, DELIVERY_ENCRYPTION_KEY: 'short' };
		for (const body of [
			JSON.stringify(missing),
			JSON.stringify(extra),
			JSON.stringify(badValues)
		]) {
			const fs = new MemoryFileSystem();
			await fs.mkdir(PARENT_DIR, { mode: 0o700 });
			await fs.chmod(PARENT_DIR, 0o700);
			await fs.writeFileExclusive(RECOVERY_PATH, body, 0o600);
			await expect(
				ensureRecoverySecrets({
					fs,
					recoveryPath: RECOVERY_PATH,
					requiredSecrets: REQUIRED_SECRETS,
					oauth: { ...OAUTH },
					randomBytes: makeCounterRandom().randomBytes
				})
			).rejects.toThrow();
			expect(await fs.readFile(RECOVERY_PATH)).toBe(body);
		}
		const oversized = 'x'.repeat(MAX_RECOVERY_FILE_BYTES + 1);
		const oversizedFs = new MemoryFileSystem();
		await oversizedFs.mkdir(PARENT_DIR, { mode: 0o700 });
		await oversizedFs.chmod(PARENT_DIR, 0o700);
		await oversizedFs.writeFileExclusive(RECOVERY_PATH, oversized, 0o600);
		await expect(
			ensureRecoverySecrets({
				fs: oversizedFs,
				recoveryPath: RECOVERY_PATH,
				requiredSecrets: REQUIRED_SECRETS,
				oauth: { ...OAUTH },
				randomBytes: makeCounterRandom().randomBytes
			})
		).rejects.toThrow(/size limit/);
		expect(await oversizedFs.readFile(RECOVERY_PATH)).toBe(oversized);
	});

	it.skipIf(process.platform === 'win32')(
		'fails closed on permission-unsafe files or directories and keeps them',
		async () => {
			const fs = new MemoryFileSystem();
			const seeded = await seedValidRecovery(fs);
			fs.modes.set(RECOVERY_PATH, 0o644);
			await expect(
				ensureRecoverySecrets({
					fs,
					recoveryPath: RECOVERY_PATH,
					requiredSecrets: REQUIRED_SECRETS,
					oauth: { ...OAUTH },
					randomBytes: makeCounterRandom().randomBytes
				})
			).rejects.toThrow(/unsafe permissions/);
			expect(await fs.readFile(RECOVERY_PATH)).toBe(seeded.text);
			const dirFs = new MemoryFileSystem();
			const dirSeeded = await seedValidRecovery(dirFs);
			dirFs.modes.set(PARENT_DIR, 0o755);
			const repaired = await ensureRecoverySecrets({
				fs: dirFs,
				recoveryPath: RECOVERY_PATH,
				requiredSecrets: REQUIRED_SECRETS,
				oauth: { ...OAUTH },
				randomBytes: makeCounterRandom().randomBytes
			});
			expect(repaired.created).toBe(false);
			expect(repaired.fingerprint).toBe(dirSeeded.fingerprint);
			expect(dirFs.modes.get(PARENT_DIR)).toBe(0o700);
			expect(await dirFs.readFile(RECOVERY_PATH)).toBe(dirSeeded.text);
		}
	);

	it('never exposes secret values in returned metadata or errors', async () => {
		const fs = new MemoryFileSystem();
		const oauth = {
			D6E_AUTH_CLIENT_ID: 'unique-client-id-value-918273',
			D6E_AUTH_CLIENT_SECRET: 'unique-client-secret-value-918273'
		};
		const result = await ensureRecoverySecrets({
			fs,
			recoveryPath: RECOVERY_PATH,
			requiredSecrets: REQUIRED_SECRETS,
			oauth,
			randomBytes: makeCounterRandom().randomBytes
		});
		const text: string = await fs.readFile(RECOVERY_PATH);
		const parsed = JSON.parse(text) as RecoverySecretMap;
		const metadata: string = JSON.stringify(result);
		expect(Object.keys(result).sort()).toEqual(['created', 'fingerprint', 'path']);
		for (const value of Object.values(parsed)) {
			expect(metadata.includes(value)).toBe(false);
		}
		expect(metadata.includes(oauth.D6E_AUTH_CLIENT_ID)).toBe(false);
		expect(metadata.includes(oauth.D6E_AUTH_CLIENT_SECRET)).toBe(false);
		const failing = await ensureRecoverySecrets({
			fs: new MemoryFileSystem(),
			recoveryPath: RECOVERY_PATH,
			requiredSecrets: [...REQUIRED_SECRETS, 'UNKNOWN_NAME'],
			oauth,
			randomBytes: makeCounterRandom().randomBytes
		}).catch((error: unknown) => error);
		expect(failing instanceof Error).toBe(true);
		const message: string = (failing as Error).message;
		expect(message.includes(oauth.D6E_AUTH_CLIENT_ID)).toBe(false);
		expect(message.includes(oauth.D6E_AUTH_CLIENT_SECRET)).toBe(false);
		expect(message.includes(parsed.DELIVERY_ENCRYPTION_KEY)).toBe(false);
	});

	it('resolves the deterministic recovery path beside the state file', async () => {
		expect(resolveRecoveryPath('/xdg/state/create-signkit/state.json')).toBe(
			'/xdg/state/create-signkit/recovery.json'
		);
		expect(resolveRecoveryPath('/custom/dir/state.json')).toBe('/custom/dir/recovery.json');
	});

	it('refuses Windows where owner and mode guarantees cannot be enforced', async () => {
		expect(() => assertRecoveryPlatform('win32')).toThrow(/unavailable on Windows/);
		expect(() => assertRecoveryPlatform('linux')).not.toThrow();
		expect(() => assertRecoveryPlatform('darwin')).not.toThrow();
	});

	it('refuses to stage a recovery map that changed after fingerprinting', async () => {
		const fs = new MemoryFileSystem();
		const seeded = await seedValidRecovery(fs);
		const changed = JSON.parse(seeded.text) as RecoverySecretMap;
		changed.D6E_AUTH_CLIENT_ID = 'different-client-id';
		await fs.writeFile(RECOVERY_PATH, canonicalSecretJson(changed));
		await expect(
			stageRecoverySecrets({
				fs,
				recoveryPath: RECOVERY_PATH,
				outputPath: '/tmp/staged-secrets.json',
				secretNames: REQUIRED_SECRETS,
				expectedFingerprint: seeded.fingerprint
			})
		).rejects.toThrow(/changed after validation/);
		expect(await fs.exists('/tmp/staged-secrets.json')).toBe(false);
	});

	it('generates valid secrets with the default CSPRNG (three 32-byte draws)', async () => {
		const fs = new MemoryFileSystem();
		const result = await ensureRecoverySecrets({
			fs,
			recoveryPath: RECOVERY_PATH,
			requiredSecrets: REQUIRED_SECRETS,
			oauth: { ...OAUTH }
		});
		expect(result.created).toBe(true);
		const parsed = JSON.parse(await fs.readFile(RECOVERY_PATH)) as RecoverySecretMap;
		for (const name of [
			'DELIVERY_ENCRYPTION_KEY',
			'SESSION_ENCRYPTION_KEY',
			'DELIVERY_WORKER_SECRET'
		] as const) {
			expect(parsed[name]).toHaveLength(44);
			expect(decodeBase64Length(parsed[name])).toBe(32);
		}
		expect(
			new Set([
				parsed.DELIVERY_ENCRYPTION_KEY,
				parsed.SESSION_ENCRYPTION_KEY,
				parsed.DELIVERY_WORKER_SECRET
			]).size
		).toBe(3);
	});

	it('refuses symlinks and non-regular files for the recovery directory and file', async () => {
		const fileSymlink = new MemoryFileSystem();
		await fileSymlink.mkdir(PARENT_DIR, { mode: 0o700 });
		await fileSymlink.chmod(PARENT_DIR, 0o700);
		fileSymlink.symlinks.add(RECOVERY_PATH);
		await expect(
			ensureRecoverySecrets({
				fs: fileSymlink,
				recoveryPath: RECOVERY_PATH,
				requiredSecrets: REQUIRED_SECRETS,
				oauth: { ...OAUTH },
				randomBytes: makeCounterRandom().randomBytes
			})
		).rejects.toThrow(/symlink/);
		expect(fileSymlink.writes.filter((path) => path === RECOVERY_PATH)).toEqual([]);

		const dirSymlink = new MemoryFileSystem();
		dirSymlink.symlinks.add(PARENT_DIR);
		await expect(
			ensureRecoverySecrets({
				fs: dirSymlink,
				recoveryPath: RECOVERY_PATH,
				requiredSecrets: REQUIRED_SECRETS,
				oauth: { ...OAUTH },
				randomBytes: makeCounterRandom().randomBytes
			})
		).rejects.toThrow(/symlink/);
		expect(await dirSymlink.exists(RECOVERY_PATH)).toBe(false);

		const dirAsFile = new MemoryFileSystem();
		await dirAsFile.mkdir(PARENT_DIR, { mode: 0o700 });
		await dirAsFile.chmod(PARENT_DIR, 0o700);
		await dirAsFile.mkdir(RECOVERY_PATH, { mode: 0o700 });
		await expect(
			ensureRecoverySecrets({
				fs: dirAsFile,
				recoveryPath: RECOVERY_PATH,
				requiredSecrets: REQUIRED_SECRETS,
				oauth: { ...OAUTH },
				randomBytes: makeCounterRandom().randomBytes
			})
		).rejects.toThrow(/not a regular file/);
	});

	it('parses bounded exact-key OAuth stdin and rejects the rest', async () => {
		const valid = parseOAuthStdinBytes(new TextEncoder().encode(JSON.stringify({ ...OAUTH })));
		expect(valid).toEqual({ ...OAUTH });
		const oauth = await readOAuthSecrets(async () =>
			new TextEncoder().encode(JSON.stringify(OAUTH))
		);
		expect(oauth).toEqual({ ...OAUTH });
		const oversized = new Uint8Array(MAX_STDIN_BYTES + 1).fill(0x78);
		expect(() => parseOAuthStdinBytes(oversized)).toThrow(/exceeds the .*16.*byte limit/);
		for (const text of [
			'not-json',
			JSON.stringify({ D6E_AUTH_CLIENT_ID: 'only' }),
			JSON.stringify({ ...OAUTH, EXTRA: 'x' }),
			JSON.stringify({ D6E_AUTH_CLIENT_ID: '', D6E_AUTH_CLIENT_SECRET: 's' }),
			'[]'
		]) {
			expect(() => parseOAuthStdinBytes(new TextEncoder().encode(text))).toThrow();
		}
		await expect(readOAuthSecrets(async () => oversized)).rejects.toThrow(/exceeds/);
		await expect(
			readOAuthSecrets(async () => {
				throw new Error('EACCES stdin');
			})
		).rejects.toThrow(/cannot be read/);
	});
});
