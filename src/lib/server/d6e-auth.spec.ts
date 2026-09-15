import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import {
	authorizeUrl,
	D6eAuthRejectedError,
	organizations,
	refresh,
	verifyAccessToken
} from './d6e-auth';

const BASE_URL: string = 'https://auth.example';
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

describe('organizations', () => {
	it('rejects (not unavailable) a 401 organization lookup', async () => {
		mockFetchResponse(401);

		await expect(organizations('access-token')).rejects.toBeInstanceOf(D6eAuthRejectedError);
	});

	it('leaves a provider outage (5xx) as a generic (unavailable) failure', async () => {
		mockFetchResponse(502);

		const error: unknown = await organizations('access-token').catch((caught: unknown) => caught);
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
