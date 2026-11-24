import { DatabaseSync } from 'node:sqlite';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations, sqliteD1Database } from '$lib/adapters/db/sqlite-d1-test-support';

const privateEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));
vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

const { handleApiKeyAuthentication, handleSession } = await import('./hooks.server');
const { authorizeScopedInstanceRequest } = await import('$lib/http/api-key-authorization');
const { GET: dashboardGet } = await import('./routes/api/v1/dashboard/+server');
const { GET: memberMeGet } = await import('./routes/api/v1/instance/members/me/+server');
const { POST: bootstrapPost } = await import('./routes/api/v1/instance/bootstrap/+server');
const { GET: envelopesGet, POST: envelopesPost } =
	await import('./routes/api/v1/envelopes/+server');
const { GET: recipientContextGet } = await import('./routes/api/v1/recipient/context/+server');

/**
 * A d6e-auth origin no other suite uses, so the module-global JWKS resolver
 * cache in `d6e-auth.ts` never shares keys with another file.
 */
const BASE_URL: string = 'https://auth-access-token-bearer.example';
const CLIENT_ID: string = 'signkit-client-1';
const KID: string = 'access-token-test-key';
const AT: string = '2026-09-01T00:00:00.000Z';
const OWNER_ID: string = 'user-1';
const COOKIE_MEMBER_ID: string = 'user-2';

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
	privateEnv.D6E_AUTH_CLIENT_SECRET = 'client-secret';
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
			const url: string = typeof input === 'string' ? input : input.toString();
			if (url !== `${BASE_URL}/.well-known/jwks.json`) {
				throw new Error(`unexpected fetch in test: ${url}`);
			}
			return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
		})
	);
	vi.spyOn(console, 'error').mockImplementation((): void => undefined);
});

afterEach((): void => {
	for (const key of Object.keys(privateEnv)) delete privateEnv[key];
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function accessToken(
	claims: Record<string, unknown> = {},
	options: { audience?: string; expiresInSeconds?: number | null; key?: CryptoKey } = {}
): Promise<string> {
	const now: number = Math.floor(Date.now() / 1000);
	let jwt: SignJWT = new SignJWT({
		email: 'owner@example.com',
		name: 'Owner Person',
		email_verified: true,
		...claims
	})
		.setProtectedHeader({ alg: 'RS256', kid: KID })
		.setIssuedAt(now)
		.setIssuer('d6e-auth')
		.setAudience(options.audience ?? CLIENT_ID)
		.setSubject(typeof claims.sub === 'string' ? claims.sub : OWNER_ID);
	if (options.expiresInSeconds !== null) {
		jwt = jwt.setExpirationTime(now + (options.expiresInSeconds ?? 600));
	}
	return jwt.sign(options.key ?? privateKey);
}

interface Fixture {
	sqlite: DatabaseSync;
	platform: App.Platform;
}

function createFixture(options: { members?: boolean; env?: Record<string, string> } = {}): Fixture {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	if (options.members !== false) {
		sqlite.exec(`
			INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES ('${OWNER_ID}', 'owner', 'active', '${AT}', '${AT}'),
			       ('${COOKIE_MEMBER_ID}', 'member', 'active', '${AT}', '${AT}');
		`);
	}
	return {
		sqlite,
		platform: {
			env: { DB: sqliteD1Database(sqlite), ...options.env }
		} as unknown as App.Platform
	};
}

interface Outcome {
	response: Response;
	locals: App.Locals;
	cookieReads: string[];
	cookieWrites: string[];
}

/**
 * Runs the two credential hooks in the order `handle` installs them and then
 * the real route handler. `sequence(...)` itself needs SvelteKit's internal
 * request store, so the composition is manual, exactly as in the API key
 * integration suite.
 */
async function runRequest(
	fixture: Fixture,
	handler: RequestHandler,
	input: {
		pathname: string;
		method?: string;
		authorization?: string;
		sessionCookie?: string;
		headers?: Record<string, string>;
		body?: string;
	}
): Promise<Outcome> {
	const url: URL = new URL(`https://signkit.example${input.pathname}`);
	const headers: Headers = new Headers(input.headers);
	if (input.authorization !== undefined) headers.set('authorization', input.authorization);
	const cookieReads: string[] = [];
	const cookieWrites: string[] = [];
	const event = {
		locals: {} as Partial<App.Locals>,
		url,
		params: {},
		platform: fixture.platform,
		request: new Request(url, {
			method: input.method ?? 'GET',
			headers,
			...(input.body === undefined ? {} : { body: input.body })
		}),
		cookies: {
			get: (name: string): string | undefined => {
				cookieReads.push(name);
				return input.sessionCookie;
			},
			set: (name: string): void => {
				cookieWrites.push(`set:${name}`);
			},
			delete: (name: string): void => {
				cookieWrites.push(`delete:${name}`);
			}
		}
	} as unknown as RequestEvent;

	const response: Response = (await handleApiKeyAuthentication({
		event,
		resolve: async (sessionEvent: RequestEvent): Promise<Response> =>
			handleSession({
				event: sessionEvent,
				resolve: async (routeEvent: RequestEvent): Promise<Response> => handler(routeEvent as never)
			} as unknown as Parameters<typeof handleSession>[0]) as Promise<Response>
	} as unknown as Parameters<typeof handleApiKeyAuthentication>[0])) as Response;

	return { response, locals: event.locals, cookieReads, cookieWrites };
}

async function problemType(response: Response): Promise<string> {
	return ((await response.json()) as { type: string }).type;
}

describe('d6e-auth access token as an operator bearer (real verification, real D1)', () => {
	it('authenticates a session-only route as the human member, without reading the cookie', async () => {
		const fixture: Fixture = createFixture();
		try {
			const outcome: Outcome = await runRequest(fixture, memberMeGet, {
				pathname: '/api/v1/instance/members/me',
				authorization: `Bearer ${await accessToken()}`
			});

			expect(outcome.response.status).toBe(200);
			expect(await outcome.response.json()).toMatchObject({
				member: { userId: OWNER_ID, role: 'owner', status: 'active' }
			});
			expect(outcome.locals.identityState).toBe('active');
			expect(outcome.locals.apiKeyAuthentication).toEqual({ state: 'absent' });
			expect(outcome.locals.accessTokenAuthentication).toEqual({
				state: 'verified',
				observedAt: expect.any(String) as unknown as string
			});
			expect(outcome.cookieReads).toEqual([]);
			expect(outcome.cookieWrites).toEqual([]);
		} finally {
			fixture.sqlite.close();
		}
	});

	it('authenticates the session-only dashboard', async () => {
		const fixture: Fixture = createFixture();
		try {
			const outcome: Outcome = await runRequest(fixture, dashboardGet, {
				pathname: '/api/v1/dashboard',
				authorization: `Bearer ${await accessToken()}`
			});

			expect(outcome.response.status).toBe(200);
			expect(await outcome.response.json()).toHaveProperty('items');
		} finally {
			fixture.sqlite.close();
		}
	});

	it('bootstraps an empty instance from a verified access token', async () => {
		const fixture: Fixture = createFixture({
			members: false,
			env: { SIGNKIT_BOOTSTRAP_OWNER_EMAIL: 'owner@example.com' }
		});
		try {
			const outcome: Outcome = await runRequest(fixture, bootstrapPost, {
				pathname: '/api/v1/instance/bootstrap',
				method: 'POST',
				authorization: `Bearer ${await accessToken()}`,
				headers: { 'content-type': 'application/json', 'idempotency-key': 'bootstrap-1' },
				body: '{}'
			});

			expect(outcome.response.status).toBe(201);
			expect(
				fixture.sqlite.prepare('SELECT user_id, role, status FROM instance_member').all()
			).toEqual([{ user_id: OWNER_ID, role: 'owner', status: 'active' }]);
			expect(outcome.cookieWrites).toEqual([]);
		} finally {
			fixture.sqlite.close();
		}
	});

	it('lists envelopes and creates one as the human member, never as an agent', async () => {
		const fixture: Fixture = createFixture();
		try {
			const token: string = await accessToken();
			const list: Outcome = await runRequest(fixture, envelopesGet, {
				pathname: '/api/v1/envelopes',
				authorization: `Bearer ${token}`
			});
			expect(list.response.status).toBe(200);
			expect(
				authorizeScopedInstanceRequest(list.locals, '/api/v1/envelopes', 'drafts:write')
			).toEqual({
				authority: 'session',
				id: OWNER_ID,
				createdByUserId: OWNER_ID,
				name: 'Owner Person',
				email: 'owner@example.com'
			});

			const created: Outcome = await runRequest(fixture, envelopesPost, {
				pathname: '/api/v1/envelopes',
				method: 'POST',
				authorization: `Bearer ${token}`,
				headers: { 'content-type': 'application/json', 'idempotency-key': 'create-1' },
				body: JSON.stringify({ title: 'Console agreement' })
			});
			expect(created.response.status).toBe(201);
			const actors = fixture.sqlite
				.prepare('SELECT DISTINCT actor_type, actor_id FROM audit_event')
				.all();
			expect(actors).toEqual([{ actor_type: 'user', actor_id: OWNER_ID }]);
		} finally {
			fixture.sqlite.close();
		}
	});

	it.each([
		['a refresh token', async (): Promise<string> => accessToken({ type: 'refresh' })],
		[
			'a token minted for another deployment',
			async (): Promise<string> => accessToken({}, { audience: 'another-signkit-client' })
		],
		['an expired token', async (): Promise<string> => accessToken({}, { expiresInSeconds: -60 })],
		[
			'a token without an expiry',
			async (): Promise<string> => accessToken({}, { expiresInSeconds: null })
		],
		[
			'a token signed by an untrusted key',
			async (): Promise<string> =>
				accessToken({}, { key: (await generateKeyPair('RS256')).privateKey })
		],
		['a token without an email claim', async (): Promise<string> => accessToken({ email: 7 })],
		['a malformed compact JWS', async (): Promise<string> => 'eyJhbGciOiJSUzI1NiJ9.e30.c2ln']
	])('answers %s with an opaque 401 bearer challenge', async (_name, mint) => {
		const fixture: Fixture = createFixture();
		try {
			const authorization: string = `Bearer ${await mint()}`;
			for (const [handler, pathname] of [
				[memberMeGet, '/api/v1/instance/members/me'],
				[dashboardGet, '/api/v1/dashboard'],
				[envelopesGet, '/api/v1/envelopes']
			] as const) {
				const outcome: Outcome = await runRequest(fixture, handler, { pathname, authorization });
				expect(outcome.response.status, pathname).toBe(401);
				expect(await problemType(outcome.response)).toBe(
					'urn:signkit:problem:authentication-required'
				);
				expect(outcome.response.headers.get('www-authenticate')).toBe('Bearer');
				expect(outcome.locals.accessTokenAuthentication).toEqual({ state: 'rejected' });
				expect(outcome.cookieReads).toEqual([]);
				expect(outcome.cookieWrites).toEqual([]);
			}
		} finally {
			fixture.sqlite.close();
		}
	});

	it('never reads a cookie, with or without an access token', async () => {
		const fixture: Fixture = createFixture();
		try {
			// An old operator session cookie may still ride along from before this
			// server dropped its own sign-in; it is never an authority.
			const sessionCookie: string = 'old-sealed-operator-session';

			const verified: Outcome = await runRequest(fixture, memberMeGet, {
				pathname: '/api/v1/instance/members/me',
				authorization: `Bearer ${await accessToken()}`,
				sessionCookie
			});
			expect(verified.response.status).toBe(200);
			expect(await verified.response.json()).toMatchObject({ member: { userId: OWNER_ID } });
			expect(verified.cookieReads).toEqual([]);

			// A failing token never falls back to the cookie that rode along.
			const rejected: Outcome = await runRequest(fixture, dashboardGet, {
				pathname: '/api/v1/dashboard',
				authorization: `Bearer ${await accessToken({}, { audience: 'another-signkit-client' })}`,
				sessionCookie
			});
			expect(rejected.response.status).toBe(401);
			expect(rejected.cookieReads).toEqual([]);
			expect(rejected.cookieWrites).toEqual([]);

			// The cookie alone authorizes nothing.
			vi.stubGlobal('fetch', vi.fn());
			const cookieOnly: Outcome = await runRequest(fixture, memberMeGet, {
				pathname: '/api/v1/instance/members/me',
				sessionCookie
			});
			expect(cookieOnly.response.status).toBe(401);
			expect(cookieOnly.cookieReads).toEqual([]);
		} finally {
			fixture.sqlite.close();
		}
	});

	it('answers an unreachable key set as identity unavailable, not unauthenticated', async () => {
		const fixture: Fixture = createFixture();
		try {
			// A configuration whose key set has never been fetched, so the module-global
			// resolver cache cannot answer for the outage.
			privateEnv.D6E_AUTH_BASE_URL = 'https://auth-access-token-outage.example';
			const outcome: Outcome = await runRequest(fixture, dashboardGet, {
				pathname: '/api/v1/dashboard',
				authorization: `Bearer ${await accessToken()}`
			});

			expect(outcome.response.status).toBe(503);
			expect(outcome.locals.accessTokenAuthentication).toEqual({ state: 'unavailable' });
			expect(outcome.cookieReads).toEqual([]);
		} finally {
			fixture.sqlite.close();
		}
	});

	it('keeps a suspended member out', async () => {
		const fixture: Fixture = createFixture();
		try {
			fixture.sqlite.exec(
				`UPDATE instance_member SET status = 'suspended' WHERE user_id = '${COOKIE_MEMBER_ID}'`
			);
			const outcome: Outcome = await runRequest(fixture, dashboardGet, {
				pathname: '/api/v1/dashboard',
				authorization: `Bearer ${await accessToken({ sub: COOKIE_MEMBER_ID, email: 'member@example.com' })}`
			});

			expect(outcome.response.status).toBe(403);
			expect(await problemType(outcome.response)).toBe(
				'urn:signkit:problem:instance-membership-suspended'
			);
		} finally {
			fixture.sqlite.close();
		}
	});

	it('never resolves an access token on the recipient surface', async () => {
		const fixture: Fixture = createFixture();
		try {
			for (const pathname of ['/api/v1/recipient/context', '/api/v1/signing/context']) {
				const outcome: Outcome = await runRequest(fixture, recipientContextGet, {
					pathname,
					authorization: `Bearer ${await accessToken()}`
				});
				expect(outcome.response.status, pathname).toBe(404);
				expect(outcome.locals.accessTokenAuthentication).toEqual({ state: 'absent' });
				expect(outcome.locals.principal).toBeNull();
			}
			expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		} finally {
			fixture.sqlite.close();
		}
	});
});
