import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type {
	CreateWorkloadKeyCommand,
	CreateWorkloadKeyStoreResult,
	RevokeWorkloadKeyCommand,
	RevokeWorkloadKeyStoreResult,
	WorkloadKeyListPage,
	WorkloadKeyMetadata
} from '$lib/ports/workload-key-store';
import { issueWorkloadKey, type IssuedWorkloadKey } from '$lib/security/workload-key';
import { D1WorkloadKeyStore } from './d1-workload-key-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ORGANIZATION_ID: string = 'org-1';
const OTHER_ORGANIZATION_ID: string = 'org-2';
const ACTOR_ID: string = 'user-1';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const OTHER_KEY_ID: string = '01900000-0000-7000-8000-000000000202';
const THIRD_KEY_ID: string = '01900000-0000-7000-8000-000000000203';
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const EXPIRES_AT: string = '2026-12-11T12:00:00.000Z';
const REVOKED_AT: string = '2026-09-12T13:00:00.000Z';
const REQUEST_HASH: string = 'a'.repeat(64);
const OTHER_REQUEST_HASH: string = 'b'.repeat(64);

interface Fixture {
	store: D1WorkloadKeyStore;
	sqlite: DatabaseSync;
}

function createFixture(): Fixture {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return { store: new D1WorkloadKeyStore(sqliteD1Database(sqlite)), sqlite };
}

function insertOrganization(
	sqlite: DatabaseSync,
	organizationId: string,
	d6eOrganizationId: string = organizationId,
	name: string = 'Workspace'
): void {
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${organizationId}', '${d6eOrganizationId}', '${name}', '${CREATED_AT}')
	`);
}

async function createCommand(
	overrides: Partial<CreateWorkloadKeyCommand> = {}
): Promise<CreateWorkloadKeyCommand> {
	const issued: IssuedWorkloadKey = await issueWorkloadKey();
	return {
		organizationId: ORGANIZATION_ID,
		organizationName: 'Workspace',
		actor: { type: 'user', id: ACTOR_ID },
		idempotencyKey: 'create-1',
		requestFingerprint: REQUEST_HASH,
		workloadKeyId: KEY_ID,
		name: 'CI agent',
		scopes: ['audit:read', 'envelopes:send'],
		tokenHash: issued.tokenHash,
		keyPrefix: issued.keyPrefix,
		createdAt: CREATED_AT,
		expiresAt: EXPIRES_AT,
		...overrides
	};
}

function revokeCommand(
	overrides: Partial<RevokeWorkloadKeyCommand> = {}
): RevokeWorkloadKeyCommand {
	return {
		organizationId: ORGANIZATION_ID,
		actor: { type: 'user', id: ACTOR_ID },
		idempotencyKey: 'revoke-1',
		requestFingerprint: REQUEST_HASH,
		workloadKeyId: KEY_ID,
		revokedAt: REVOKED_AT,
		...overrides
	};
}

function count(sqlite: DatabaseSync, sql: string): number {
	return Number((sqlite.prepare(sql).get() as { value: number }).value);
}

function keyId(item: WorkloadKeyMetadata): string {
	return item.id;
}

describe('D1WorkloadKeyStore.createWorkloadKey', () => {
	it('writes the organization projection, key, and receipt in one batch without any plaintext', async () => {
		const { store, sqlite }: Fixture = createFixture();
		const issued: IssuedWorkloadKey = await issueWorkloadKey();
		const command: CreateWorkloadKeyCommand = await createCommand({
			tokenHash: issued.tokenHash,
			keyPrefix: issued.keyPrefix
		});

		const result: CreateWorkloadKeyStoreResult = await store.createWorkloadKey(command);

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
				`SELECT organization_id, id, name, token_hash, key_prefix, scopes_json,
					created_by_user_id, created_at, expires_at, revoked_at, last_used_at,
					rate_window_count
				 FROM workload_key`
			)
			.all() as Record<string, unknown>[];
		expect(stored).toHaveLength(1);
		expect(stored[0]).toEqual({
			organization_id: ORGANIZATION_ID,
			id: KEY_ID,
			name: 'CI agent',
			token_hash: issued.tokenHash,
			key_prefix: issued.keyPrefix,
			scopes_json: '["audit:read","envelopes:send"]',
			created_by_user_id: ACTOR_ID,
			created_at: CREATED_AT,
			expires_at: EXPIRES_AT,
			revoked_at: null,
			last_used_at: null,
			rate_window_count: 0
		});
		expect(count(sqlite, `SELECT count(*) AS value FROM workload_key_create_command`)).toBe(1);
		expect(
			count(
				sqlite,
				`SELECT count(*) AS value FROM workload_key WHERE token_hash = '${issued.token}'`
			)
		).toBe(0);
		expect(
			count(sqlite, `SELECT count(*) AS value FROM organization WHERE id = '${ORGANIZATION_ID}'`)
		).toBe(1);
	});

	it('upserts the organization name for an existing matching projection', async () => {
		const { store, sqlite }: Fixture = createFixture();
		insertOrganization(sqlite, ORGANIZATION_ID, ORGANIZATION_ID, 'Old name');

		const result: CreateWorkloadKeyStoreResult = await store.createWorkloadKey(
			await createCommand({ organizationName: 'Renamed workspace' })
		);

		expect(result.outcome).toBe('created');
		const organization = sqlite
			.prepare(`SELECT name, d6e_organization_id FROM organization WHERE id = '${ORGANIZATION_ID}'`)
			.get() as { name: string; d6e_organization_id: string };
		expect(organization).toEqual({
			name: 'Renamed workspace',
			d6e_organization_id: ORGANIZATION_ID
		});
	});

	it('refuses to remap an organization whose d6e-auth identifier differs and writes nothing', async () => {
		const { store, sqlite }: Fixture = createFixture();
		insertOrganization(sqlite, ORGANIZATION_ID, 'other-d6e-org', 'Original');

		const result: CreateWorkloadKeyStoreResult = await store.createWorkloadKey(
			await createCommand({ organizationName: 'Hijacked' })
		);

		expect(result).toEqual({ outcome: 'integrity_error' });
		const organization = sqlite
			.prepare(`SELECT name, d6e_organization_id FROM organization WHERE id = '${ORGANIZATION_ID}'`)
			.get() as { name: string; d6e_organization_id: string };
		expect(organization).toEqual({ name: 'Original', d6e_organization_id: 'other-d6e-org' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key')).toBe(0);
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key_create_command')).toBe(0);
	});

	it('returns already_issued for an exact replay and never mints a second credential', async () => {
		const { store, sqlite }: Fixture = createFixture();
		const first: CreateWorkloadKeyCommand = await createCommand();
		await store.createWorkloadKey(first);
		const replayIssued: IssuedWorkloadKey = await issueWorkloadKey();

		const replay: CreateWorkloadKeyStoreResult = await store.createWorkloadKey(
			await createCommand({
				workloadKeyId: OTHER_KEY_ID,
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
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key')).toBe(1);
		expect(
			count(
				sqlite,
				`SELECT count(*) AS value FROM workload_key WHERE token_hash = '${replayIssued.tokenHash}'`
			)
		).toBe(0);
	});

	it('reports the current key metadata on replay, including a later revocation', async () => {
		const { store, sqlite }: Fixture = createFixture();
		const command: CreateWorkloadKeyCommand = await createCommand();
		await store.createWorkloadKey(command);
		await store.revokeWorkloadKey(revokeCommand());

		const replay: CreateWorkloadKeyStoreResult = await store.createWorkloadKey(
			await createCommand({ workloadKeyId: OTHER_KEY_ID })
		);

		expect(replay.outcome).toBe('already_issued');
		if (replay.outcome !== 'already_issued') expect.unreachable('replay should be already_issued');
		expect(replay.key.revokedAt).toBe(REVOKED_AT);
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key')).toBe(1);
	});

	it('rejects a reused idempotency key for a different request', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());

		const conflict: CreateWorkloadKeyStoreResult = await store.createWorkloadKey(
			await createCommand({
				workloadKeyId: OTHER_KEY_ID,
				requestFingerprint: OTHER_REQUEST_HASH,
				name: 'Other agent'
			})
		);

		expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key')).toBe(1);
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key_create_command')).toBe(1);
	});

	it('treats a receipt that drifted from its key row as a conflict rather than a replay', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());
		sqlite.exec(`UPDATE workload_key SET name = 'Renamed agent' WHERE id = '${KEY_ID}'`);

		const replay: CreateWorkloadKeyStoreResult = await store.createWorkloadKey(
			await createCommand({ workloadKeyId: OTHER_KEY_ID })
		);

		expect(replay).toEqual({ outcome: 'idempotency_conflict' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key')).toBe(1);
	});

	it('treats a receipt whose key row disappeared as a conflict', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());
		sqlite.exec('PRAGMA foreign_keys = OFF');
		sqlite.exec(`DELETE FROM workload_key WHERE id = '${KEY_ID}'`);
		sqlite.exec('PRAGMA foreign_keys = ON');

		const replay: CreateWorkloadKeyStoreResult = await store.createWorkloadKey(
			await createCommand({ workloadKeyId: OTHER_KEY_ID })
		);

		expect(replay).toEqual({ outcome: 'idempotency_conflict' });
	});

	it('classifies a credential hash collision without inspecting the provider error', async () => {
		const { store, sqlite }: Fixture = createFixture();
		const first: CreateWorkloadKeyCommand = await createCommand();
		await store.createWorkloadKey(first);

		const collision: CreateWorkloadKeyStoreResult = await store.createWorkloadKey(
			await createCommand({
				idempotencyKey: 'create-2',
				requestFingerprint: OTHER_REQUEST_HASH,
				workloadKeyId: OTHER_KEY_ID,
				tokenHash: first.tokenHash
			})
		);

		expect(collision).toEqual({ outcome: 'token_hash_conflict' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key')).toBe(1);
	});

	it('classifies a cross-tenant credential hash collision the same way', async () => {
		const { store, sqlite }: Fixture = createFixture();
		const first: CreateWorkloadKeyCommand = await createCommand();
		await store.createWorkloadKey(first);

		const collision: CreateWorkloadKeyStoreResult = await store.createWorkloadKey(
			await createCommand({
				organizationId: OTHER_ORGANIZATION_ID,
				organizationName: 'Other workspace',
				idempotencyKey: 'create-2',
				workloadKeyId: OTHER_KEY_ID,
				tokenHash: first.tokenHash
			})
		);

		expect(collision).toEqual({ outcome: 'token_hash_conflict' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key')).toBe(1);
	});

	it('classifies a generated key id collision', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());

		const collision: CreateWorkloadKeyStoreResult = await store.createWorkloadKey(
			await createCommand({
				idempotencyKey: 'create-2',
				requestFingerprint: OTHER_REQUEST_HASH
			})
		);

		expect(collision).toEqual({ outcome: 'key_id_conflict' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key')).toBe(1);
	});

	it('keeps the same idempotency key independent per organization', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());

		const other: CreateWorkloadKeyStoreResult = await store.createWorkloadKey(
			await createCommand({
				organizationId: OTHER_ORGANIZATION_ID,
				organizationName: 'Other workspace',
				workloadKeyId: OTHER_KEY_ID
			})
		);

		expect(other.outcome).toBe('created');
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key')).toBe(2);
		expect(
			count(
				sqlite,
				`SELECT count(*) AS value FROM workload_key WHERE organization_id = '${OTHER_ORGANIZATION_ID}'`
			)
		).toBe(1);
	});
});

describe('D1WorkloadKeyStore.listWorkloadKeys', () => {
	async function seedThreeKeys(store: D1WorkloadKeyStore): Promise<void> {
		await store.createWorkloadKey(
			await createCommand({
				idempotencyKey: 'create-1',
				workloadKeyId: KEY_ID,
				name: 'Oldest',
				createdAt: '2026-09-10T12:00:00.000Z',
				expiresAt: '2026-12-09T12:00:00.000Z'
			})
		);
		await store.createWorkloadKey(
			await createCommand({
				idempotencyKey: 'create-2',
				requestFingerprint: OTHER_REQUEST_HASH,
				workloadKeyId: OTHER_KEY_ID,
				name: 'Same instant lower id',
				createdAt: '2026-09-11T12:00:00.000Z',
				expiresAt: '2026-12-10T12:00:00.000Z'
			})
		);
		await store.createWorkloadKey(
			await createCommand({
				idempotencyKey: 'create-3',
				requestFingerprint: 'c'.repeat(64),
				workloadKeyId: THIRD_KEY_ID,
				name: 'Same instant higher id',
				createdAt: '2026-09-11T12:00:00.000Z',
				expiresAt: '2026-12-10T12:00:00.000Z'
			})
		);
	}

	it('returns a deterministic newest-first page with only the allowlisted fields', async () => {
		const { store }: Fixture = createFixture();
		await seedThreeKeys(store);

		const page: WorkloadKeyListPage = await store.listWorkloadKeys(ORGANIZATION_ID, {
			cursor: null,
			limit: 10
		});

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

		const first: WorkloadKeyListPage = await store.listWorkloadKeys(ORGANIZATION_ID, {
			cursor: null,
			limit: 2
		});
		expect(first.items.map(keyId)).toEqual([THIRD_KEY_ID, OTHER_KEY_ID]);
		expect(first.nextCursor).toBe(OTHER_KEY_ID);

		const second: WorkloadKeyListPage = await store.listWorkloadKeys(ORGANIZATION_ID, {
			cursor: first.nextCursor,
			limit: 2
		});
		expect(second.items.map(keyId)).toEqual([KEY_ID]);
		expect(second.nextCursor).toBeNull();
	});

	it('never leaks another tenant rows and fails closed on an unknown or cross-tenant cursor', async () => {
		const { store }: Fixture = createFixture();
		await seedThreeKeys(store);
		await store.createWorkloadKey(
			await createCommand({
				organizationId: OTHER_ORGANIZATION_ID,
				organizationName: 'Other workspace',
				idempotencyKey: 'create-other',
				workloadKeyId: '01900000-0000-7000-8000-000000000299',
				name: 'Other tenant key'
			})
		);

		const own: WorkloadKeyListPage = await store.listWorkloadKeys(ORGANIZATION_ID, {
			cursor: null,
			limit: 10
		});
		expect(own.items).toHaveLength(3);

		await expect(
			store.listWorkloadKeys(ORGANIZATION_ID, {
				cursor: '01900000-0000-7000-8000-000000000299',
				limit: 10
			})
		).resolves.toEqual({ items: [], nextCursor: null });
		await expect(
			store.listWorkloadKeys(ORGANIZATION_ID, {
				cursor: '01900000-0000-7000-8000-000000000999',
				limit: 10
			})
		).resolves.toEqual({ items: [], nextCursor: null });
	});

	it('rejects out-of-range limits', async () => {
		const { store }: Fixture = createFixture();
		await expect(
			store.listWorkloadKeys(ORGANIZATION_ID, { cursor: null, limit: 101 })
		).rejects.toThrow('Workload key list limit must be between 1 and 100.');
		await expect(
			store.listWorkloadKeys(ORGANIZATION_ID, { cursor: null, limit: 0 })
		).rejects.toThrow('Workload key list limit must be between 1 and 100.');
	});

	it('surfaces revocation in the projection', async () => {
		const { store }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());
		await store.revokeWorkloadKey(revokeCommand());

		const page: WorkloadKeyListPage = await store.listWorkloadKeys(ORGANIZATION_ID, {
			cursor: null,
			limit: 10
		});
		expect(page.items[0].revokedAt).toBe(REVOKED_AT);
	});
});

describe('D1WorkloadKeyStore.revokeWorkloadKey', () => {
	it('records revoked_at and exactly one receipt in a single batch', async () => {
		const { store, sqlite }: Fixture = createFixture();
		const created: CreateWorkloadKeyCommand = await createCommand();
		await store.createWorkloadKey(created);

		const result: RevokeWorkloadKeyStoreResult = await store.revokeWorkloadKey(revokeCommand());

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
				`SELECT organization_id, actor_type, actor_id, idempotency_key, request_hash,
					workload_key_id, key_prefix, revoked_at
				 FROM workload_key_revoke_command`
			)
			.all() as Record<string, unknown>[];
		expect(receipt).toEqual([
			{
				organization_id: ORGANIZATION_ID,
				actor_type: 'user',
				actor_id: ACTOR_ID,
				idempotency_key: 'revoke-1',
				request_hash: REQUEST_HASH,
				workload_key_id: KEY_ID,
				key_prefix: created.keyPrefix,
				revoked_at: REVOKED_AT
			}
		]);
	});

	it('replays the original idempotency key after evidence checks', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());
		await store.revokeWorkloadKey(revokeCommand());

		const replay: RevokeWorkloadKeyStoreResult = await store.revokeWorkloadKey(revokeCommand());

		expect(replay.outcome).toBe('replayed');
		if (replay.outcome !== 'replayed') expect.unreachable('replay should be replayed');
		expect(replay.key.revokedAt).toBe(REVOKED_AT);
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key_revoke_command')).toBe(1);
	});

	it('reports already_revoked for a fresh idempotency key without a second receipt', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());
		await store.revokeWorkloadKey(revokeCommand());

		const again: RevokeWorkloadKeyStoreResult = await store.revokeWorkloadKey(
			revokeCommand({
				idempotencyKey: 'revoke-2',
				revokedAt: '2026-09-12T14:00:00.000Z'
			})
		);

		expect(again.outcome).toBe('already_revoked');
		if (again.outcome !== 'already_revoked') expect.unreachable('should be already_revoked');
		expect(again.key.revokedAt).toBe(REVOKED_AT);
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key_revoke_command')).toBe(1);
		expect(
			count(
				sqlite,
				`SELECT count(*) AS value FROM workload_key
				 WHERE id = '${KEY_ID}' AND revoked_at = '${REVOKED_AT}'`
			)
		).toBe(1);
	});

	it('rejects a reused idempotency key aimed at a different key', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());
		await store.createWorkloadKey(
			await createCommand({
				idempotencyKey: 'create-2',
				requestFingerprint: OTHER_REQUEST_HASH,
				workloadKeyId: OTHER_KEY_ID
			})
		);
		await store.revokeWorkloadKey(revokeCommand());

		const conflict: RevokeWorkloadKeyStoreResult = await store.revokeWorkloadKey(
			revokeCommand({ workloadKeyId: OTHER_KEY_ID })
		);

		expect(conflict).toEqual({ outcome: 'idempotency_conflict' });
		expect(
			count(
				sqlite,
				`SELECT count(*) AS value FROM workload_key WHERE id = '${OTHER_KEY_ID}' AND revoked_at IS NULL`
			)
		).toBe(1);
	});

	it('rejects a reused idempotency key with a different request fingerprint', async () => {
		const { store }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());
		await store.revokeWorkloadKey(revokeCommand());

		await expect(
			store.revokeWorkloadKey(revokeCommand({ requestFingerprint: OTHER_REQUEST_HASH }))
		).resolves.toEqual({ outcome: 'idempotency_conflict' });
	});

	it('answers unknown and cross-tenant keys with not_found', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());
		insertOrganization(sqlite, OTHER_ORGANIZATION_ID);

		await expect(
			store.revokeWorkloadKey(revokeCommand({ workloadKeyId: OTHER_KEY_ID }))
		).resolves.toEqual({ outcome: 'not_found' });
		await expect(
			store.revokeWorkloadKey(revokeCommand({ organizationId: OTHER_ORGANIZATION_ID }))
		).resolves.toEqual({ outcome: 'not_found' });
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key_revoke_command')).toBe(0);
	});

	it('fails closed when the revoke receipt drifted from the key row', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());
		await store.revokeWorkloadKey(revokeCommand());
		sqlite.exec(
			`UPDATE workload_key SET revoked_at = '2026-09-12T15:00:00.000Z' WHERE id = '${KEY_ID}'`
		);

		await expect(store.revokeWorkloadKey(revokeCommand())).resolves.toEqual({
			outcome: 'integrity_error'
		});
	});

	it('serializes concurrent revocations of the same key onto one receipt', async () => {
		const { store, sqlite }: Fixture = createFixture();
		await store.createWorkloadKey(await createCommand());

		const outcomes: RevokeWorkloadKeyStoreResult[] = await Promise.all([
			store.revokeWorkloadKey(revokeCommand({ idempotencyKey: 'revoke-a' })),
			store.revokeWorkloadKey(
				revokeCommand({ idempotencyKey: 'revoke-b', revokedAt: '2026-09-12T13:30:00.000Z' })
			)
		]);

		const kinds: string[] = outcomes.map(
			(outcome: RevokeWorkloadKeyStoreResult): string => outcome.outcome
		);
		expect(kinds.filter((kind: string): boolean => kind === 'revoked')).toHaveLength(1);
		expect(kinds.filter((kind: string): boolean => kind === 'already_revoked')).toHaveLength(1);
		expect(count(sqlite, 'SELECT count(*) AS value FROM workload_key_revoke_command')).toBe(1);
		expect(
			count(sqlite, `SELECT count(*) AS value FROM workload_key WHERE revoked_at IS NOT NULL`)
		).toBe(1);
	});
});
