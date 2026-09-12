import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type {
	CreateApiKeyCommand,
	CreateApiKeyStoreResult,
	ListApiKeyStoreResult,
	RevokeApiKeyCommand,
	RevokeApiKeyStoreResult,
	ApiKeyListPage,
	ApiKeyMetadata
} from '$lib/ports/api-key-store';
import { issueApiKey, type IssuedApiKey } from '$lib/security/api-key';
import { D1ApiKeyStore } from './d1-api-key-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ACTOR_ID: string = 'user-1';
const OTHER_ACTOR_ID: string = 'user-2';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const OTHER_KEY_ID: string = '01900000-0000-7000-8000-000000000202';
const THIRD_KEY_ID: string = '01900000-0000-7000-8000-000000000203';
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const EXPIRES_AT: string = '2026-12-11T12:00:00.000Z';
const REVOKED_AT: string = '2026-09-12T13:00:00.000Z';
const REQUEST_HASH: string = 'a'.repeat(64);
const OTHER_REQUEST_HASH: string = 'b'.repeat(64);

type MemberStatus = 'invited' | 'active' | 'suspended';

interface Fixture {
	store: D1ApiKeyStore;
	sqlite: DatabaseSync;
}

function createFixture(): Fixture {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	insertMember(sqlite, ACTOR_ID, 'active');
	return { store: new D1ApiKeyStore(sqliteD1Database(sqlite)), sqlite };
}

function insertMember(
	sqlite: DatabaseSync,
	userId: string,
	status: MemberStatus,
	at: string = CREATED_AT
): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, status, created_at, updated_at)
		VALUES ('${userId}', '${status}', '${at}', '${at}')
	`);
}

function setMemberStatus(sqlite: DatabaseSync, userId: string, status: MemberStatus): void {
	sqlite.exec(`UPDATE instance_member SET status = '${status}', updated_at = '${REVOKED_AT}'
		WHERE user_id = '${userId}'`);
}

async function createCommand(
	overrides: Partial<CreateApiKeyCommand> = {}
): Promise<CreateApiKeyCommand> {
	const issued: IssuedApiKey = await issueApiKey();
	return {
		actor: { type: 'user', id: ACTOR_ID },
		idempotencyKey: 'create-1',
		requestFingerprint: REQUEST_HASH,
		apiKeyId: KEY_ID,
		name: 'CI agent',
		scopes: ['audit:read', 'envelopes:send'],
		tokenHash: issued.tokenHash,
		keyPrefix: issued.keyPrefix,
		createdAt: CREATED_AT,
		expiresAt: EXPIRES_AT,
		...overrides
	};
}

function revokeCommand(overrides: Partial<RevokeApiKeyCommand> = {}): RevokeApiKeyCommand {
	return {
		actor: { type: 'user', id: ACTOR_ID },
		idempotencyKey: 'revoke-1',
		requestFingerprint: REQUEST_HASH,
		apiKeyId: KEY_ID,
		revokedAt: REVOKED_AT,
		...overrides
	};
}

function count(sqlite: DatabaseSync, sql: string): number {
	return Number((sqlite.prepare(sql).get() as { value: number }).value);
}

function keyId(item: ApiKeyMetadata): string {
	return item.id;
}

/**
 * Records the shape of every batch the store issues, as the kind of each
 * statement in order, so a test can assert that authorization and disclosure
 * stayed inside one transaction instead of drifting back into separate reads.
 */
function recordingBatchDatabase(sqlite: DatabaseSync, batches: string[][]): D1Database {
	const real: D1Database = sqliteD1Database(sqlite);
	return {
		prepare: (sql: string): D1PreparedStatement => real.prepare(sql),
		batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
			batches.push(statements.map(statementKind));
			return await real.batch<T>(statements);
		}
	} as unknown as D1Database;
}

/** Names the statements the store batches, so assertions read as intent, not SQL text. */
function statementKind(statement: D1PreparedStatement): string {
	const sql: string = (statement as unknown as { sql: string }).sql.replace(/\s+/g, ' ').trim();
	if (sql.startsWith('SELECT status FROM instance_member')) return 'member-status';
	if (sql.includes('FROM api_key_create_command command')) return 'create-receipt';
	if (sql.includes('FROM api_key_revoke_command command')) return 'revoke-receipt';
	if (sql.startsWith('INSERT INTO api_key (')) return 'key-insert';
	if (sql.startsWith('INSERT INTO api_key_create_command')) return 'create-receipt-insert';
	if (sql.startsWith('INSERT INTO api_key_revoke_command')) return 'revoke-receipt-insert';
	if (sql.startsWith('UPDATE api_key SET revoked_at')) return 'key-revoke-update';
	// Checked before the single-key read, whose shape also appears inside the
	// page statement's cursor subquery.
	if (sql.includes('ORDER BY created_at DESC, id DESC')) return 'owner-page';
	if (sql.includes('FROM api_key WHERE owner_user_id = ? AND id = ?')) return 'owned-key';
	return sql;
}

/**
 * Answers the member status statement with a stale `active` row while the
 * durable row says otherwise, so only a predicate carried inside the page read
 * itself can keep the owner's keys undisclosed.
 */
function staleActiveCheckDatabase(sqlite: DatabaseSync): D1Database {
	const real: D1Database = sqliteD1Database(sqlite);
	return {
		prepare: (sql: string): D1PreparedStatement => real.prepare(sql),
		batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
			const results: D1Result<T>[] = await real.batch<T>(statements);
			return results.map((result: D1Result<T>, index: number): D1Result<T> =>
				index === 0
					? ({ ...result, results: [{ status: 'active' }] } as unknown as D1Result<T>)
					: result
			);
		}
	} as unknown as D1Database;
}

describe('D1ApiKeyStore.createApiKey', () => {
	it('writes the owner-scoped key and receipt in one batch without any plaintext', async () => {
		const { store, sqlite }: Fixture = createFixture();
		const issued: IssuedApiKey = await issueApiKey();
		const command: CreateApiKeyCommand = await createCommand({
			tokenHash: issued.tokenHash,
			keyPrefix: issued.keyPrefix
		});

		const result: CreateApiKeyStoreResult = await store.createApiKey(command);

		expect(result).toEqual({
			outcome: 'created',
			key: {
				id: KEY_ID,
				name: 'CI agent',
				keyPrefix: issued.keyPrefix,
				scopes: ['audit:read', 'envelopes:send'],
				createdAt: CREATED_AT,
				expiresAt: EXPIRES_AT,
				lastUsedAt: null,
				revokedAt: null
			}
		});
		const stored = sqlite
			.prepare(
				`SELECT id, name, token_hash, key_prefix, scopes_json, owner_user_id,
					created_at, expires_at, revoked_at, last_used_at, rate_window_count
				 FROM api_key`
			)
			.all() as Record<string, unknown>[];
		expect(stored).toHaveLength(1);
		expect(stored[0]).toEqual({
			id: KEY_ID,
			name: 'CI agent',
			token_hash: issued.tokenHash,
			key_prefix: issued.keyPrefix,
			scopes_json: '["audit:read","envelopes:send"]',
			owner_user_id: ACTOR_ID,
			created_at: CREATED_AT,
			expires_at: EXPIRES_AT,
			revoked_at: null,
			last_used_at: null,
			rate_window_count: 0
		});
		expect(stored[0]).not.toHaveProperty('organization_id');
		expect(count(sqlite, `SELECT count(*) AS value FROM api_key_create_command`)).toBe(1);
		expect(
			count(sqlite, `SELECT count(*) AS value FROM api_key WHERE token_hash = '${issued.token}'`)
		).toBe(0);
	});

	it('fails closed for a missing, invited, or suspended owner and writes nothing', async () => {
		for (const status of [null, 'invited', 'suspended'] as const) {
			const sqlite: DatabaseSync = new DatabaseSync(':memory:');
			applyD1Migrations(sqlite);
			if (status !== null) insertMember(sqlite, ACTOR_ID, status);
			const store: D1ApiKeyStore = new D1ApiKeyStore(sqliteD1Database(sqlite));
			try {
				const result: CreateApiKeyStoreResult = await store.createApiKey(await createCommand());
				expect(result).toEqual({ outcome: 'owner_not_active' });
				expect(count(sqlite, 'SELECT count(*) AS value FROM api_key')).toBe(0);
				expect(count(sqlite, 'SELECT count(*) AS value FROM api_key_create_command')).toBe(0);
			} finally {
				sqlite.close();
			}
		}
	});

	it('returns already_issued for an exact replay and never mints a second credential', async () => {
		const { store, sqlite }: Fixture = createFixture();
		const first: CreateApiKeyCommand = await createCommand();
		await store.createApiKey(first);
		const replayIssued: IssuedApiKey = await issueApiKey();

		const replay: CreateApiKeyStoreResult = await store.createApiKey(
			await createCommand({
				apiKeyId: OTHER_KEY_ID,
				tokenHash: replayIssued.tokenHash,
				keyPrefix: replayIssued.keyPrefix
			})
		);

		expect(replay).toEqual({
			outcome: 'already_issued',
			key: {
				id: KEY_ID,
				name: 'CI agent',
				keyPrefix: first.keyPrefix,
				scopes: ['audit:read', 'envelopes:send'],
				createdAt: CREATED_AT,
				expiresAt: EXPIRES_AT,
				lastUsedAt: null,
				revokedAt: null
			}
		});
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key')).toBe(1);
		expect(
			count(
				sqlite,
				`SELECT count(*) AS value FROM api_key WHERE token_hash = '${replayIssued.tokenHash}'`
			)
		).toBe(0);
	});

	it('reports the current key metadata on replay, including a later revocation', async () => {
		const { store, sqlite }: Fixture = createFixture();
		const command: CreateApiKeyCommand = await createCommand();
		await store.createApiKey(command);
		await store.revokeApiKey(revokeCommand());

		const replay: CreateApiKeyStoreResult = await store.createApiKey(
			await createCommand({ apiKeyId: OTHER_KEY_ID })
		);

		expect(replay.outcome).toBe('already_issued');
		if (replay.outcome !== 'already_issued') expect.unreachable('replay should be already_issued');
		expect(replay.key.revokedAt).toBe(REVOKED_AT);
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key')).toBe(1);
	});

	it('rejects a reused idempotency key for a different request', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());

		const conflict: CreateApiKeyStoreResult = await store.createApiKey(
			await createCommand({
				apiKeyId: OTHER_KEY_ID,
				requestFingerprint: OTHER_REQUEST_HASH,
				name: 'Other agent'
			})
		);

		expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key')).toBe(1);
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key_create_command')).toBe(1);
	});

	it('treats a receipt that drifted from its key row as a conflict rather than a replay', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());
		sqlite.exec(`UPDATE api_key SET name = 'Renamed agent' WHERE id = '${KEY_ID}'`);

		const replay: CreateApiKeyStoreResult = await store.createApiKey(
			await createCommand({ apiKeyId: OTHER_KEY_ID })
		);

		expect(replay).toEqual({ outcome: 'idempotency_conflict' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key')).toBe(1);
	});

	it('treats a receipt whose key row disappeared as a conflict', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());
		sqlite.exec('PRAGMA foreign_keys = OFF');
		sqlite.exec(`DELETE FROM api_key WHERE id = '${KEY_ID}'`);
		sqlite.exec('PRAGMA foreign_keys = ON');

		const replay: CreateApiKeyStoreResult = await store.createApiKey(
			await createCommand({ apiKeyId: OTHER_KEY_ID })
		);

		expect(replay).toEqual({ outcome: 'idempotency_conflict' });
	});

	it('classifies a credential hash collision without inspecting the provider error', async () => {
		const { store, sqlite }: Fixture = createFixture();
		const first: CreateApiKeyCommand = await createCommand();
		await store.createApiKey(first);

		const collision: CreateApiKeyStoreResult = await store.createApiKey(
			await createCommand({
				idempotencyKey: 'create-2',
				requestFingerprint: OTHER_REQUEST_HASH,
				apiKeyId: OTHER_KEY_ID,
				tokenHash: first.tokenHash
			})
		);

		expect(collision).toEqual({ outcome: 'token_hash_conflict' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key')).toBe(1);
	});

	it('classifies a cross-owner credential hash collision the same way', async () => {
		const { store, sqlite }: Fixture = createFixture();
		insertMember(sqlite, OTHER_ACTOR_ID, 'active');
		const first: CreateApiKeyCommand = await createCommand();
		await store.createApiKey(first);

		const collision: CreateApiKeyStoreResult = await store.createApiKey(
			await createCommand({
				actor: { type: 'user', id: OTHER_ACTOR_ID },
				idempotencyKey: 'create-2',
				apiKeyId: OTHER_KEY_ID,
				tokenHash: first.tokenHash
			})
		);

		expect(collision).toEqual({ outcome: 'token_hash_conflict' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key')).toBe(1);
	});

	it('classifies a generated key id collision', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());

		const collision: CreateApiKeyStoreResult = await store.createApiKey(
			await createCommand({
				idempotencyKey: 'create-2',
				requestFingerprint: OTHER_REQUEST_HASH
			})
		);

		expect(collision).toEqual({ outcome: 'key_id_conflict' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key')).toBe(1);
	});

	it('keeps the same idempotency key independent per owner', async () => {
		const { store, sqlite }: Fixture = createFixture();
		insertMember(sqlite, OTHER_ACTOR_ID, 'active');
		await store.createApiKey(await createCommand());

		const other: CreateApiKeyStoreResult = await store.createApiKey(
			await createCommand({
				actor: { type: 'user', id: OTHER_ACTOR_ID },
				apiKeyId: OTHER_KEY_ID
			})
		);

		expect(other.outcome).toBe('created');
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key')).toBe(2);
		expect(
			count(
				sqlite,
				`SELECT count(*) AS value FROM api_key WHERE owner_user_id = '${OTHER_ACTOR_ID}'`
			)
		).toBe(1);
	});

	it('refuses create replay after the owner is suspended', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());
		setMemberStatus(sqlite, ACTOR_ID, 'suspended');

		await expect(
			store.createApiKey(await createCommand({ apiKeyId: OTHER_KEY_ID }))
		).resolves.toEqual({ outcome: 'owner_not_active' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key')).toBe(1);
	});

	it('resolves the create replay gate in one batch and discloses nothing to a suspended owner', async () => {
		const { sqlite }: Fixture = createFixture();
		const batches: string[][] = [];
		const store: D1ApiKeyStore = new D1ApiKeyStore(recordingBatchDatabase(sqlite, batches));
		const created: CreateApiKeyCommand = await createCommand();
		await store.createApiKey(created);
		setMemberStatus(sqlite, ACTOR_ID, 'suspended');
		batches.length = 0;

		const replay: CreateApiKeyStoreResult = await store.createApiKey(
			await createCommand({ apiKeyId: OTHER_KEY_ID })
		);

		// The membership check and the receipt read are one transaction, so no
		// suspension can commit between authorization and an already_issued
		// disclosure. A second batch here would mean two snapshots again.
		expect(batches).toEqual([['member-status', 'create-receipt']]);
		expect(replay).toEqual({ outcome: 'owner_not_active' });
		expect(JSON.stringify(replay)).not.toContain(created.keyPrefix);
		expect(JSON.stringify(replay)).not.toContain(KEY_ID);
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key')).toBe(1);
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key_create_command')).toBe(1);
	});

	it('writes the key and its receipt in the single batch that follows the gate', async () => {
		const { sqlite }: Fixture = createFixture();
		const batches: string[][] = [];
		const store: D1ApiKeyStore = new D1ApiKeyStore(recordingBatchDatabase(sqlite, batches));

		await expect(store.createApiKey(await createCommand())).resolves.toMatchObject({
			outcome: 'created'
		});

		expect(batches).toEqual([
			['member-status', 'create-receipt'],
			['key-insert', 'create-receipt-insert']
		]);
	});
});

describe('D1ApiKeyStore.listApiKeys', () => {
	async function seedThreeKeys(store: D1ApiKeyStore): Promise<void> {
		await store.createApiKey(
			await createCommand({
				idempotencyKey: 'create-1',
				apiKeyId: KEY_ID,
				name: 'Oldest',
				createdAt: '2026-09-10T12:00:00.000Z',
				expiresAt: '2026-12-09T12:00:00.000Z'
			})
		);
		await store.createApiKey(
			await createCommand({
				idempotencyKey: 'create-2',
				requestFingerprint: OTHER_REQUEST_HASH,
				apiKeyId: OTHER_KEY_ID,
				name: 'Same instant lower id',
				createdAt: '2026-09-11T12:00:00.000Z',
				expiresAt: '2026-12-10T12:00:00.000Z'
			})
		);
		await store.createApiKey(
			await createCommand({
				idempotencyKey: 'create-3',
				requestFingerprint: 'c'.repeat(64),
				apiKeyId: THIRD_KEY_ID,
				name: 'Same instant higher id',
				createdAt: '2026-09-11T12:00:00.000Z',
				expiresAt: '2026-12-10T12:00:00.000Z'
			})
		);
	}

	it('returns a deterministic newest-first page with only the allowlisted fields', async () => {
		const { store }: Fixture = createFixture();
		await seedThreeKeys(store);

		const result: ListApiKeyStoreResult = await store.listApiKeys(
			{ type: 'user', id: ACTOR_ID },
			{ cursor: null, limit: 10 }
		);

		expect(result.outcome).toBe('listed');
		if (result.outcome !== 'listed') expect.unreachable('list should succeed');
		const page: ApiKeyListPage = result.page;
		expect(page.nextCursor).toBeNull();
		expect(page.items.map(keyId)).toEqual([THIRD_KEY_ID, OTHER_KEY_ID, KEY_ID]);
		expect(Object.keys(page.items[0]).sort()).toEqual([
			'createdAt',
			'expiresAt',
			'id',
			'keyPrefix',
			'lastUsedAt',
			'name',
			'revokedAt',
			'scopes'
		]);
		expect(page.items[0].scopes).toEqual(['audit:read', 'envelopes:send']);
	});

	it('paginates deterministically through a cursor', async () => {
		const { store }: Fixture = createFixture();
		await seedThreeKeys(store);

		const firstResult: ListApiKeyStoreResult = await store.listApiKeys(
			{ type: 'user', id: ACTOR_ID },
			{ cursor: null, limit: 2 }
		);
		expect(firstResult.outcome).toBe('listed');
		if (firstResult.outcome !== 'listed') expect.unreachable('list should succeed');
		expect(firstResult.page.items.map(keyId)).toEqual([THIRD_KEY_ID, OTHER_KEY_ID]);
		expect(firstResult.page.nextCursor).toBe(OTHER_KEY_ID);

		const secondResult: ListApiKeyStoreResult = await store.listApiKeys(
			{ type: 'user', id: ACTOR_ID },
			{ cursor: firstResult.page.nextCursor, limit: 2 }
		);
		expect(secondResult.outcome).toBe('listed');
		if (secondResult.outcome !== 'listed') expect.unreachable('list should succeed');
		expect(secondResult.page.items.map(keyId)).toEqual([KEY_ID]);
		expect(secondResult.page.nextCursor).toBeNull();
	});

	it('never leaks another owner rows and fails closed on an unknown or cross-owner cursor', async () => {
		const { store, sqlite }: Fixture = createFixture();
		insertMember(sqlite, OTHER_ACTOR_ID, 'active');
		await seedThreeKeys(store);
		await store.createApiKey(
			await createCommand({
				actor: { type: 'user', id: OTHER_ACTOR_ID },
				idempotencyKey: 'create-other',
				apiKeyId: '01900000-0000-7000-8000-000000000299',
				name: 'Other owner key'
			})
		);

		const own: ListApiKeyStoreResult = await store.listApiKeys(
			{ type: 'user', id: ACTOR_ID },
			{ cursor: null, limit: 10 }
		);
		expect(own.outcome).toBe('listed');
		if (own.outcome !== 'listed') expect.unreachable('list should succeed');
		expect(own.page.items).toHaveLength(3);

		await expect(
			store.listApiKeys(
				{ type: 'user', id: ACTOR_ID },
				{ cursor: '01900000-0000-7000-8000-000000000299', limit: 10 }
			)
		).resolves.toEqual({ outcome: 'listed', page: { items: [], nextCursor: null } });
		await expect(
			store.listApiKeys(
				{ type: 'user', id: ACTOR_ID },
				{ cursor: '01900000-0000-7000-8000-000000000999', limit: 10 }
			)
		).resolves.toEqual({ outcome: 'listed', page: { items: [], nextCursor: null } });
	});

	it('fails closed for invited and suspended owners', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());
		setMemberStatus(sqlite, ACTOR_ID, 'invited');
		await expect(
			store.listApiKeys({ type: 'user', id: ACTOR_ID }, { cursor: null, limit: 10 })
		).resolves.toEqual({ outcome: 'owner_not_active' });
		setMemberStatus(sqlite, ACTOR_ID, 'suspended');
		await expect(
			store.listApiKeys({ type: 'user', id: ACTOR_ID }, { cursor: null, limit: 10 })
		).resolves.toEqual({ outcome: 'owner_not_active' });
	});

	it('rejects out-of-range limits', async () => {
		const { store }: Fixture = createFixture();
		await expect(
			store.listApiKeys({ type: 'user', id: ACTOR_ID }, { cursor: null, limit: 101 })
		).rejects.toThrow('API key list limit must be between 1 and 100.');
		await expect(
			store.listApiKeys({ type: 'user', id: ACTOR_ID }, { cursor: null, limit: 0 })
		).rejects.toThrow('API key list limit must be between 1 and 100.');
	});

	it('reads the member status and the owner page in one batch', async () => {
		const { sqlite }: Fixture = createFixture();
		const batches: string[][] = [];
		const recording: D1Database = recordingBatchDatabase(sqlite, batches);
		const store: D1ApiKeyStore = new D1ApiKeyStore(recording);
		await store.createApiKey(await createCommand());
		batches.length = 0;

		await store.listApiKeys({ type: 'user', id: ACTOR_ID }, { cursor: null, limit: 10 });
		await store.listApiKeys({ type: 'user', id: ACTOR_ID }, { cursor: KEY_ID, limit: 10 });

		// Two statements each time: the member status and the page, cursor resolution
		// included, so authorization and disclosure share one transaction.
		expect(batches).toEqual([
			['member-status', 'owner-page'],
			['member-status', 'owner-page']
		]);
	});

	it('discloses nothing when the owner is suspended after a preliminary check', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());
		await store.createApiKey(
			await createCommand({
				idempotencyKey: 'create-2',
				requestFingerprint: OTHER_REQUEST_HASH,
				apiKeyId: OTHER_KEY_ID,
				createdAt: '2026-09-11T12:00:00.000Z'
			})
		);
		setMemberStatus(sqlite, ACTOR_ID, 'suspended');
		// The page read is asked for while a stale check still reports the owner as
		// active, which is exactly the window the batch closes.
		const stale: D1ApiKeyStore = new D1ApiKeyStore(staleActiveCheckDatabase(sqlite));

		await expect(
			stale.listApiKeys({ type: 'user', id: ACTOR_ID }, { cursor: null, limit: 10 })
		).resolves.toEqual({ outcome: 'listed', page: { items: [], nextCursor: null } });
		await expect(
			stale.listApiKeys({ type: 'user', id: ACTOR_ID }, { cursor: KEY_ID, limit: 10 })
		).resolves.toEqual({ outcome: 'listed', page: { items: [], nextCursor: null } });
	});

	it('surfaces revocation in the projection', async () => {
		const { store }: Fixture = createFixture();
		await store.createApiKey(await createCommand());
		await store.revokeApiKey(revokeCommand());

		const result: ListApiKeyStoreResult = await store.listApiKeys(
			{ type: 'user', id: ACTOR_ID },
			{ cursor: null, limit: 10 }
		);
		expect(result.outcome).toBe('listed');
		if (result.outcome !== 'listed') expect.unreachable('list should succeed');
		expect(result.page.items[0].revokedAt).toBe(REVOKED_AT);
	});
});

describe('D1ApiKeyStore.revokeApiKey', () => {
	it('records revoked_at and exactly one receipt in a single batch', async () => {
		const { store, sqlite }: Fixture = createFixture();
		const created: CreateApiKeyCommand = await createCommand();
		await store.createApiKey(created);

		const result: RevokeApiKeyStoreResult = await store.revokeApiKey(revokeCommand());

		expect(result).toEqual({
			outcome: 'revoked',
			key: {
				id: KEY_ID,
				name: 'CI agent',
				keyPrefix: created.keyPrefix,
				scopes: ['audit:read', 'envelopes:send'],
				createdAt: CREATED_AT,
				expiresAt: EXPIRES_AT,
				lastUsedAt: null,
				revokedAt: REVOKED_AT
			}
		});
		const receipt = sqlite
			.prepare(
				`SELECT actor_type, actor_id, idempotency_key, request_hash,
					api_key_id, key_prefix, revoked_at
				 FROM api_key_revoke_command`
			)
			.all() as Record<string, unknown>[];
		expect(receipt).toEqual([
			{
				actor_type: 'user',
				actor_id: ACTOR_ID,
				idempotency_key: 'revoke-1',
				request_hash: REQUEST_HASH,
				api_key_id: KEY_ID,
				key_prefix: created.keyPrefix,
				revoked_at: REVOKED_AT
			}
		]);
		expect(receipt[0]).not.toHaveProperty('organization_id');
	});

	it('replays the original idempotency key after evidence checks', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());
		await store.revokeApiKey(revokeCommand());

		const replay: RevokeApiKeyStoreResult = await store.revokeApiKey(revokeCommand());

		expect(replay.outcome).toBe('replayed');
		if (replay.outcome !== 'replayed') expect.unreachable('replay should be replayed');
		expect(replay.key.revokedAt).toBe(REVOKED_AT);
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key_revoke_command')).toBe(1);
	});

	it('reports already_revoked for a fresh idempotency key without a second receipt', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());
		await store.revokeApiKey(revokeCommand());

		const again: RevokeApiKeyStoreResult = await store.revokeApiKey(
			revokeCommand({
				idempotencyKey: 'revoke-2',
				revokedAt: '2026-09-12T14:00:00.000Z'
			})
		);

		expect(again.outcome).toBe('already_revoked');
		if (again.outcome !== 'already_revoked') expect.unreachable('should be already_revoked');
		expect(again.key.revokedAt).toBe(REVOKED_AT);
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key_revoke_command')).toBe(1);
		expect(
			count(
				sqlite,
				`SELECT count(*) AS value FROM api_key
				 WHERE id = '${KEY_ID}' AND revoked_at = '${REVOKED_AT}'`
			)
		).toBe(1);
	});

	it('rejects a reused idempotency key aimed at a different key', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());
		await store.createApiKey(
			await createCommand({
				idempotencyKey: 'create-2',
				requestFingerprint: OTHER_REQUEST_HASH,
				apiKeyId: OTHER_KEY_ID
			})
		);
		await store.revokeApiKey(revokeCommand());

		const conflict: RevokeApiKeyStoreResult = await store.revokeApiKey(
			revokeCommand({ apiKeyId: OTHER_KEY_ID })
		);

		expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
		expect(
			count(
				sqlite,
				`SELECT count(*) AS value FROM api_key WHERE id = '${OTHER_KEY_ID}' AND revoked_at IS NULL`
			)
		).toBe(1);
	});

	it('rejects a reused idempotency key with a different request fingerprint', async () => {
		const { store }: Fixture = createFixture();
		await store.createApiKey(await createCommand());
		await store.revokeApiKey(revokeCommand());

		await expect(
			store.revokeApiKey(revokeCommand({ requestFingerprint: OTHER_REQUEST_HASH }))
		).resolves.toEqual({ outcome: 'idempotency_conflict' });
	});

	it('answers unknown and cross-owner keys with not_found', async () => {
		const { store, sqlite }: Fixture = createFixture();
		insertMember(sqlite, OTHER_ACTOR_ID, 'active');
		await store.createApiKey(await createCommand());

		await expect(store.revokeApiKey(revokeCommand({ apiKeyId: OTHER_KEY_ID }))).resolves.toEqual({
			outcome: 'not_found'
		});
		await expect(
			store.revokeApiKey(revokeCommand({ actor: { type: 'user', id: OTHER_ACTOR_ID } }))
		).resolves.toEqual({ outcome: 'not_found' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key_revoke_command')).toBe(0);
		expect(
			count(
				sqlite,
				`SELECT count(*) AS value FROM api_key WHERE id = '${KEY_ID}' AND revoked_at IS NULL`
			)
		).toBe(1);
	});

	it('fails closed after the owner is invited or suspended', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());
		setMemberStatus(sqlite, ACTOR_ID, 'suspended');
		await expect(store.revokeApiKey(revokeCommand())).resolves.toEqual({
			outcome: 'owner_not_active'
		});
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key_revoke_command')).toBe(0);
		setMemberStatus(sqlite, ACTOR_ID, 'invited');
		await expect(store.revokeApiKey(revokeCommand())).resolves.toEqual({
			outcome: 'owner_not_active'
		});
	});

	it('resolves the revoke replay gate in one batch and discloses nothing to a suspended owner', async () => {
		const { sqlite }: Fixture = createFixture();
		const batches: string[][] = [];
		const store: D1ApiKeyStore = new D1ApiKeyStore(recordingBatchDatabase(sqlite, batches));
		const created: CreateApiKeyCommand = await createCommand();
		await store.createApiKey(created);
		await store.revokeApiKey(revokeCommand());
		setMemberStatus(sqlite, ACTOR_ID, 'suspended');
		batches.length = 0;

		// The original idempotency key, whose durable receipt would otherwise replay.
		const replay: RevokeApiKeyStoreResult = await store.revokeApiKey(revokeCommand());
		// A fresh idempotency key, which would otherwise disclose the same key
		// metadata as already_revoked.
		const fresh: RevokeApiKeyStoreResult = await store.revokeApiKey(
			revokeCommand({ idempotencyKey: 'revoke-2', requestFingerprint: OTHER_REQUEST_HASH })
		);

		// Each gate reads the membership check, the receipt, and the key row from
		// one snapshot, and stops there: no write batch follows a failed gate.
		expect(batches).toEqual([
			['member-status', 'revoke-receipt', 'owned-key'],
			['member-status', 'revoke-receipt', 'owned-key']
		]);
		expect(replay).toEqual({ outcome: 'owner_not_active' });
		expect(fresh).toEqual({ outcome: 'owner_not_active' });
		for (const outcome of [replay, fresh]) {
			expect(JSON.stringify(outcome)).not.toContain(created.keyPrefix);
			expect(JSON.stringify(outcome)).not.toContain(REVOKED_AT);
		}
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key_revoke_command')).toBe(1);
		expect(
			count(
				sqlite,
				`SELECT count(*) AS value FROM api_key
				 WHERE id = '${KEY_ID}' AND revoked_at = '${REVOKED_AT}'`
			)
		).toBe(1);
	});

	it('fails closed when the revoke receipt drifted from the key row', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());
		await store.revokeApiKey(revokeCommand());
		sqlite.exec(
			`UPDATE api_key SET revoked_at = '2026-09-12T15:00:00.000Z' WHERE id = '${KEY_ID}'`
		);

		await expect(store.revokeApiKey(revokeCommand())).resolves.toEqual({
			outcome: 'integrity_error'
		});
	});

	it('serializes concurrent revocations of the same key onto one receipt', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createApiKey(await createCommand());

		const outcomes: RevokeApiKeyStoreResult[] = await Promise.all([
			store.revokeApiKey(revokeCommand({ idempotencyKey: 'revoke-a' })),
			store.revokeApiKey(
				revokeCommand({ idempotencyKey: 'revoke-b', revokedAt: '2026-09-12T13:30:00.000Z' })
			)
		]);

		const kinds: string[] = outcomes.map(
			(outcome: RevokeApiKeyStoreResult): string => outcome.outcome
		);
		expect(kinds.filter((kind: string): boolean => kind === 'revoked')).toHaveLength(1);
		expect(kinds.filter((kind: string): boolean => kind === 'already_revoked')).toHaveLength(1);
		expect(count(sqlite, 'SELECT count(*) AS value FROM api_key_revoke_command')).toBe(1);
		expect(
			count(sqlite, `SELECT count(*) AS value FROM api_key WHERE revoked_at IS NOT NULL`)
		).toBe(1);
	});
});
