import { DatabaseSync } from 'node:sqlite';
import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations, sqliteD1Database } from '$lib/adapters/db/sqlite-d1-test-support';
import { SIGNKIT_ORGANIZATION_HEADER } from '$lib/ports/api-key-authentication-store';
import { issueApiKey, type IssuedApiKey } from '$lib/security/api-key';
import { handleApiKeyAuthentication, handleSession } from './hooks.server';

const OWNER_ID: string = 'user-1';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const GRANT_ID: string = '01900000-0000-7000-8000-000000000301';
const ORG_A: string = 'org-alpha';
const ORG_B: string = 'org-beta';
const DAY_MS: number = 24 * 60 * 60 * 1000;
/**
 * The request path evaluates key liveness against the real clock, because the
 * hooks runtime deliberately exposes no clock injection point. Timestamps are
 * therefore derived from now so the fixture stays valid against both the
 * `expires_at <= created_at + 365 days` schema bound and the runtime's
 * `expires_at > now` predicate, whenever the suite happens to run.
 */
const NOW_MS: number = Date.now();
const AT: string = new Date(NOW_MS - DAY_MS).toISOString();
const EXPIRES_AT: string = new Date(NOW_MS + 300 * DAY_MS).toISOString();
const ALREADY_EXPIRED_AT: string = new Date(NOW_MS - DAY_MS / 2).toISOString();

interface Fixture {
	sqlite: DatabaseSync;
	platform: App.Platform;
	token: string;
}

async function createFixture(
	options: {
		memberStatus?: 'active' | 'suspended';
		keyRevoked?: boolean;
		keyExpiresAt?: string;
		grantOrganization?: string | null;
		grantRevoked?: boolean;
		scopesJson?: string;
	} = {}
): Promise<Fixture> {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const issued: IssuedApiKey = await issueApiKey();
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${OWNER_ID}', 'member', '${options.memberStatus ?? 'active'}', '${AT}', '${AT}');
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORG_A}', '${ORG_A}', 'Alpha', '${AT}');
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORG_B}', '${ORG_B}', 'Beta', '${AT}');
		INSERT INTO api_key (
			id, name, token_hash, key_prefix, scopes_json, owner_user_id,
			created_at, expires_at, revoked_at, rate_window_count
		) VALUES (
			'${KEY_ID}', 'CI agent', '${issued.tokenHash}', '${issued.keyPrefix}',
			'${options.scopesJson ?? '["envelopes:read"]'}', '${OWNER_ID}', '${AT}',
			'${options.keyExpiresAt ?? EXPIRES_AT}',
			${options.keyRevoked === true ? `'${AT}'` : 'NULL'}, 0
		);
	`);
	const grantOrganization: string | null =
		options.grantOrganization === undefined ? ORG_A : options.grantOrganization;
	if (grantOrganization !== null) {
		sqlite.exec(`
			INSERT INTO api_key_organization_grant (
				id, api_key_id, organization_id, granted_by_user_id,
				granted_organization_role, granted_at, revoked_at, revoked_by_user_id,
				revoked_by_authority
			) VALUES (
				'${GRANT_ID}', '${KEY_ID}', '${grantOrganization}', '${OWNER_ID}', 'owner', '${AT}',
				${options.grantRevoked === true ? `'${AT}', '${OWNER_ID}', 'key_owner'` : 'NULL, NULL, NULL'}
			)
		`);
	}
	return {
		sqlite,
		platform: { env: { DB: sqliteD1Database(sqlite) } } as unknown as App.Platform,
		token: issued.token
	};
}

interface Outcome {
	locals: App.Locals;
	cookieReads: string[];
}

async function runHandle(
	fixture: Fixture,
	input: {
		pathname?: string;
		authorization?: string | null;
		organization?: string | null;
		sessionCookie?: string;
	} = {}
): Promise<Outcome> {
	const pathname: string = input.pathname ?? '/api/v1/envelopes';
	const url: URL = new URL(`https://signkit.example${pathname}`);
	const headers: Headers = new Headers();
	if (input.authorization !== undefined && input.authorization !== null) {
		headers.set('authorization', input.authorization);
	}
	if (input.organization !== undefined && input.organization !== null) {
		headers.set(SIGNKIT_ORGANIZATION_HEADER, input.organization);
	}
	const cookieReads: string[] = [];
	const locals: Partial<App.Locals> = {};
	const event = {
		locals,
		url,
		platform: fixture.platform,
		request: new Request(url, { headers }),
		cookies: {
			get: (name: string): string | undefined => {
				cookieReads.push(name);
				return input.sessionCookie;
			},
			set: (): void => undefined,
			delete: (): void => undefined
		}
	} as unknown as RequestEvent;

	// The two handles are composed manually rather than through the exported
	// `sequence(...)`, which requires SvelteKit's internal per-request store. The
	// order is the same one `handle` installs, and it is the order the
	// bearer-exclusivity rule depends on: API key resolution must run before the
	// cookie session so the session can be skipped.
	await handleApiKeyAuthentication({
		event,
		resolve: async (sessionEvent: RequestEvent): Promise<Response> =>
			handleSession({
				event: sessionEvent,
				resolve: async (): Promise<Response> => new Response('ok')
			} as unknown as Parameters<typeof handleSession>[0]) as Promise<Response>
	} as unknown as Parameters<typeof handleApiKeyAuthentication>[0]);

	return { locals: event.locals, cookieReads };
}

describe('hooks API key authentication (real D1 store)', () => {
	it('authenticates a live key holding a live grant for the requested organization', async () => {
		const fixture: Fixture = await createFixture();
		try {
			const outcome: Outcome = await runHandle(fixture, {
				authorization: `Bearer ${fixture.token}`,
				organization: ORG_A
			});

			expect(outcome.locals.apiKeyAuthentication).toEqual({
				state: 'authenticated',
				principal: {
					apiKeyId: KEY_ID,
					keyPrefix: expect.stringMatching(/^signkit_/) as unknown as string,
					ownerUserId: OWNER_ID,
					organizationId: ORG_A,
					organizationName: 'Alpha',
					scopes: ['envelopes:read'],
					expiresAt: EXPIRES_AT
				}
			});
		} finally {
			fixture.sqlite.close();
		}
	});

	/**
	 * Tenant isolation end to end: the grant is for organization A, so naming B is
	 * refused even though the key and owner are perfectly live.
	 */
	it('refuses an organization the key was never granted', async () => {
		const fixture: Fixture = await createFixture();
		try {
			const outcome: Outcome = await runHandle(fixture, {
				authorization: `Bearer ${fixture.token}`,
				organization: ORG_B
			});
			expect(outcome.locals.apiKeyAuthentication).toEqual({
				state: 'organization_grant_required'
			});
		} finally {
			fixture.sqlite.close();
		}
	});

	it('requires the organization selector and never infers the only grant', async () => {
		const fixture: Fixture = await createFixture();
		try {
			const outcome: Outcome = await runHandle(fixture, {
				authorization: `Bearer ${fixture.token}`
			});
			expect(outcome.locals.apiKeyAuthentication).toEqual({
				state: 'organization_selector_invalid'
			});
		} finally {
			fixture.sqlite.close();
		}
	});

	it.each([
		['a revoked key', { keyRevoked: true }],
		['a suspended owner', { memberStatus: 'suspended' as const }],
		['an expired key', { keyExpiresAt: ALREADY_EXPIRED_AT }]
	])('answers %s with the opaque invalid-token state', async (_name, options) => {
		const fixture: Fixture = await createFixture(options);
		try {
			const outcome: Outcome = await runHandle(fixture, {
				authorization: `Bearer ${fixture.token}`,
				organization: ORG_A
			});
			expect(outcome.locals.apiKeyAuthentication).toEqual({ state: 'invalid_token' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('answers a revoked grant with the grant-required state', async () => {
		const fixture: Fixture = await createFixture({ grantRevoked: true });
		try {
			const outcome: Outcome = await runHandle(fixture, {
				authorization: `Bearer ${fixture.token}`,
				organization: ORG_A
			});
			expect(outcome.locals.apiKeyAuthentication).toEqual({
				state: 'organization_grant_required'
			});
		} finally {
			fixture.sqlite.close();
		}
	});

	it.each([
		['a recipient capability', `Bearer skr1_${'a'.repeat(43)}`],
		['a completion access grant', `Bearer skca1_${'a'.repeat(43)}`],
		['an instance invitation token', `Bearer ski1_${'a'.repeat(43)}`],
		['a deployment worker secret', `Bearer ${'x'.repeat(48)}`],
		['a Basic credential', 'Basic dXNlcjpwYXNz']
	])('answers %s with the same opaque invalid-token state', async (_name, authorization) => {
		const fixture: Fixture = await createFixture();
		try {
			const outcome: Outcome = await runHandle(fixture, {
				authorization,
				organization: ORG_A
			});
			expect(outcome.locals.apiKeyAuthentication).toEqual({ state: 'invalid_token' });
		} finally {
			fixture.sqlite.close();
		}
	});

	/**
	 * Bearer exclusivity, proven by observation rather than by inspection: the
	 * session cookie is never even read once a bearer has been presented, so there
	 * is no path by which an attacker-supplied bearer could ride a victim session.
	 */
	it('never reads the session cookie once a bearer is presented', async () => {
		const fixture: Fixture = await createFixture();
		try {
			const authenticated: Outcome = await runHandle(fixture, {
				authorization: `Bearer ${fixture.token}`,
				organization: ORG_A,
				sessionCookie: 'sealed-session'
			});
			expect(authenticated.cookieReads).toEqual([]);
			expect(authenticated.locals.principal).toBeNull();
			expect(authenticated.locals.identityState).toBe('anonymous');
			expect(authenticated.locals.organizationId).toBeNull();

			const rejected: Outcome = await runHandle(fixture, {
				authorization: 'Basic dXNlcjpwYXNz',
				organization: ORG_A,
				sessionCookie: 'sealed-session'
			});
			expect(rejected.cookieReads).toEqual([]);
			expect(rejected.locals.principal).toBeNull();
			expect(rejected.locals.identityState).toBe('anonymous');
		} finally {
			fixture.sqlite.close();
		}
	});

	it('still resolves the cookie session when no bearer is presented', async () => {
		const fixture: Fixture = await createFixture();
		try {
			const outcome: Outcome = await runHandle(fixture, { sessionCookie: undefined });
			expect(outcome.cookieReads).toContain('signkit_session');
			expect(outcome.locals.apiKeyAuthentication).toEqual({ state: 'absent' });
		} finally {
			fixture.sqlite.close();
		}
	});

	/**
	 * Management surfaces refuse a well-formed key outright and never resolve it,
	 * so there is no authority to inherit and -- critically -- no cookie either:
	 * the refusal suppresses the session for the whole request, closing the
	 * escalation path where a key rides a cookie into minting another key,
	 * granting itself an organization, or administering members.
	 */
	it.each([
		'/api/v1/api-keys',
		`/api/v1/api-keys/${KEY_ID}/revoke`,
		`/api/v1/api-keys/${KEY_ID}/organization-grants`,
		'/api/v1/instance/members',
		'/api/v1/instance/members/me',
		'/api/v1/instance/invitations'
	])('rejects a live API key outright on %s and reads no cookie', async (pathname) => {
		const fixture: Fixture = await createFixture();
		try {
			const outcome: Outcome = await runHandle(fixture, {
				pathname,
				authorization: `Bearer ${fixture.token}`,
				organization: ORG_A,
				sessionCookie: 'sealed-session'
			});

			expect(outcome.locals.apiKeyAuthentication).toEqual({ state: 'rejected_surface' });
			expect(outcome.cookieReads).toEqual([]);
			expect(outcome.locals.principal).toBeNull();
			expect(outcome.locals.identityState).toBe('anonymous');
		} finally {
			fixture.sqlite.close();
		}
	});

	/**
	 * The exemption, proven rather than assumed: bootstrap's `Authorization` header
	 * is its own deployment secret, so an API-key-shaped value there stays outside
	 * this slice entirely and that endpoint's constant-time secret gate still runs.
	 */
	it('leaves the bootstrap deployment-secret flow untouched', async () => {
		const fixture: Fixture = await createFixture();
		try {
			const outcome: Outcome = await runHandle(fixture, {
				pathname: '/api/v1/instance/bootstrap',
				authorization: `Bearer ${fixture.token}`,
				sessionCookie: 'sealed-session'
			});

			expect(outcome.locals.apiKeyAuthentication).toEqual({ state: 'absent' });
			expect(outcome.cookieReads).toContain('signkit_session');
		} finally {
			fixture.sqlite.close();
		}
	});

	/**
	 * Only a well-formed `signkit_` value is rejected on a management surface.
	 * Anything else is not an API key and keeps that endpoint's prior handling.
	 */
	it('leaves a foreign credential family alone on a management surface', async () => {
		const fixture: Fixture = await createFixture();
		try {
			const outcome: Outcome = await runHandle(fixture, {
				pathname: '/api/v1/api-keys',
				authorization: `Bearer skr1_${'a'.repeat(43)}`,
				sessionCookie: 'sealed-session'
			});

			expect(outcome.locals.apiKeyAuthentication).toEqual({ state: 'absent' });
			expect(outcome.cookieReads).toContain('signkit_session');
		} finally {
			fixture.sqlite.close();
		}
	});

	it('reports an unconfigured durable store as unavailable rather than absent', async () => {
		const fixture: Fixture = await createFixture();
		try {
			const outcome: Outcome = await runHandle(
				{ ...fixture, platform: { env: {} } as unknown as App.Platform },
				{ authorization: `Bearer ${fixture.token}`, organization: ORG_A }
			);
			expect(outcome.locals.apiKeyAuthentication).toEqual({ state: 'unavailable' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('resolves each granted organization independently for a multi-organization key', async () => {
		const fixture: Fixture = await createFixture();
		try {
			fixture.sqlite.exec(`
				INSERT INTO api_key_organization_grant (
					id, api_key_id, organization_id, granted_by_user_id,
					granted_organization_role, granted_at
				) VALUES (
					'01900000-0000-7000-8000-000000000302', '${KEY_ID}', '${ORG_B}', '${OWNER_ID}',
					'admin', '${AT}'
				)
			`);

			const alpha: Outcome = await runHandle(fixture, {
				authorization: `Bearer ${fixture.token}`,
				organization: ORG_A
			});
			const beta: Outcome = await runHandle(fixture, {
				authorization: `Bearer ${fixture.token}`,
				organization: ORG_B
			});

			expect(
				alpha.locals.apiKeyAuthentication.state === 'authenticated' &&
					alpha.locals.apiKeyAuthentication.principal.organizationId
			).toBe(ORG_A);
			expect(
				beta.locals.apiKeyAuthentication.state === 'authenticated' &&
					beta.locals.apiKeyAuthentication.principal.organizationId
			).toBe(ORG_B);
		} finally {
			fixture.sqlite.close();
		}
	});
});
