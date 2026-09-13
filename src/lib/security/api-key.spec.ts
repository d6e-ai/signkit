import { describe, expect, it } from 'vitest';
import {
	canonicalizeApiKeyScopes,
	hasAuthorizationHeader,
	parseBearerApiKey,
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

describe('bearer API key parsing', () => {
	const TOKEN: string = `signkit_${'a'.repeat(43)}`;

	it('accepts the exact canonical Bearer form', () => {
		expect(parseBearerApiKey(`Bearer ${TOKEN}`)).toBe(TOKEN);
	});

	it('accepts every base64url character in the secret', () => {
		const token: string = `signkit_${'-_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'.slice(0, 43)}`;
		expect(isApiKey(token)).toBe(true);
		expect(parseBearerApiKey(`Bearer ${token}`)).toBe(token);
	});

	/**
	 * Every rejection must be indistinguishable to the caller: the parser returns
	 * null for all of them, and the hooks layer maps null to the same opaque 401.
	 * The other credential families are listed explicitly because presenting a
	 * recipient capability, a completion grant, an invitation token, or a worker
	 * secret here must never be treated as an API key.
	 */
	it.each([
		['a missing header', null],
		['an empty header', ''],
		['a lowercase scheme', `bearer ${TOKEN}`],
		['an uppercase scheme', `BEARER ${TOKEN}`],
		['no scheme at all', TOKEN],
		['a leading space', ` Bearer ${TOKEN}`],
		['a trailing space', `Bearer ${TOKEN} `],
		['two spaces after the scheme', `Bearer  ${TOKEN}`],
		['a tab separator', `Bearer\t${TOKEN}`],
		['a Basic credential', 'Basic dXNlcjpwYXNz'],
		['a recipient capability', `Bearer skr1_${'a'.repeat(43)}`],
		['a completion access grant', `Bearer skca1_${'a'.repeat(43)}`],
		['an instance invitation token', `Bearer ski1_${'a'.repeat(43)}`],
		['a deployment worker secret', `Bearer ${'x'.repeat(48)}`],
		['a truncated secret', `Bearer signkit_${'a'.repeat(42)}`],
		['an overlong secret', `Bearer signkit_${'a'.repeat(44)}`],
		['a non-base64url character', `Bearer signkit_${'a'.repeat(42)}+`],
		['a trailing newline', `Bearer ${TOKEN}\n`],
		['a second credential appended', `Bearer ${TOKEN}, Bearer ${TOKEN}`]
	])('rejects %s', (_name, header) => {
		expect(parseBearerApiKey(header)).toBeNull();
	});

	/**
	 * Bearer exclusivity depends on detecting that *some* Authorization header was
	 * presented, independently of whether it parses. Otherwise a malformed bearer
	 * would silently fall back to a cookie session.
	 */
	it('reports header presence independently of parseability', () => {
		expect(hasAuthorizationHeader('Basic dXNlcjpwYXNz')).toBe(true);
		expect(hasAuthorizationHeader(`Bearer skr1_${'a'.repeat(43)}`)).toBe(true);
		expect(hasAuthorizationHeader(`Bearer ${TOKEN}`)).toBe(true);
	});

	/**
	 * An absent header and a present-but-empty one are genuinely different inputs
	 * -- `Headers.get` returns `null` versus `''`, and `Headers.has` reports false
	 * versus true -- and they are deliberately treated the same here.
	 *
	 * An all-empty `Authorization` presents no credential, so treating it as "no
	 * bearer" cannot let an attacker-supplied credential compose with a victim's
	 * cookie: there is no credential to compose. Suppressing the cookie for it
	 * would only turn a credential-free request into a 401 for no security gain.
	 */
	it('treats an absent and a present-but-empty header alike', () => {
		const url: string = 'https://signkit.example/api/v1/envelopes';
		const absent: Request = new Request(url);
		const empty: Request = new Request(url, { headers: { authorization: '' } });
		const whitespace: Request = new Request(url, { headers: { authorization: '   ' } });

		// The inputs really are distinguishable at the Headers level.
		expect(absent.headers.has('authorization')).toBe(false);
		expect(absent.headers.get('authorization')).toBeNull();
		expect(empty.headers.has('authorization')).toBe(true);
		expect(empty.headers.get('authorization')).toBe('');
		// HTTP strips surrounding whitespace, so a whitespace-only value is empty.
		expect(whitespace.headers.get('authorization')).toBe('');

		// And all three are reported as carrying no bearer.
		expect(hasAuthorizationHeader(absent.headers.get('authorization'))).toBe(false);
		expect(hasAuthorizationHeader(empty.headers.get('authorization'))).toBe(false);
		expect(hasAuthorizationHeader(whitespace.headers.get('authorization'))).toBe(false);
	});

	/**
	 * Duplication cannot be used to hide a real token behind an empty one:
	 * `Headers.get` joins repeated fields with `", "`, so the combined value is
	 * non-empty, is reported as present, and then fails the anchored parse -- which
	 * is the fail-closed outcome, not a usable credential.
	 */
	it('reports a duplicated header with one empty value as present but unparsable', () => {
		const headers: Headers = new Headers();
		headers.append('authorization', '');
		headers.append('authorization', `Bearer ${TOKEN}`);
		const combined: string | null = headers.get('authorization');

		expect(combined).toBe(`, Bearer ${TOKEN}`);
		expect(hasAuthorizationHeader(combined)).toBe(true);
		expect(parseBearerApiKey(combined)).toBeNull();
	});
});
