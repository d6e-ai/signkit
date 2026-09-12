import { describe, expect, it } from 'vitest';
import {
	canonicalizeApiKeyScopes,
	canonicalizeApiKeyScopesJson,
	defaultApiKeyExpiresAt,
	hashApiKey,
	isApiKey,
	isApiKeyScope,
	issueApiKey,
	parseApiKey,
	resolveApiKeyExpiresAt,
	validateApiKeyName,
	apiKeyDisplayPrefix,
	API_KEY_DEFAULT_EXPIRY_MS,
	API_KEY_MAX_EXPIRY_MS,
	API_KEY_PREFIX,
	API_KEY_SCOPES,
	type IssuedApiKey
} from './api-key';

describe('api-key helpers', () => {
	it('exports the exact allowed scope list', () => {
		expect(API_KEY_SCOPES).toEqual([
			'audit:read',
			'drafts:write',
			'envelopes:read',
			'envelopes:send'
		]);
		expect(isApiKeyScope('envelopes:send')).toBe(true);
		expect(isApiKeyScope('envelopes:write')).toBe(false);
	});

	it('canonicalizes a nonempty unique subset in stable order', () => {
		expect(canonicalizeApiKeyScopes(['envelopes:send', 'audit:read'])).toEqual([
			'audit:read',
			'envelopes:send'
		]);
		expect(canonicalizeApiKeyScopesJson(['envelopes:send', 'drafts:write', 'audit:read'])).toBe(
			'["audit:read","drafts:write","envelopes:send"]'
		);
		expect(canonicalizeApiKeyScopesJson(['envelopes:read'])).toBe('["envelopes:read"]');
	});

	it('rejects empty, duplicate, or unknown scopes', () => {
		expect((): readonly string[] => canonicalizeApiKeyScopes([])).toThrow(
			'API key scopes must be a nonempty unique subset'
		);
		expect((): readonly string[] => canonicalizeApiKeyScopes(['audit:read', 'audit:read'])).toThrow(
			'API key scopes must be a nonempty unique subset'
		);
		expect((): readonly string[] => canonicalizeApiKeyScopes(['secrets:read'])).toThrow(
			'API key scopes must be a nonempty unique subset'
		);
	});

	it('trims and validates safe key names', () => {
		expect(validateApiKeyName('  CI agent  ')).toBe('CI agent');
		expect(validateApiKeyName('自動化')).toBe('自動化');
		expect(validateApiKeyName('signkitX')).toBe('signkitX');
		expect(validateApiKeyName('signkit')).toBe('signkit');
		expect((): string => validateApiKeyName('   ')).toThrow('Invalid API key name');
		expect((): string => validateApiKeyName('a'.repeat(201))).toThrow('Invalid API key name');
		expect((): string => validateApiKeyName('name\nwith\nnewlines')).toThrow(
			'Invalid API key name'
		);
		expect((): string => validateApiKeyName(`${API_KEY_PREFIX}secret`)).toThrow(
			'Invalid API key name'
		);
	});

	it('defaults expiry to 90 days and rejects non-expiring or too-long values', () => {
		const now: Date = new Date('2026-09-12T12:00:00.000Z');
		expect(defaultApiKeyExpiresAt(now)).toBe('2026-12-11T12:00:00.000Z');
		expect(resolveApiKeyExpiresAt(now)).toBe('2026-12-11T12:00:00.000Z');
		expect(Date.parse(resolveApiKeyExpiresAt(now)) - now.valueOf()).toBe(API_KEY_DEFAULT_EXPIRY_MS);
		expect(resolveApiKeyExpiresAt(now, '2027-09-12T12:00:00.000Z')).toBe(
			'2027-09-12T12:00:00.000Z'
		);
		expect(Date.parse('2027-09-12T12:00:00.000Z') - now.valueOf()).toBe(API_KEY_MAX_EXPIRY_MS);
		expect((): string => resolveApiKeyExpiresAt(now, null)).toThrow('API keys must expire');
		expect((): string => resolveApiKeyExpiresAt(now, '2026-09-12T12:00:00.000Z')).toThrow(
			'API key expiry must be in the future'
		);
		expect((): string => resolveApiKeyExpiresAt(now, '2027-09-12T12:00:00.001Z')).toThrow(
			'API key expiry must be at most 365 days'
		);
		expect((): string => resolveApiKeyExpiresAt(now, 'not-a-date')).toThrow(
			'Invalid API key expiry'
		);
	});

	it('issues signkit_ credentials, hashes the full token, and exposes a safe display prefix', async () => {
		const issued: IssuedApiKey = await issueApiKey();
		expect(issued.token.startsWith(API_KEY_PREFIX)).toBe(true);
		expect(issued.token).toHaveLength(51);
		expect(isApiKey(issued.token)).toBe(true);
		expect(parseApiKey(issued.token)).toBe(issued.token);
		expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(await hashApiKey(issued.token)).toBe(issued.tokenHash);
		expect(issued.keyPrefix).toBe(apiKeyDisplayPrefix(issued.token));
		expect(issued.keyPrefix).toHaveLength(16);
		expect(issued.keyPrefix.startsWith(API_KEY_PREFIX)).toBe(true);
		expect(issued.keyPrefix).not.toBe(issued.token);
		expect(issued.token.startsWith(issued.keyPrefix)).toBe(true);
	});

	it('strictly parses signkit_ plus 43 base64url characters', async () => {
		const valid: string = 'signkit_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
		expect(valid).toHaveLength(51);
		expect(valid.slice(API_KEY_PREFIX.length)).toHaveLength(43);
		expect(isApiKey(valid)).toBe(true);
		expect(isApiKey('signkit_abcdefghijklmnopqrstuvwxyz0123456789ABCDE')).toBe(false);
		expect(isApiKey('signkit_short')).toBe(false);
		expect(isApiKey('signkitX_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF')).toBe(false);
		expect(isApiKey('skr1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')).toBe(false);
		expect(isApiKey('skca1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')).toBe(false);
		expect(isApiKey('signkit_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF=')).toBe(false);
		expect(isApiKey(` ${valid}`)).toBe(false);
		await expect(hashApiKey('invalid-token')).rejects.toThrow('Invalid API key');
		expect((): string => parseApiKey('invalid-token')).toThrow('Invalid API key');
		expect((): string => apiKeyDisplayPrefix('invalid-token')).toThrow('Invalid API key');
	});

	it('does not include the token in parser or hash error messages', async () => {
		const issued: IssuedApiKey = await issueApiKey();
		const invalid: string = `${issued.token}x`;
		expect((): string => parseApiKey(invalid)).toThrow('Invalid API key');
		try {
			parseApiKey(invalid);
			expect.unreachable('parseApiKey should reject a malformed token');
		} catch (error: unknown) {
			expect((error as Error).message).toBe('Invalid API key');
			expect((error as Error).message).not.toContain(issued.token);
			expect((error as Error).message).not.toContain(invalid);
		}
		await expect(hashApiKey(invalid)).rejects.toThrow('Invalid API key');
	});
});
