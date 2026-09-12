import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type {
	CreateWorkloadKeyCommand,
	CreateWorkloadKeyStoreResult,
	RevokeWorkloadKeyCommand,
	RevokeWorkloadKeyStoreResult,
	WorkloadKeyListPage,
	WorkloadKeyMetadata
} from '$lib/ports/workload-key-store';
import { PostgresWorkloadKeyStore } from './postgres-workload-key-store';

const ORGANIZATION_ID: string = 'org-1';
const ACTOR_ID: string = 'user-1';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const OTHER_KEY_ID: string = '01900000-0000-7000-8000-000000000202';
const TOKEN_HASH: string = 'f'.repeat(64);
const KEY_PREFIX: string = 'signkit_abcdefgh';
const REQUEST_HASH: string = 'a'.repeat(64);
const CREATED_AT: Date = new Date('2026-09-12T12:00:00.000Z');
const EXPIRES_AT: Date = new Date('2026-12-11T12:00:00.000Z');
const REVOKED_AT: Date = new Date('2026-09-12T13:00:00.000Z');
const SCOPES_JSON: string = '["audit:read","envelopes:send"]';

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}

type ScriptedResult = readonly object[] | Error;

class SqlFragment {
	constructor(readonly text: string) {}
}

/**
 * Records the exact statements the store issues and replays scripted rows, so
 * classification can be asserted without a live server. Nested `sql.unsafe()`
 * column fragments are inlined the way postgres.js inlines them.
 */
class ScriptedPostgres {
	readonly queries: RecordedQuery[] = [];
	beginCalls: number = 0;
	rollbacks: number = 0;
	readonly #results: ScriptedResult[];

	constructor(results: readonly ScriptedResult[]) {
		this.#results = results.map((result: ScriptedResult): ScriptedResult =>
			result instanceof Error ? result : [...result]
		);
	}

	client(): ReturnType<typeof postgres> {
		const client: ReturnType<typeof postgres> = this.#tag();
		Object.assign(client, {
			begin: async <T>(
				callback: (transaction: ReturnType<typeof postgres>) => Promise<T>
			): Promise<T> => {
				this.beginCalls += 1;
				try {
					return await callback(this.#tag());
				} catch (error: unknown) {
					this.rollbacks += 1;
					throw error;
				}
			}
		});
		return client;
	}

	texts(): readonly string[] {
		return this.queries.map((query: RecordedQuery): string => query.text);
	}

	#tag(): ReturnType<typeof postgres> {
		const query = async (
			strings: TemplateStringsArray,
			...values: readonly unknown[]
		): Promise<readonly object[]> => {
			let text: string = '';
			const bound: unknown[] = [];
			strings.forEach((chunk: string, index: number): void => {
				text += chunk;
				if (index >= values.length) return;
				const value: unknown = values[index];
				if (value instanceof SqlFragment) {
					text += value.text;
					return;
				}
				text += '?';
				bound.push(value);
			});
			this.queries.push({ text: text.replaceAll(/\s+/g, ' ').trim(), values: bound });
			const result: ScriptedResult | undefined = this.#results.shift();
			if (result === undefined) throw new Error('Unexpected PostgreSQL query');
			if (result instanceof Error) throw result;
			return result;
		};
		Object.assign(query, {
			unsafe: (text: string): SqlFragment => new SqlFragment(text)
		});
		return query as unknown as ReturnType<typeof postgres>;
	}
}

function store(scripted: ScriptedPostgres): PostgresWorkloadKeyStore {
	return new PostgresWorkloadKeyStore(scripted.client());
}

function createCommand(
	overrides: Partial<CreateWorkloadKeyCommand> = {}
): CreateWorkloadKeyCommand {
	return {
		organizationId: ORGANIZATION_ID,
		organizationName: 'Workspace',
		actor: { type: 'user', id: ACTOR_ID },
		idempotencyKey: 'create-1',
		requestFingerprint: REQUEST_HASH,
		workloadKeyId: KEY_ID,
		name: 'CI agent',
		scopes: ['audit:read', 'envelopes:send'],
		tokenHash: TOKEN_HASH,
		keyPrefix: KEY_PREFIX,
		createdAt: '2026-09-12T12:00:00.000Z',
		expiresAt: '2026-12-11T12:00:00.000Z',
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
		revokedAt: '2026-09-12T13:00:00.000Z',
		...overrides
	};
}

function keyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: KEY_ID,
		name: 'CI agent',
		keyPrefix: KEY_PREFIX,
		scopesJson: SCOPES_JSON,
		createdAt: CREATED_AT,
		expiresAt: EXPIRES_AT,
		lastUsedAt: null,
		revokedAt: null,
		...overrides
	};
}

function createReceiptRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		requestHash: REQUEST_HASH,
		workloadKeyId: KEY_ID,
		name: 'CI agent',
		scopesJson: SCOPES_JSON,
		keyPrefix: KEY_PREFIX,
		createdAt: CREATED_AT,
		expiresAt: EXPIRES_AT,
		keyId: KEY_ID,
		keyName: 'CI agent',
		keyPrefixCurrent: KEY_PREFIX,
		keyScopesJson: SCOPES_JSON,
		keyCreatedByUserId: ACTOR_ID,
		keyCreatedAt: CREATED_AT,
		keyExpiresAt: EXPIRES_AT,
		keyLastUsedAt: null,
		keyRevokedAt: null,
		...overrides
	};
}

function revokeReceiptRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		requestHash: REQUEST_HASH,
		workloadKeyId: KEY_ID,
		keyPrefix: KEY_PREFIX,
		revokedAt: REVOKED_AT,
		keyId: KEY_ID,
		keyName: 'CI agent',
		keyPrefixCurrent: KEY_PREFIX,
		keyScopesJson: SCOPES_JSON,
		keyCreatedAt: CREATED_AT,
		keyExpiresAt: EXPIRES_AT,
		keyLastUsedAt: null,
		keyRevokedAt: REVOKED_AT,
		...overrides
	};
}

const EXPECTED_METADATA: WorkloadKeyMetadata = {
	id: KEY_ID,
	name: 'CI agent',
	keyPrefix: KEY_PREFIX,
	scopes: ['audit:read', 'envelopes:send'],
	createdAt: '2026-09-12T12:00:00.000Z',
	expiresAt: '2026-12-11T12:00:00.000Z',
	lastUsedAt: null,
	revokedAt: null
};

describe('PostgresWorkloadKeyStore.createWorkloadKey', () => {
	it('upserts the guarded organization, key, and receipt inside one transaction', async () => {
		const scripted = new ScriptedPostgres([
			[],
			[{ id: ORGANIZATION_ID }],
			[keyRow()],
			[{ workloadKeyId: KEY_ID }]
		]);
		const result: CreateWorkloadKeyStoreResult =
			await store(scripted).createWorkloadKey(createCommand());

		expect(result).toEqual({ outcome: 'created', key: EXPECTED_METADATA });
		expect(scripted.beginCalls).toBe(1);
		expect(scripted.rollbacks).toBe(0);
		expect(scripted.queries).toHaveLength(4);
		expect(scripted.texts()[0]).toContain('FROM workload_key_create_command command');
		expect(scripted.texts()[0]).toContain('LEFT JOIN workload_key stored');
		expect(scripted.texts()[1]).toContain('INSERT INTO organization');
		expect(scripted.texts()[1]).toContain(
			'WHERE organization.d6e_organization_id = EXCLUDED.d6e_organization_id'
		);
		expect(scripted.texts()[2]).toContain('INSERT INTO workload_key');
		expect(scripted.texts()[2]).toContain('ON CONFLICT DO NOTHING');
		expect(scripted.texts()[2]).toContain('::timestamptz');
		expect(scripted.queries[2].values).toEqual([
			ORGANIZATION_ID,
			KEY_ID,
			'CI agent',
			TOKEN_HASH,
			KEY_PREFIX,
			SCOPES_JSON,
			ACTOR_ID,
			'2026-09-12T12:00:00.000Z',
			'2026-12-11T12:00:00.000Z'
		]);
		expect(scripted.texts()[3]).toContain('INSERT INTO workload_key_create_command');
		expect(scripted.queries[3].values).toEqual([
			ORGANIZATION_ID,
			'user',
			ACTOR_ID,
			'create-1',
			REQUEST_HASH,
			KEY_ID,
			'CI agent',
			SCOPES_JSON,
			KEY_PREFIX,
			'2026-12-11T12:00:00.000Z',
			'2026-09-12T12:00:00.000Z'
		]);
	});

	it('rolls back with integrity_error when the organization projection is guarded out', async () => {
		const scripted = new ScriptedPostgres([[], []]);
		await expect(store(scripted).createWorkloadKey(createCommand())).resolves.toEqual({
			outcome: 'integrity_error'
		});
		expect(scripted.queries).toHaveLength(2);
		expect(scripted.rollbacks).toBe(1);
	});

	it('classifies a key id conflict from evidence', async () => {
		const scripted = new ScriptedPostgres([[], [{ id: ORGANIZATION_ID }], [], [{ id: KEY_ID }]]);
		await expect(store(scripted).createWorkloadKey(createCommand())).resolves.toEqual({
			outcome: 'key_id_conflict'
		});
		expect(scripted.texts()[3]).toContain('SELECT id FROM workload_key WHERE organization_id = ?');
		expect(scripted.rollbacks).toBe(1);
	});

	it('classifies a credential hash conflict from evidence', async () => {
		const scripted = new ScriptedPostgres([
			[],
			[{ id: ORGANIZATION_ID }],
			[],
			[],
			[{ id: OTHER_KEY_ID }]
		]);
		await expect(store(scripted).createWorkloadKey(createCommand())).resolves.toEqual({
			outcome: 'token_hash_conflict'
		});
		expect(scripted.texts()[4]).toContain('WHERE token_hash = ?');
		expect(scripted.queries[4].values).toEqual([TOKEN_HASH]);
	});

	it('falls back to integrity_error when no conflicting row can be proven', async () => {
		const scripted = new ScriptedPostgres([[], [{ id: ORGANIZATION_ID }], [], [], []]);
		await expect(store(scripted).createWorkloadKey(createCommand())).resolves.toEqual({
			outcome: 'integrity_error'
		});
	});

	it('returns already_issued for an exact replay without inserting anything', async () => {
		const scripted = new ScriptedPostgres([[createReceiptRow()]]);
		await expect(store(scripted).createWorkloadKey(createCommand())).resolves.toEqual({
			outcome: 'already_issued',
			key: EXPECTED_METADATA
		});
		expect(scripted.queries).toHaveLength(1);
		expect(scripted.rollbacks).toBe(1);
	});

	it('returns already_issued with the current metadata of a since-revoked key', async () => {
		const scripted = new ScriptedPostgres([
			[createReceiptRow({ keyRevokedAt: REVOKED_AT, keyLastUsedAt: REVOKED_AT })]
		]);
		await expect(store(scripted).createWorkloadKey(createCommand())).resolves.toEqual({
			outcome: 'already_issued',
			key: {
				...EXPECTED_METADATA,
				lastUsedAt: '2026-09-12T13:00:00.000Z',
				revokedAt: '2026-09-12T13:00:00.000Z'
			}
		});
	});

	it('rejects a reused idempotency key for a different request', async () => {
		const scripted = new ScriptedPostgres([[createReceiptRow({ requestHash: 'b'.repeat(64) })]]);
		await expect(store(scripted).createWorkloadKey(createCommand())).resolves.toEqual({
			outcome: 'idempotency_conflict'
		});
	});

	it('treats every form of receipt drift as a conflict rather than a replay', async () => {
		const drifts: readonly Record<string, unknown>[] = [
			{ keyId: null, keyName: null, keyPrefixCurrent: null, keyScopesJson: null },
			{ keyName: 'Renamed agent' },
			{ keyPrefixCurrent: 'signkit_zzzzzzzz' },
			{ keyScopesJson: '["audit:read"]' },
			{ keyCreatedByUserId: 'user-2' },
			{ keyCreatedAt: new Date('2026-09-12T12:00:01.000Z') },
			{ keyExpiresAt: new Date('2026-12-12T12:00:00.000Z') },
			{
				scopesJson: '["audit:read", "envelopes:send"]',
				keyScopesJson: '["audit:read", "envelopes:send"]'
			}
		];
		for (const drift of drifts) {
			const scripted = new ScriptedPostgres([[createReceiptRow(drift)]]);
			await expect(store(scripted).createWorkloadKey(createCommand())).resolves.toEqual({
				outcome: 'idempotency_conflict'
			});
		}
	});

	it('rolls back and replays when a concurrent identical request won the receipt', async () => {
		const scripted = new ScriptedPostgres([
			[],
			[{ id: ORGANIZATION_ID }],
			[keyRow()],
			[],
			[createReceiptRow()]
		]);
		await expect(store(scripted).createWorkloadKey(createCommand())).resolves.toEqual({
			outcome: 'already_issued',
			key: EXPECTED_METADATA
		});
		expect(scripted.rollbacks).toBe(1);
	});

	it('rolls back with integrity_error when the receipt insert conflicts unprovably', async () => {
		const scripted = new ScriptedPostgres([[], [{ id: ORGANIZATION_ID }], [keyRow()], [], []]);
		await expect(store(scripted).createWorkloadKey(createCommand())).resolves.toEqual({
			outcome: 'integrity_error'
		});
		expect(scripted.rollbacks).toBe(1);
	});

	it('never swallows a real driver failure into an outcome', async () => {
		const failure: Error = Object.assign(new Error('deadlock detected'), { code: '40P01' });
		const scripted = new ScriptedPostgres([[], [{ id: ORGANIZATION_ID }], failure]);
		await expect(store(scripted).createWorkloadKey(createCommand())).rejects.toThrow(
			'deadlock detected'
		);
	});
});

describe('PostgresWorkloadKeyStore.listWorkloadKeys', () => {
	it('reads one deterministic newest-first page and over-fetches to compute the cursor', async () => {
		const scripted = new ScriptedPostgres([
			[keyRow({ id: OTHER_KEY_ID }), keyRow(), keyRow({ id: 'extra' })]
		]);
		const page: WorkloadKeyListPage = await store(scripted).listWorkloadKeys(ORGANIZATION_ID, {
			cursor: null,
			limit: 2
		});

		expect(page.items.map((item: WorkloadKeyMetadata): string => item.id)).toEqual([
			OTHER_KEY_ID,
			KEY_ID
		]);
		expect(page.nextCursor).toBe(KEY_ID);
		expect(scripted.queries).toHaveLength(1);
		expect(scripted.texts()[0]).toContain('ORDER BY created_at DESC, id DESC');
		expect(scripted.queries[0].values).toEqual([ORGANIZATION_ID, 3]);
		expect(scripted.beginCalls).toBe(0);
	});

	it('resolves a cursor tenant-scoped before paging with a stable keyset predicate', async () => {
		const scripted = new ScriptedPostgres([
			[{ id: OTHER_KEY_ID, createdAt: EXPIRES_AT }],
			[keyRow()]
		]);
		const page: WorkloadKeyListPage = await store(scripted).listWorkloadKeys(ORGANIZATION_ID, {
			cursor: OTHER_KEY_ID,
			limit: 5
		});

		expect(page).toEqual({ items: [EXPECTED_METADATA], nextCursor: null });
		expect(scripted.texts()[0]).toContain('FROM workload_key WHERE organization_id = ? AND id = ?');
		expect(scripted.texts()[1]).toContain('created_at < ? OR (created_at = ? AND id < ?)');
		expect(scripted.queries[1].values).toEqual([
			ORGANIZATION_ID,
			EXPIRES_AT,
			EXPIRES_AT,
			OTHER_KEY_ID,
			6
		]);
	});

	it('fails closed on an unknown or cross-tenant cursor', async () => {
		const scripted = new ScriptedPostgres([[]]);
		await expect(
			store(scripted).listWorkloadKeys(ORGANIZATION_ID, { cursor: OTHER_KEY_ID, limit: 5 })
		).resolves.toEqual({ items: [], nextCursor: null });
		expect(scripted.queries).toHaveLength(1);
	});

	it('rejects out-of-range limits before querying', async () => {
		const scripted = new ScriptedPostgres([]);
		await expect(
			store(scripted).listWorkloadKeys(ORGANIZATION_ID, { cursor: null, limit: 101 })
		).rejects.toThrow('Workload key list limit must be between 1 and 100.');
		expect(scripted.queries).toEqual([]);
	});

	it('refuses to project a row whose stored scopes are not canonical', async () => {
		const scripted = new ScriptedPostgres([
			[keyRow({ scopesJson: '["envelopes:send","audit:read"]' })]
		]);
		await expect(
			store(scripted).listWorkloadKeys(ORGANIZATION_ID, { cursor: null, limit: 5 })
		).rejects.toThrow('Stored workload key row is not canonical.');
	});
});

describe('PostgresWorkloadKeyStore.revokeWorkloadKey', () => {
	it('locks the key row, writes one receipt, and stamps revoked_at in one transaction', async () => {
		const scripted = new ScriptedPostgres([
			[],
			[keyRow()],
			[{ workloadKeyId: KEY_ID }],
			[keyRow({ revokedAt: REVOKED_AT })]
		]);
		const result: RevokeWorkloadKeyStoreResult =
			await store(scripted).revokeWorkloadKey(revokeCommand());

		expect(result).toEqual({
			outcome: 'revoked',
			key: { ...EXPECTED_METADATA, revokedAt: '2026-09-12T13:00:00.000Z' }
		});
		expect(scripted.beginCalls).toBe(1);
		expect(scripted.rollbacks).toBe(0);
		expect(scripted.texts()[0]).toContain('FROM workload_key_revoke_command command');
		expect(scripted.texts()[1]).toContain('FOR UPDATE');
		expect(scripted.texts()[2]).toContain('INSERT INTO workload_key_revoke_command');
		expect(scripted.queries[2].values).toEqual([
			ORGANIZATION_ID,
			'user',
			ACTOR_ID,
			'revoke-1',
			REQUEST_HASH,
			KEY_ID,
			KEY_PREFIX,
			'2026-09-12T13:00:00.000Z'
		]);
		expect(scripted.texts()[3]).toContain('UPDATE workload_key SET revoked_at = ?::timestamptz');
		expect(scripted.texts()[3]).toContain('AND revoked_at IS NULL');
	});

	it('answers an unknown or cross-tenant key with not_found', async () => {
		const scripted = new ScriptedPostgres([[], []]);
		await expect(store(scripted).revokeWorkloadKey(revokeCommand())).resolves.toEqual({
			outcome: 'not_found'
		});
		expect(scripted.rollbacks).toBe(1);
	});

	it('reports already_revoked without writing a second receipt', async () => {
		const scripted = new ScriptedPostgres([[], [keyRow({ revokedAt: REVOKED_AT })]]);
		await expect(store(scripted).revokeWorkloadKey(revokeCommand())).resolves.toEqual({
			outcome: 'already_revoked',
			key: { ...EXPECTED_METADATA, revokedAt: '2026-09-12T13:00:00.000Z' }
		});
		expect(scripted.queries).toHaveLength(2);
		expect(scripted.rollbacks).toBe(1);
	});

	it('replays the original idempotency key from proven evidence', async () => {
		const scripted = new ScriptedPostgres([[revokeReceiptRow()]]);
		await expect(store(scripted).revokeWorkloadKey(revokeCommand())).resolves.toEqual({
			outcome: 'replayed',
			key: { ...EXPECTED_METADATA, revokedAt: '2026-09-12T13:00:00.000Z' }
		});
		expect(scripted.queries).toHaveLength(1);
	});

	it('rejects a reused idempotency key for another key or another request', async () => {
		for (const drift of [{ workloadKeyId: OTHER_KEY_ID }, { requestHash: 'b'.repeat(64) }]) {
			const scripted = new ScriptedPostgres([[revokeReceiptRow(drift)]]);
			await expect(store(scripted).revokeWorkloadKey(revokeCommand())).resolves.toEqual({
				outcome: 'idempotency_conflict'
			});
		}
	});

	it('fails closed when the revoke receipt drifted from the key row', async () => {
		for (const drift of [
			{ keyId: null, keyName: null, keyPrefixCurrent: null, keyScopesJson: null },
			{ keyRevokedAt: new Date('2026-09-12T14:00:00.000Z') },
			{ keyPrefixCurrent: 'signkit_zzzzzzzz' },
			{ keyRevokedAt: null }
		]) {
			const scripted = new ScriptedPostgres([[revokeReceiptRow(drift)]]);
			await expect(store(scripted).revokeWorkloadKey(revokeCommand())).resolves.toEqual({
				outcome: 'integrity_error'
			});
		}
	});

	it('rolls back with integrity_error when the receipt insert conflicts unprovably', async () => {
		const scripted = new ScriptedPostgres([[], [keyRow()], [], []]);
		await expect(store(scripted).revokeWorkloadKey(revokeCommand())).resolves.toEqual({
			outcome: 'integrity_error'
		});
		expect(scripted.rollbacks).toBe(1);
	});

	it('replays when a concurrent identical revoke won the receipt', async () => {
		const scripted = new ScriptedPostgres([[], [keyRow()], [], [revokeReceiptRow()]]);
		await expect(store(scripted).revokeWorkloadKey(revokeCommand())).resolves.toEqual({
			outcome: 'replayed',
			key: { ...EXPECTED_METADATA, revokedAt: '2026-09-12T13:00:00.000Z' }
		});
		expect(scripted.rollbacks).toBe(1);
	});

	it('rolls back with integrity_error when the guarded update matches nothing', async () => {
		const scripted = new ScriptedPostgres([[], [keyRow()], [{ workloadKeyId: KEY_ID }], []]);
		await expect(store(scripted).revokeWorkloadKey(revokeCommand())).resolves.toEqual({
			outcome: 'integrity_error'
		});
		expect(scripted.rollbacks).toBe(1);
	});

	it('never swallows a real driver failure into an outcome', async () => {
		const failure: Error = Object.assign(new Error('could not serialize access'), {
			code: '40001'
		});
		const scripted = new ScriptedPostgres([[], failure]);
		await expect(store(scripted).revokeWorkloadKey(revokeCommand())).rejects.toThrow(
			'could not serialize access'
		);
	});
});
