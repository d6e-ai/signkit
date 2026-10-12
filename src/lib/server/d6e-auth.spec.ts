import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { authorizeUrl, D6eAuthRejectedError, refresh, verifyAccessToken } from './d6e-auth';
import { mockFetchRouter } from './d6e-auth-jwks-test-support';

let baseUrlCounter: number = 0;

/**
 * A fresh, never-before-used origin. The module-global JWKS resolver cache in
 * `d6e-auth.ts` is keyed by this URL, so giving every test (and every
 * simulated configuration change within a test) its own origin keeps them
 * from observing each other's cached resolvers.
 */
function nextBaseUrl(): string {
	baseUrlCounter += 1;
	return `https://auth-${baseUrlCounter}.example`;
}

let BASE_URL: string = nextBaseUrl();
const CLIENT_ID: string = 'client-1';
const KID: string = 'test-key';

let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;

beforeAll(async (): Promise<void> => {
	const pair = await generateKeyPair('RS256', { extractable: true });
	privateKey = pair.privateKey;
	publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
});

beforeEach((): void => {
	BASE_URL = nextBaseUrl();
	privateEnv.D6E_AUTH_BASE_URL = BASE_URL;
	privateEnv.D6E_AUTH_CLIENT_ID = CLIENT_ID;
	privateEnv.D6E_AUTH_CLIENT_SECRET = 'secret';
});

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
	vi.unstubAllGlobals();
});

function mockFetchJwks(): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url: string = typeof input === 'string' ? input : input.toString();
			if (url === `${BASE_URL}/.well-known/jwks.json`) {
				return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
			}
			throw new Error(`unexpected fetch in test: ${url}`);
		})
	);
}

function mockFetchResponse(status: number, body: unknown = {}): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify(body), { status }))
	);
}

interface TokenClaims {
	sub?: string;
	email?: string;
	name?: string;
	email_verified?: boolean;
	type?: string;
}

async function signToken(
	claims: TokenClaims,
	options: {
		key?: CryptoKey;
		audience?: string;
		expired?: boolean;
		kid?: string;
	} = {}
): Promise<string> {
	const now: number = Math.floor(Date.now() / 1000);
	return new SignJWT({ ...claims })
		.setProtectedHeader({ alg: 'RS256', kid: options.kid ?? KID })
		.setIssuedAt(options.expired ? now - 7200 : now)
		.setIssuer('d6e-auth')
		.setAudience(options.audience ?? CLIENT_ID)
		.setExpirationTime(options.expired ? now - 3600 : now + 3600)
		.setSubject(claims.sub ?? 'user-1')
		.sign(options.key ?? privateKey);
}

function withHeaderAlg(token: string, alg: string): string {
	const [headerB64, payloadB64, signatureB64] = token.split('.');
	const header: Record<string, unknown> = JSON.parse(
		Buffer.from(headerB64, 'base64url').toString('utf8')
	);
	header.alg = alg;
	const newHeaderB64: string = Buffer.from(JSON.stringify(header)).toString('base64url');
	return `${newHeaderB64}.${payloadB64}.${signatureB64}`;
}

describe('verifyAccessToken', () => {
	it('returns a verified principal for a well-formed token', async () => {
		mockFetchJwks();
		const token: string = await signToken({
			email: 'user@example.com',
			name: 'User',
			email_verified: true
		});

		await expect(verifyAccessToken(token)).resolves.toEqual({
			subject: 'user-1',
			email: 'user@example.com',
			name: 'User',
			emailVerified: true
		});
	});

	it('treats a missing email_verified claim as false rather than throwing', async () => {
		mockFetchJwks();
		const token: string = await signToken({ email: 'user@example.com', name: 'User' });

		await expect(verifyAccessToken(token)).resolves.toMatchObject({ emailVerified: false });
	});

	it('rejects (not unavailable) an expired token', async () => {
		mockFetchJwks();
		const token: string = await signToken({ email: 'user@example.com' }, { expired: true });

		await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(D6eAuthRejectedError);
	});

	it('rejects (not unavailable) a token issued for a different audience', async () => {
		mockFetchJwks();
		const token: string = await signToken(
			{ email: 'user@example.com' },
			{ audience: 'someone-else' }
		);

		await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(D6eAuthRejectedError);
	});

	it('rejects (not unavailable) a token signed by an untrusted key', async () => {
		mockFetchJwks();
		const otherPair = await generateKeyPair('RS256', { extractable: true });
		const token: string = await signToken(
			{ email: 'user@example.com' },
			{ key: otherPair.privateKey }
		);

		await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(D6eAuthRejectedError);
	});

	it('rejects (not unavailable) a refresh token presented as an access token', async () => {
		mockFetchJwks();
		const token: string = await signToken({ type: 'refresh' });

		await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(D6eAuthRejectedError);
	});

	it('rejects (not unavailable) a token missing required identity claims', async () => {
		mockFetchJwks();
		const token: string = await signToken({});

		await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(D6eAuthRejectedError);
	});

	it('rejects (not unavailable) a structurally malformed compact JWS', async () => {
		mockFetchJwks();

		await expect(verifyAccessToken('not-a-jwt')).rejects.toBeInstanceOf(D6eAuthRejectedError);
	});

	it('rejects (not unavailable) a token asserting an algorithm outside the RS256 allow-list', async () => {
		mockFetchJwks();
		const validToken: string = await signToken({ email: 'user@example.com' });
		const token: string = withHeaderAlg(validToken, 'RS384');

		await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(D6eAuthRejectedError);
	});

	it('rejects (not unavailable) a token whose kid matches no key in an otherwise-resolved JWKS', async () => {
		mockFetchJwks();
		const token: string = await signToken({ email: 'user@example.com' }, { kid: 'unknown-key' });

		await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(D6eAuthRejectedError);
	});

	it('leaves a JWKS fetch failure as a generic (unavailable) failure, not a rejection', async () => {
		mockFetchResponse(503);
		const token: string = await signToken({ email: 'user@example.com' });

		const error: unknown = await verifyAccessToken(token).catch((caught: unknown) => caught);
		expect(error).not.toBeInstanceOf(D6eAuthRejectedError);
	});
});

describe('verifyAccessToken: remote JWKS resolver reuse', () => {
	function jwksJson(keys: Record<string, unknown>[]): () => Response {
		return () => new Response(JSON.stringify({ keys }), { status: 200 });
	}

	it('reuses the cached resolver across calls instead of refetching the JWKS every time', async () => {
		const jwksUrl: string = `${BASE_URL}/.well-known/jwks.json`;
		const calls = mockFetchRouter(new Map([[jwksUrl, jwksJson([publicJwk])]]));
		const token: string = await signToken({ email: 'user@example.com' });

		await verifyAccessToken(token);
		await verifyAccessToken(token);

		expect(calls.get(jwksUrl)).toBe(1);
	});

	it('revalidates identities, audience and expiry while reusing only the verification keys', async () => {
		const jwksUrl: string = `${BASE_URL}/.well-known/jwks.json`;
		const calls = mockFetchRouter(new Map([[jwksUrl, jwksJson([publicJwk])]]));
		await verifyAccessToken(await signToken({ email: 'first@example.com' }));
		await expect(
			verifyAccessToken(await signToken({ sub: 'user-2', email: 'second@example.com' }))
		).resolves.toMatchObject({ subject: 'user-2', email: 'second@example.com' });
		await expect(
			verifyAccessToken(await signToken({ email: 'first@example.com' }, { audience: 'other' }))
		).rejects.toBeInstanceOf(D6eAuthRejectedError);
		await expect(
			verifyAccessToken(await signToken({ email: 'first@example.com' }, { expired: true }))
		).rejects.toBeInstanceOf(D6eAuthRejectedError);
		expect(calls.get(jwksUrl)).toBe(1);
	});

	it('fetches and verifies against an independent key set for a different configured JWKS URL, never sharing cached keys across origins', async () => {
		const firstUrl: string = `${BASE_URL}/.well-known/jwks.json`;
		const otherBaseUrl: string = nextBaseUrl();
		const otherUrl: string = `${otherBaseUrl}/.well-known/jwks.json`;
		const otherPair = await generateKeyPair('RS256', { extractable: true });
		const otherJwk = {
			...(await exportJWK(otherPair.publicKey)),
			kid: KID,
			alg: 'RS256',
			use: 'sig'
		};
		const calls = mockFetchRouter(
			new Map([
				[firstUrl, jwksJson([publicJwk])],
				[otherUrl, jwksJson([otherJwk])]
			])
		);

		const tokenForFirst: string = await signToken({ email: 'user@example.com' });
		await expect(verifyAccessToken(tokenForFirst)).resolves.toMatchObject({ subject: 'user-1' });

		privateEnv.D6E_AUTH_BASE_URL = otherBaseUrl;
		const tokenForOther: string = await signToken(
			{ email: 'other@example.com' },
			{ key: otherPair.privateKey }
		);
		await expect(verifyAccessToken(tokenForOther)).resolves.toMatchObject({
			email: 'other@example.com'
		});
		expect(calls.get(firstUrl)).toBe(1);
		expect(calls.get(otherUrl)).toBe(1);

		// Switching back must reuse the first origin's untouched cache entry, not
		// refetch, and a token valid under the first origin's key must never
		// verify against the second origin's cached keys or vice versa.
		privateEnv.D6E_AUTH_BASE_URL = BASE_URL;
		await expect(verifyAccessToken(tokenForFirst)).resolves.toMatchObject({ subject: 'user-1' });
		await expect(verifyAccessToken(tokenForOther)).rejects.toBeInstanceOf(D6eAuthRejectedError);
		expect(calls.get(firstUrl)).toBe(1);
	});

	it('evicts the oldest configured JWKS URL once more than the bounded number of origins have been used', async () => {
		const MAX_REMOTE_JWKS_SETS: number = 8;
		const firstUrl: string = `${BASE_URL}/.well-known/jwks.json`;
		const routes = new Map<string, () => Response>([[firstUrl, jwksJson([publicJwk])]]);
		const calls = mockFetchRouter(routes);
		const firstToken: string = await signToken({ email: 'user@example.com' });
		await verifyAccessToken(firstToken);
		expect(calls.get(firstUrl)).toBe(1);

		for (let i = 0; i < MAX_REMOTE_JWKS_SETS; i += 1) {
			const otherBaseUrl: string = nextBaseUrl();
			const otherUrl: string = `${otherBaseUrl}/.well-known/jwks.json`;
			const pair = await generateKeyPair('RS256', { extractable: true });
			const jwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
			routes.set(otherUrl, jwksJson([jwk]));
			privateEnv.D6E_AUTH_BASE_URL = otherBaseUrl;
			const token: string = await signToken(
				{ email: 'user@example.com' },
				{ key: pair.privateKey }
			);
			await verifyAccessToken(token);
		}

		// The first (now oldest) origin was pushed out of the bounded cache, so
		// using it again must refetch rather than reuse a stale instance.
		privateEnv.D6E_AUTH_BASE_URL = BASE_URL;
		await verifyAccessToken(firstToken);
		expect(calls.get(firstUrl)).toBe(2);
	});

	it('retries on the next call after a failed JWKS fetch instead of staying poisoned', async () => {
		const jwksUrl: string = `${BASE_URL}/.well-known/jwks.json`;
		let succeed: boolean = false;
		const calls = mockFetchRouter(
			new Map([
				[
					jwksUrl,
					() =>
						succeed ? jwksJson([publicJwk])() : new Response(JSON.stringify({}), { status: 503 })
				]
			])
		);
		const token: string = await signToken({ email: 'user@example.com' });

		const firstError: unknown = await verifyAccessToken(token).catch((caught: unknown) => caught);
		expect(firstError).not.toBeInstanceOf(D6eAuthRejectedError);
		expect(calls.get(jwksUrl)).toBe(1);

		succeed = true;
		await expect(verifyAccessToken(token)).resolves.toMatchObject({ subject: 'user-1' });
		expect(calls.get(jwksUrl)).toBe(2);
	});

	it('rejects a rotated key while cooling down, then accepts it once the cooldown has elapsed', async () => {
		const jwksUrl: string = `${BASE_URL}/.well-known/jwks.json`;
		const rotatedPair = await generateKeyPair('RS256', { extractable: true });
		const rotatedKid: string = 'rotated-key';
		const rotatedJwk = {
			...(await exportJWK(rotatedPair.publicKey)),
			kid: rotatedKid,
			alg: 'RS256',
			use: 'sig'
		};
		let rotated: boolean = false;
		const calls = mockFetchRouter(
			new Map([[jwksUrl, () => jwksJson(rotated ? [rotatedJwk] : [publicJwk])()]])
		);

		const originalToken: string = await signToken({ email: 'user@example.com' });
		await expect(verifyAccessToken(originalToken)).resolves.toMatchObject({ subject: 'user-1' });
		expect(calls.get(jwksUrl)).toBe(1);

		rotated = true;
		const rotatedToken: string = await signToken(
			{ email: 'rotated@example.com' },
			{ key: rotatedPair.privateKey, kid: rotatedKid }
		);

		await expect(verifyAccessToken(rotatedToken)).rejects.toBeInstanceOf(D6eAuthRejectedError);
		expect(calls.get(jwksUrl)).toBe(1);

		vi.useFakeTimers();
		try {
			await vi.advanceTimersByTimeAsync(30_001);
			await expect(verifyAccessToken(rotatedToken)).resolves.toMatchObject({
				email: 'rotated@example.com'
			});
		} finally {
			vi.useRealTimers();
		}
		expect(calls.get(jwksUrl)).toBe(2);
	});
});

describe('refresh', () => {
	it('rejects (not unavailable) an invalid_grant-style 400 response', async () => {
		mockFetchResponse(400);

		await expect(refresh('refresh-token')).rejects.toBeInstanceOf(D6eAuthRejectedError);
	});

	it('leaves a provider outage (5xx) as a generic (unavailable) failure', async () => {
		mockFetchResponse(503);

		const error: unknown = await refresh('refresh-token').catch((caught: unknown) => caught);
		expect(error).not.toBeInstanceOf(D6eAuthRejectedError);
	});
});

describe('D6E_AUTH_BASE_URL validation', () => {
	it('accepts a canonical https origin', () => {
		expect(authorizeUrl('https://app.example/callback', 'state')).toContain(
			`${BASE_URL}/auth/login?`
		);
	});

	it('accepts an https origin with a trailing slash, stripping it', () => {
		privateEnv.D6E_AUTH_BASE_URL = `${BASE_URL}/`;
		expect(authorizeUrl('https://app.example/callback', 'state')).toContain(
			`${BASE_URL}/auth/login?`
		);
	});

	it.each(['localhost', '127.0.0.1', '[::1]'])(
		'accepts http for the exact loopback host %s (explicit development opt-in)',
		(host) => {
			const loopbackBase = `http://${host}:4000`;
			privateEnv.D6E_AUTH_BASE_URL = loopbackBase;
			expect(authorizeUrl('https://app.example/callback', 'state')).toContain(
				`${loopbackBase}/auth/login?`
			);
		}
	);

	it('rejects http for a non-loopback host', () => {
		privateEnv.D6E_AUTH_BASE_URL = 'http://auth.example';
		expect(() => authorizeUrl('https://app.example/callback', 'state')).toThrow(
			/canonical HTTPS origin/
		);
	});

	it('rejects a non-URL value', () => {
		privateEnv.D6E_AUTH_BASE_URL = 'not-a-url';
		expect(() => authorizeUrl('https://app.example/callback', 'state')).toThrow(
			/valid absolute URL/
		);
	});

	it('rejects credentials embedded in the URL', () => {
		privateEnv.D6E_AUTH_BASE_URL = 'https://user:pass@auth.example';
		expect(() => authorizeUrl('https://app.example/callback', 'state')).toThrow(/credentials/);
	});

	it('rejects a non-root path', () => {
		privateEnv.D6E_AUTH_BASE_URL = 'https://auth.example/v2';
		expect(() => authorizeUrl('https://app.example/callback', 'state')).toThrow(/path/);
	});

	it('rejects a query string', () => {
		privateEnv.D6E_AUTH_BASE_URL = 'https://auth.example?x=1';
		expect(() => authorizeUrl('https://app.example/callback', 'state')).toThrow(
			/query string or fragment/
		);
	});

	it('rejects a fragment', () => {
		privateEnv.D6E_AUTH_BASE_URL = 'https://auth.example#frag';
		expect(() => authorizeUrl('https://app.example/callback', 'state')).toThrow(
			/query string or fragment/
		);
	});

	it('rejects other schemes', () => {
		privateEnv.D6E_AUTH_BASE_URL = 'ftp://auth.example';
		expect(() => authorizeUrl('https://app.example/callback', 'state')).toThrow(
			/canonical HTTPS origin/
		);
	});

	it('never includes the configured value in thrown error messages', () => {
		privateEnv.D6E_AUTH_BASE_URL = 'http://attacker-controlled.example/secret-path';
		try {
			authorizeUrl('https://app.example/callback', 'state');
			throw new Error('expected authorizeUrl to throw');
		} catch (error: unknown) {
			expect(String(error)).not.toContain('attacker-controlled.example');
		}
	});
});
