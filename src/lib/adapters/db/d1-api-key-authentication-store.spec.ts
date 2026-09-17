import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AuthenticateApiKeyResult } from '$lib/ports/api-key-authentication-store';
import {
	API_KEY_RATE_WINDOW_MAX_REQUESTS,
	hashApiKey,
	issueApiKey,
	type IssuedApiKey
} from '$lib/security/api-key';
import { D1ApiKeyAuthenticationStore } from './d1-api-key-authentication-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const OWNER_ID: string = 'user-1';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const OTHER_KEY_ID: string = '01900000-0000-7000-8000-000000000202';
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
		rateWindowStartedAt?: string | null;
		rateWindowCount?: number;
	} = {}
): Promise<Fixture> {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const issued: IssuedApiKey = await issueApiKey();

	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${OWNER_ID}', 'member', '${options.memberStatus ?? 'active'}', '${CREATED_AT}', '${CREATED_AT}')
	`);
	sqlite.exec(`
		INSERT INTO api_key (
			id, name, token_hash, key_prefix, scopes_json, owner_user_id,
			created_at, expires_at, revoked_at, rate_window_started_at, rate_window_count
		) VALUES (
			'${KEY_ID}', 'CI agent', '${issued.tokenHash}', '${issued.keyPrefix}',
			'${options.scopesJson ?? '["envelopes:read"]'}', '${OWNER_ID}',
			'${CREATED_AT}', '${options.keyExpiresAt ?? EXPIRES_AT}',
			${options.keyRevokedAt === undefined || options.keyRevokedAt === null ? 'NULL' : `'${options.keyRevokedAt}'`},
			${options.rateWindowStartedAt === undefined || options.rateWindowStartedAt === null ? 'NULL' : `'${options.rateWindowStartedAt}'`},
			${options.rateWindowCount ?? 0}
		)
	`);

	return {
		store: new D1ApiKeyAuthenticationStore(sqliteD1Database(sqlite)),
		sqlite,
		token: issued.token,
		tokenHash: issued.tokenHash
	};
}

async function authenticate(fixture: Fixture, at: string = NOW): Promise<AuthenticateApiKeyResult> {
	return fixture.store.authenticateApiKey({
		tokenHash: fixture.tokenHash,
		at
	});
}

interface StubRow {
	api_key_id: string;
	key_prefix: string;
	owner_user_id: string;
	scopes_json: string;
	expires_at: string;
}

/**
 * Minimal D1 stand-in returning a fixed snapshot, for the integrity branches the
 * real schema makes unreachable.
 */
interface StubStatement {
	bind: () => StubStatement;
	all: () => Promise<{ results: readonly StubRow[] }>;
	run: () => Promise<{ meta: { changes: number } }>;
}

function stubD1Database(rows: readonly StubRow[]): D1Database {
	const statement: StubStatement = {
		bind: (): StubStatement => statement,
		all: async (): Promise<{ results: readonly StubRow[] }> => ({ results: rows }),
		run: async (): Promise<{ meta: { changes: number } }> => ({ meta: { changes: 1 } })
	};
	return { prepare: (): StubStatement => statement } as unknown as D1Database;
}

describe('D1ApiKeyAuthenticationStore', () => {
	it('resolves a live key into an instance-wide principal', async () => {
		const fixture: Fixture = await createFixture();
		try {
			const result: AuthenticateApiKeyResult = await authenticate(fixture);

			expect(result).toEqual({
				outcome: 'authenticated',
				principal: {
					apiKeyId: KEY_ID,
					keyPrefix: expect.stringMatching(/^signkit_/) as unknown as string,
					ownerUserId: OWNER_ID,
					scopes: ['envelopes:read'],
					expiresAt: EXPIRES_AT
				}
			});
		} finally {
			fixture.sqlite.close();
		}
	});

	it('needs no tenant selector: the same key authenticates on its own', async () => {
		const fixture: Fixture = await createFixture();
		try {
			// The query carries only the token hash and the instant. There is no
			// per-request tenant to name: one deployment database is the sole
			// instance boundary.
			const result: AuthenticateApiKeyResult = await fixture.store.authenticateApiKey({
				tokenHash: fixture.tokenHash,
				at: NOW
			});
			expect(result.outcome).toBe('authenticated');
			expect(result).not.toHaveProperty('organizationId');
			if (result.outcome === 'authenticated') {
				expect(Object.keys(result.principal).sort()).toEqual([
					'apiKeyId',
					'expiresAt',
					'keyPrefix',
					'ownerUserId',
					'scopes'
				]);
			}
		} finally {
			fixture.sqlite.close();
		}
	});

	it('records key use on authentication', async () => {
		const fixture: Fixture = await createFixture();
		try {
			expect((await authenticate(fixture)).outcome).toBe('authenticated');
			const row = fixture.sqlite
				.prepare('SELECT last_used_at, rate_window_count FROM api_key WHERE id = ?')
				.get(KEY_ID) as { last_used_at: string; rate_window_count: number };
			expect(row.last_used_at).toBe(NOW);
			expect(row.rate_window_count).toBe(1);
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
			expect(await authenticate(fixture, NOW)).toEqual({ outcome: 'invalid_token' });
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

	it('stops authenticating the instant the key is revoked', async () => {
		const fixture: Fixture = await createFixture();
		try {
			expect((await authenticate(fixture)).outcome).toBe('authenticated');
			fixture.sqlite.exec(`UPDATE api_key SET revoked_at = '${NOW}' WHERE id = '${KEY_ID}'`);
			expect(await authenticate(fixture)).toEqual({ outcome: 'invalid_token' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('authenticates each key independently of the others', async () => {
		const fixture: Fixture = await createFixture();
		try {
			const other: IssuedApiKey = await issueApiKey();
			fixture.sqlite.exec(`
				INSERT INTO api_key (
					id, name, token_hash, key_prefix, scopes_json, owner_user_id,
					created_at, expires_at, rate_window_count
				) VALUES (
					'${OTHER_KEY_ID}', 'Other agent', '${other.tokenHash}', '${other.keyPrefix}',
					'["drafts:write"]', '${OWNER_ID}', '${CREATED_AT}', '${EXPIRES_AT}', 0
				)
			`);

			const second: AuthenticateApiKeyResult = await fixture.store.authenticateApiKey({
				tokenHash: other.tokenHash,
				at: NOW
			});
			expect(second).toEqual({
				outcome: 'authenticated',
				principal: {
					apiKeyId: OTHER_KEY_ID,
					keyPrefix: other.keyPrefix,
					ownerUserId: OWNER_ID,
					scopes: ['drafts:write'],
					expiresAt: EXPIRES_AT
				}
			});

			// Revoking the first key leaves the second usable: liveness is
			// evaluated per key, never per owner.
			fixture.sqlite.exec(`UPDATE api_key SET revoked_at = '${NOW}' WHERE id = '${KEY_ID}'`);
			expect(await authenticate(fixture)).toEqual({ outcome: 'invalid_token' });
			expect(
				(await fixture.store.authenticateApiKey({ tokenHash: other.tokenHash, at: NOW })).outcome
			).toBe('authenticated');
		} finally {
			fixture.sqlite.close();
		}
	});

	it('refuses an authenticated key whose durable window is exhausted', async () => {
		const fixture: Fixture = await createFixture({
			rateWindowStartedAt: NOW,
			rateWindowCount: API_KEY_RATE_WINDOW_MAX_REQUESTS
		});
		try {
			// The key, owner, and scopes are all live: only the per-key window is
			// spent, so this is rate_limited rather than the opaque invalid_token.
			expect(await authenticate(fixture)).toEqual({ outcome: 'rate_limited' });
		} finally {
			fixture.sqlite.close();
		}
	});

	it('authenticates again once the rate window has rolled over', async () => {
		const fixture: Fixture = await createFixture({
			rateWindowStartedAt: NOW,
			rateWindowCount: API_KEY_RATE_WINDOW_MAX_REQUESTS
		});
		try {
			expect(await authenticate(fixture)).toEqual({ outcome: 'rate_limited' });
			const afterWindow: string = new Date(Date.parse(NOW) + 61_000).toISOString();
			const result: AuthenticateApiKeyResult = await authenticate(fixture, afterWindow);
			expect(result.outcome).toBe('authenticated');
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
		['a reordered serialization', '["envelopes:send","drafts:write"]'],
		['a re-spaced serialization', '["drafts:write", "envelopes:send"]'],
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
					expires_at: EXPIRES_AT
				}
			])
		);

		expect(await store.authenticateApiKey({ tokenHash: 'a'.repeat(64), at: NOW })).toEqual({
			outcome: 'integrity_error'
		});
	});

	it('fails closed when more than one row shares the token hash', async () => {
		// The unique token_hash index forbids this; a duplicated snapshot proves
		// the adapter refuses to pick one arbitrarily if the invariant is ever
		// bypassed.
		const row: StubRow = {
			api_key_id: KEY_ID,
			key_prefix: 'signkit_abcdefgh',
			owner_user_id: OWNER_ID,
			scopes_json: '["envelopes:read"]',
			expires_at: EXPIRES_AT
		};
		const store = new D1ApiKeyAuthenticationStore(stubD1Database([row, row]));

		expect(await store.authenticateApiKey({ tokenHash: 'a'.repeat(64), at: NOW })).toEqual({
			outcome: 'integrity_error'
		});
	});

	it('looks the key up by token hash and never by its display prefix', async () => {
		const fixture: Fixture = await createFixture();
		try {
			// A prefix is shared display material by design. Passing one where a hash
			// belongs must resolve nothing.
			expect(
				await fixture.store.authenticateApiKey({
					tokenHash: 'signkit_abcdefgh',
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
