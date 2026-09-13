import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AuthenticateApiKeyResult } from '$lib/ports/api-key-authentication-store';
import { hashApiKey, issueApiKey, type IssuedApiKey } from '$lib/security/api-key';
import { D1ApiKeyAuthenticationStore } from './d1-api-key-authentication-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const OWNER_ID: string = 'user-1';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const OTHER_KEY_ID: string = '01900000-0000-7000-8000-000000000202';
const GRANT_ID: string = '01900000-0000-7000-8000-000000000301';
const OTHER_GRANT_ID: string = '01900000-0000-7000-8000-000000000302';
const ORG_A: string = 'org-alpha';
const ORG_B: string = 'org-beta';
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const EXPIRES_AT: string = '2026-12-11T12:00:00.000Z';
const NOW: string = '2026-09-13T00:00:00.000Z';

interface Fixture {
	store: D1ApiKeyAuthenticationStore;
	sqlite: DatabaseSync;
	token: string;
	tokenHash: string;
}

async function createFixture(
	options: {
		memberStatus?: 'active' | 'suspended';
		keyRevokedAt?: string | null;
		keyExpiresAt?: string;
		scopesJson?: string;
		grantOrganization?: string | null;
		grantRevoked?: boolean;
		projectOrganizations?: readonly string[];
	} = {}
): Promise<Fixture> {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const issued: IssuedApiKey = await issueApiKey();

	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${OWNER_ID}', 'member', '${options.memberStatus ?? 'active'}', '${CREATED_AT}', '${CREATED_AT}')
	`);
	for (const organizationId of options.projectOrganizations ?? [ORG_A, ORG_B]) {
		sqlite.exec(`
			INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES ('${organizationId}', '${organizationId}', 'Name of ${organizationId}', '${CREATED_AT}')
		`);
	}
	sqlite.exec(`
		INSERT INTO api_key (
			id, name, token_hash, key_prefix, scopes_json, owner_user_id,
			created_at, expires_at, revoked_at, rate_window_count
		) VALUES (
			'${KEY_ID}', 'CI agent', '${issued.tokenHash}', '${issued.keyPrefix}',
			'${options.scopesJson ?? '["envelopes:read"]'}', '${OWNER_ID}',
			'${CREATED_AT}', '${options.keyExpiresAt ?? EXPIRES_AT}',
			${options.keyRevokedAt === undefined || options.keyRevokedAt === null ? 'NULL' : `'${options.keyRevokedAt}'`},
			0
		)
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
				'${GRANT_ID}', '${KEY_ID}', '${grantOrganization}', '${OWNER_ID}', 'owner',
				'${CREATED_AT}',
				${options.grantRevoked === true ? `'${CREATED_AT}', '${OWNER_ID}', 'key_owner'` : 'NULL, NULL, NULL'}
			)
		`);
	}

	return {
		store: new D1ApiKeyAuthenticationStore(sqliteD1Database(sqlite)),
		sqlite,
		token: issued.token,
		tokenHash: issued.tokenHash
	};
}

async function authenticate(
	fixture: Fixture,
	organizationId: string = ORG_A,
	at: string = NOW
): Promise<AuthenticateApiKeyResult> {
	return fixture.store.authenticateApiKey({
		tokenHash: fixture.tokenHash,
		organizationId,
		at
	});
}

interface StubRow {
	api_key_id: string;
	key_prefix: string;
	owner_user_id: string;
	scopes_json: string;
	expires_at: string;
	grant_id: string | null;
	grant_organization_id: string | null;
	organization_id: string | null;
	organization_name: string | null;
}

/**
 * Minimal D1 stand-in returning a fixed snapshot, for the integrity branches the
 * real schema makes unreachable.
 */
interface StubStatement {
	bind: () => StubStatement;
	all: () => Promise<{ results: readonly StubRow[] }>;
}

function stubD1Database(rows: readonly StubRow[]): D1Database {
	const statement: StubStatement = {
		bind: (): StubStatement => statement,
		all: async (): Promise<{ results: readonly StubRow[] }> => ({ results: rows })
	};
	return { prepare: (): StubStatement => statement } as unknown as D1Database;
}

describe('D1ApiKeyAuthenticationStore', () => {
	it('resolves a live key with a live grant into an organization-scoped principal', async () => {
		const fixture: Fixture = await createFixture();
		try {
			const result: AuthenticateApiKeyResult = await authenticate(fixture);

			expect(result).toEqual({
				outcome: 'authenticated',
				principal: {
					apiKeyId: KEY_ID,
					keyPrefix: expect.stringMatching(/^signkit_/) as unknown as string,
					ownerUserId: OWNER_ID,
					organizationId: ORG_A,
					organizationName: `Name of ${ORG_A}`,
					scopes: ['envelopes:read'],
					expiresAt: EXPIRES_AT
				}
			});
		} finally {
			fixture.sqlite.close();
		}
	});

	/**
	 * The core tenant isolation property: a key granted organization A presenting
	 * organization B is refused, even though the key itself is perfectly live. The
	 * grant is per-organization, so authority never spills sideways.
	 */
	it('refuses an organization the key holds no grant for', async () => {
		const fixture: Fixture = await createFixture();
		try {
			expect(await authenticate(fixture, ORG_B)).toEqual({
				outcome: 'organization_grant_required'
			});
		} finally {
			fixture.sqlite.close();
		}
	});

	it('never infers the only grant when a different organization was requested', async () => {
		// The key's single live grant is organization A. Requesting B must fail
		// rather than fall back to "the only one it has".
		const fixture: Fixture = await createFixture({ grantOrganization: ORG_A });
		try {
			expect((await authenticate(fixture, ORG_B)).outcome).toBe('organization_grant_required');
		} finally {
			fixture.sqlite.close();
		}
	});

	it('reaches exactly the requested organization when several are granted', async () => {
		const fixture: Fixture = await createFixture();
		try {
			fixture.sqlite.exec(`
				INSERT INTO api_key_organization_grant (
					id, api_key_id, organization_id, granted_by_user_id,
					granted_organization_role, granted_at
				) VALUES (
					'${OTHER_GRANT_ID}', '${KEY_ID}', '${ORG_B}', '${OWNER_ID}', 'admin', '${CREATED_AT}'
				)
			`);

			const alpha: AuthenticateApiKeyResult = await authenticate(fixture, ORG_A);
			const beta: AuthenticateApiKeyResult = await authenticate(fixture, ORG_B);

			expect(alpha.outcome === 'authenticated' && alpha.principal.organizationId).toBe(ORG_A);
			expect(beta.outcome === 'authenticated' && beta.principal.organizationId).toBe(ORG_B);
		} finally {
			fixture.sqlite.close();
		}
	});

	it('refuses a revoked grant while the key itself stays live', async () => {
		const fixture: Fixture = await createFixture({ grantRevoked: true });
		try {
			expect(await authenticate(fixture)).toEqual({ outcome: 'organization_grant_required' });
		} finally {
			fixture.sqlite.close();
		}
	});

	/**
	 * Every case below must be indistinguishable from the others and from an
	 * unknown token, so the endpoint cannot be used as an existence or status
	 * oracle for a credential the caller does not already hold.
	 */
	it('reports an unknown token hash opaquely', async () => {
		const fixture: Fixture = await createFixture();
		try {
			expect(
				await fixture.store.authenticateApiKey({
					tokenHash: await hashApiKey(`signkit_${'z'.repeat(43)}`),
					organizationId: ORG_A,
					at: NOW
				})
			).toEqual({ outcome: 'invalid_token' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('reports a revoked key opaquely', async () => {
		const fixture: Fixture = await createFixture({ keyRevokedAt: CREATED_AT });
		try {
			expect(await authenticate(fixture)).toEqual({ outcome: 'invalid_token' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('reports an expired key opaquely', async () => {
		const fixture: Fixture = await createFixture({
			keyExpiresAt: '2026-09-12T18:00:00.000Z'
		});
		try {
			expect(await authenticate(fixture)).toEqual({ outcome: 'invalid_token' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('treats expiry as strictly in the future at the exact boundary instant', async () => {
		const fixture: Fixture = await createFixture({ keyExpiresAt: NOW });
		try {
			expect(await authenticate(fixture, ORG_A, NOW)).toEqual({ outcome: 'invalid_token' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('reports a suspended owner opaquely', async () => {
		const fixture: Fixture = await createFixture({ memberStatus: 'suspended' });
		try {
			expect(await authenticate(fixture)).toEqual({ outcome: 'invalid_token' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('stops authenticating the instant the owner is suspended', async () => {
		const fixture: Fixture = await createFixture();
		try {
			expect((await authenticate(fixture)).outcome).toBe('authenticated');
			fixture.sqlite.exec(
				`UPDATE instance_member SET status = 'suspended', updated_at = '${NOW}'
				 WHERE user_id = '${OWNER_ID}'`
			);
			expect(await authenticate(fixture)).toEqual({ outcome: 'invalid_token' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('stops authenticating the instant the grant is revoked', async () => {
		const fixture: Fixture = await createFixture();
		try {
			expect((await authenticate(fixture)).outcome).toBe('authenticated');
			fixture.sqlite.exec(
				`UPDATE api_key_organization_grant
				 SET revoked_at = '${NOW}', revoked_by_user_id = '${OWNER_ID}',
					 revoked_by_authority = 'organization_admin'
				 WHERE id = '${GRANT_ID}'`
			);
			expect(await authenticate(fixture)).toEqual({ outcome: 'organization_grant_required' });
		} finally {
			fixture.sqlite.close();
		}
	});

	/**
	 * `api_key_scopes_canonical` makes drifted scopes unreachable through SQL, so
	 * this branch is proven against a stubbed snapshot instead. It matters because
	 * scope drift must never be silently narrowed to a usable subset -- the adapter
	 * has to refuse outright.
	 */
	it.each([
		['a duplicated scope', '["envelopes:read","envelopes:read"]'],
		['a reordered serialization', '["envelopes:read","audit:read"]'],
		['a re-spaced serialization', '["envelopes:read", "audit:read"]'],
		['an empty array', '[]'],
		['an unknown scope', '["envelopes:delete"]'],
		['a non-array value', '"envelopes:read"'],
		['unparsable JSON', 'not-json']
	])('fails closed when stored scopes are %s', async (_name, scopesJson) => {
		const store = new D1ApiKeyAuthenticationStore(
			stubD1Database([
				{
					api_key_id: KEY_ID,
					key_prefix: 'signkit_abcdefgh',
					owner_user_id: OWNER_ID,
					scopes_json: scopesJson,
					expires_at: EXPIRES_AT,
					grant_id: GRANT_ID,
					grant_organization_id: ORG_A,
					organization_id: ORG_A,
					organization_name: 'Alpha'
				}
			])
		);

		expect(
			await store.authenticateApiKey({ tokenHash: 'a'.repeat(64), organizationId: ORG_A, at: NOW })
		).toEqual({ outcome: 'integrity_error' });
	});

	it('fails closed when a granted organization has no projection row', async () => {
		const fixture: Fixture = await createFixture();
		try {
			// The grant's foreign key normally guarantees the projection exists, so it
			// is removed with foreign keys disabled to prove the adapter refuses
			// rather than trusting the join to have produced a name.
			fixture.sqlite.exec('PRAGMA foreign_keys = OFF');
			fixture.sqlite.exec(`DELETE FROM organization WHERE id = '${ORG_A}'`);

			expect(await authenticate(fixture, ORG_A)).toEqual({ outcome: 'integrity_error' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('fails closed when more than one live grant exists for the same pair', async () => {
		const fixture: Fixture = await createFixture();
		try {
			// `api_key_organization_grant_live` forbids this; dropping it proves the
			// adapter refuses to pick one arbitrarily if the invariant is ever
			// bypassed.
			fixture.sqlite.exec('DROP INDEX api_key_organization_grant_live');
			fixture.sqlite.exec(`
				INSERT INTO api_key_organization_grant (
					id, api_key_id, organization_id, granted_by_user_id,
					granted_organization_role, granted_at
				) VALUES (
					'${OTHER_GRANT_ID}', '${KEY_ID}', '${ORG_A}', '${OWNER_ID}', 'admin', '${CREATED_AT}'
				)
			`);

			expect(await authenticate(fixture)).toEqual({ outcome: 'integrity_error' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('never resolves a grant belonging to another key', async () => {
		const fixture: Fixture = await createFixture({ grantOrganization: null });
		try {
			const other: IssuedApiKey = await issueApiKey();
			fixture.sqlite.exec(`
				INSERT INTO api_key (
					id, name, token_hash, key_prefix, scopes_json, owner_user_id,
					created_at, expires_at, rate_window_count
				) VALUES (
					'${OTHER_KEY_ID}', 'Other agent', '${other.tokenHash}', '${other.keyPrefix}',
					'["envelopes:read"]', '${OWNER_ID}', '${CREATED_AT}', '${EXPIRES_AT}', 0
				);
				INSERT INTO api_key_organization_grant (
					id, api_key_id, organization_id, granted_by_user_id,
					granted_organization_role, granted_at
				) VALUES (
					'${GRANT_ID}', '${OTHER_KEY_ID}', '${ORG_A}', '${OWNER_ID}', 'owner', '${CREATED_AT}'
				)
			`);

			expect(await authenticate(fixture)).toEqual({ outcome: 'organization_grant_required' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('looks the key up by token hash and never by its display prefix', async () => {
		const fixture: Fixture = await createFixture();
		try {
			// A prefix is shared display material by design. Passing one where a hash
			// belongs must resolve nothing.
			expect(
				await fixture.store.authenticateApiKey({
					tokenHash: 'signkit_abcdefgh',
					organizationId: ORG_A,
					at: NOW
				})
			).toEqual({ outcome: 'invalid_token' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('returns no token or hash material in the principal', async () => {
		const fixture: Fixture = await createFixture();
		try {
			const result: AuthenticateApiKeyResult = await authenticate(fixture);
			const serialized: string = JSON.stringify(result);

			expect(serialized).not.toContain(fixture.token);
			expect(serialized).not.toContain(fixture.tokenHash);
		} finally {
			fixture.sqlite.close();
		}
	});
});
