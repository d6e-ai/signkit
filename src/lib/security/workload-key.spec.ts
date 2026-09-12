import { describe, expect, it } from 'vitest';
import {
	canonicalizeWorkloadKeyScopes,
	canonicalizeWorkloadKeyScopesJson,
	defaultWorkloadKeyExpiresAt,
	hashWorkloadKey,
	isWorkloadKey,
	isWorkloadKeyScope,
	issueWorkloadKey,
	parseWorkloadKey,
	resolveWorkloadKeyExpiresAt,
	validateWorkloadKeyName,
	workloadKeyDisplayPrefix,
	WORKLOAD_KEY_DEFAULT_EXPIRY_MS,
	WORKLOAD_KEY_MAX_EXPIRY_MS,
	WORKLOAD_KEY_PREFIX,
	WORKLOAD_KEY_SCOPES,
	type IssuedWorkloadKey
} from './workload-key';

describe('workload-key helpers', () => {
	it('exports the exact allowed scope list', () => {
		expect(WORKLOAD_KEY_SCOPES).toEqual([
			'audit:read',
			'drafts:write',
			'envelopes:read',
			'envelopes:send'
		]);
		expect(isWorkloadKeyScope('envelopes:send')).toBe(true);
		expect(isWorkloadKeyScope('envelopes:write')).toBe(false);
	});

	it('canonicalizes a nonempty unique subset in stable order', () => {
		expect(canonicalizeWorkloadKeyScopes(['envelopes:send', 'audit:read'])).toEqual([
			'audit:read',
			'envelopes:send'
		]);
		expect(
			canonicalizeWorkloadKeyScopesJson(['envelopes:send', 'drafts:write', 'audit:read'])
		).toBe('["audit:read","drafts:write","envelopes:send"]');
		expect(canonicalizeWorkloadKeyScopesJson(['envelopes:read'])).toBe('["envelopes:read"]');
	});

	it('rejects empty, duplicate, or unknown scopes', () => {
		expect((): readonly string[] => canonicalizeWorkloadKeyScopes([])).toThrow(
			'Workload key scopes must be a nonempty unique subset'
		);
		expect((): readonly string[] =>
			canonicalizeWorkloadKeyScopes(['audit:read', 'audit:read'])
		).toThrow('Workload key scopes must be a nonempty unique subset');
		expect((): readonly string[] => canonicalizeWorkloadKeyScopes(['secrets:read'])).toThrow(
			'Workload key scopes must be a nonempty unique subset'
		);
	});

	it('trims and validates safe key names', () => {
		expect(validateWorkloadKeyName('  CI agent  ')).toBe('CI agent');
		expect(validateWorkloadKeyName('自動化')).toBe('自動化');
		expect(validateWorkloadKeyName('signkitX')).toBe('signkitX');
		expect(validateWorkloadKeyName('signkit')).toBe('signkit');
		expect((): string => validateWorkloadKeyName('   ')).toThrow('Invalid workload key name');
		expect((): string => validateWorkloadKeyName('a'.repeat(201))).toThrow(
			'Invalid workload key name'
		);
		expect((): string => validateWorkloadKeyName('name\nwith\nnewlines')).toThrow(
			'Invalid workload key name'
		);
		expect((): string => validateWorkloadKeyName(`${WORKLOAD_KEY_PREFIX}secret`)).toThrow(
			'Invalid workload key name'
		);
	});

	it('defaults expiry to 90 days and rejects non-expiring or too-long values', () => {
		const now: Date = new Date('2026-09-12T12:00:00.000Z');
		expect(defaultWorkloadKeyExpiresAt(now)).toBe('2026-12-11T12:00:00.000Z');
		expect(resolveWorkloadKeyExpiresAt(now)).toBe('2026-12-11T12:00:00.000Z');
		expect(Date.parse(resolveWorkloadKeyExpiresAt(now)) - now.valueOf()).toBe(
			WORKLOAD_KEY_DEFAULT_EXPIRY_MS
		);
		expect(resolveWorkloadKeyExpiresAt(now, '2027-09-12T12:00:00.000Z')).toBe(
			'2027-09-12T12:00:00.000Z'
		);
		expect(Date.parse('2027-09-12T12:00:00.000Z') - now.valueOf()).toBe(WORKLOAD_KEY_MAX_EXPIRY_MS);
		expect((): string => resolveWorkloadKeyExpiresAt(now, null)).toThrow(
			'Workload keys must expire'
		);
		expect((): string => resolveWorkloadKeyExpiresAt(now, '2026-09-12T12:00:00.000Z')).toThrow(
			'Workload key expiry must be in the future'
		);
		expect((): string => resolveWorkloadKeyExpiresAt(now, '2027-09-12T12:00:00.001Z')).toThrow(
			'Workload key expiry must be at most 365 days'
		);
		expect((): string => resolveWorkloadKeyExpiresAt(now, 'not-a-date')).toThrow(
			'Invalid workload key expiry'
		);
	});

	it('issues signkit_ credentials, hashes the full token, and exposes a safe display prefix', async () => {
		const issued: IssuedWorkloadKey = await issueWorkloadKey();
		expect(issued.token.startsWith(WORKLOAD_KEY_PREFIX)).toBe(true);
		expect(issued.token).toHaveLength(51);
		expect(isWorkloadKey(issued.token)).toBe(true);
		expect(parseWorkloadKey(issued.token)).toBe(issued.token);
		expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(await hashWorkloadKey(issued.token)).toBe(issued.tokenHash);
		expect(issued.keyPrefix).toBe(workloadKeyDisplayPrefix(issued.token));
		expect(issued.keyPrefix).toHaveLength(16);
		expect(issued.keyPrefix.startsWith(WORKLOAD_KEY_PREFIX)).toBe(true);
		expect(issued.keyPrefix).not.toBe(issued.token);
		expect(issued.token.startsWith(issued.keyPrefix)).toBe(true);
	});

	it('strictly parses signkit_ plus 43 base64url characters', async () => {
		const valid: string = 'signkit_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
		expect(valid).toHaveLength(51);
		expect(valid.slice(WORKLOAD_KEY_PREFIX.length)).toHaveLength(43);
		expect(isWorkloadKey(valid)).toBe(true);
		expect(isWorkloadKey('signkit_abcdefghijklmnopqrstuvwxyz0123456789ABCDE')).toBe(false);
		expect(isWorkloadKey('signkit_short')).toBe(false);
		expect(isWorkloadKey('signkitX_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF')).toBe(false);
		expect(isWorkloadKey('skr1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')).toBe(false);
		expect(isWorkloadKey('skca1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')).toBe(false);
		expect(isWorkloadKey('signkit_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF=')).toBe(false);
		expect(isWorkloadKey(` ${valid}`)).toBe(false);
		await expect(hashWorkloadKey('invalid-token')).rejects.toThrow('Invalid workload key');
		expect((): string => parseWorkloadKey('invalid-token')).toThrow('Invalid workload key');
		expect((): string => workloadKeyDisplayPrefix('invalid-token')).toThrow('Invalid workload key');
	});

	it('does not include the token in parser or hash error messages', async () => {
		const issued: IssuedWorkloadKey = await issueWorkloadKey();
		const invalid: string = `${issued.token}x`;
		expect((): string => parseWorkloadKey(invalid)).toThrow('Invalid workload key');
		try {
			parseWorkloadKey(invalid);
			expect.unreachable('parseWorkloadKey should reject a malformed token');
		} catch (error: unknown) {
			expect((error as Error).message).toBe('Invalid workload key');
			expect((error as Error).message).not.toContain(issued.token);
			expect((error as Error).message).not.toContain(invalid);
		}
		await expect(hashWorkloadKey(invalid)).rejects.toThrow('Invalid workload key');
	});
});
