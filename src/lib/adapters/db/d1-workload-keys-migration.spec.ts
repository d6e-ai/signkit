import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	canonicalizeWorkloadKeyScopesJson,
	issueWorkloadKey,
	WORKLOAD_KEY_PREFIX,
	type IssuedWorkloadKey
} from '$lib/security/workload-key';
import { applyD1Migrations, d1MigrationPaths } from './sqlite-d1-test-support';

const ORGANIZATION_ID: string = 'org-1';
const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const ACTOR_ID: string = 'user-1';
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const EXPIRES_AT: string = '2026-12-11T12:00:00.000Z';
const REQUEST_HASH: string = 'a'.repeat(64);
const SECRET_COLUMNS: readonly string[] = ['token', 'secret', 'plaintext', 'credential'];

interface SqliteColumn {
	name: string;
}

function database(): DatabaseSync {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return sqlite;
}

function columnNames(sqlite: DatabaseSync, table: string): readonly string[] {
	return sqlite
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.map((row: unknown): string => (row as SqliteColumn).name);
}

function insertOrganization(sqlite: DatabaseSync, organizationId: string = ORGANIZATION_ID): void {
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${organizationId}', '${organizationId}', 'Workspace', '${CREATED_AT}')
	`);
}

function insertWorkloadKey(
	sqlite: DatabaseSync,
	options: {
		organizationId?: string;
		id?: string;
		name?: string;
		tokenHash?: string;
		keyPrefix?: string;
		scopesJson?: string;
		createdByUserId?: string;
		createdAt?: string;
		expiresAt?: string;
		rateWindowCount?: number;
	} = {}
): void {
	sqlite.exec(`
		INSERT INTO workload_key (
			organization_id, id, name, token_hash, key_prefix, scopes_json,
			created_by_user_id, created_at, expires_at, rate_window_count
		) VALUES (
			'${options.organizationId ?? ORGANIZATION_ID}',
			'${options.id ?? KEY_ID}',
			'${options.name ?? 'CI agent'}',
			'${options.tokenHash ?? 'b'.repeat(64)}',
			'${options.keyPrefix ?? 'signkit_abcdefgh'}',
			'${options.scopesJson ?? '["envelopes:read"]'}',
			'${options.createdByUserId ?? ACTOR_ID}',
			'${options.createdAt ?? CREATED_AT}',
			'${options.expiresAt ?? EXPIRES_AT}',
			${options.rateWindowCount ?? 0}
		)
	`);
}

function insertCreateCommand(
	sqlite: DatabaseSync,
	options: {
		organizationId?: string;
		actorId?: string;
		idempotencyKey?: string;
		requestHash?: string;
		workloadKeyId?: string;
		name?: string;
		scopesJson?: string;
		keyPrefix?: string;
		expiresAt?: string;
		createdAt?: string;
	} = {}
): void {
	sqlite.exec(`
		INSERT INTO workload_key_create_command (
			organization_id, actor_type, actor_id, idempotency_key, request_hash,
			workload_key_id, name, scopes_json, key_prefix, expires_at, created_at
		) VALUES (
			'${options.organizationId ?? ORGANIZATION_ID}',
			'user',
			'${options.actorId ?? ACTOR_ID}',
			'${options.idempotencyKey ?? 'create-1'}',
			'${options.requestHash ?? REQUEST_HASH}',
			'${options.workloadKeyId ?? KEY_ID}',
			'${options.name ?? 'CI agent'}',
			'${options.scopesJson ?? '["envelopes:read"]'}',
			'${options.keyPrefix ?? 'signkit_abcdefgh'}',
			'${options.expiresAt ?? EXPIRES_AT}',
			'${options.createdAt ?? CREATED_AT}'
		)
	`);
}

describe('D1 workload key migration', () => {
	it('applies every D1 migration including workload key tables', () => {
		expect(d1MigrationPaths().at(-1)).toBe('migrations/d1/0018_workload_keys.sql');
		const sqlite: DatabaseSync = database();
		try {
			const tables: readonly string[] = sqlite
				.prepare(
					`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
						'workload_key', 'workload_key_create_command', 'workload_key_revoke_command'
					) ORDER BY name`
				)
				.all()
				.map((row: unknown): string => (row as { name: string }).name);
			expect(tables).toEqual([
				'workload_key',
				'workload_key_create_command',
				'workload_key_revoke_command'
			]);
		} finally {
			sqlite.close();
		}
	});

	it('stores hashed credentials and a display prefix without raw secret columns', async () => {
		const sqlite: DatabaseSync = database();
		try {
			for (const table of [
				'workload_key',
				'workload_key_create_command',
				'workload_key_revoke_command'
			] as const) {
				const names: readonly string[] = columnNames(sqlite, table);
				for (const secretColumn of SECRET_COLUMNS) {
					expect(names).not.toContain(secretColumn);
				}
				expect(names.includes('token_hash')).toBe(table === 'workload_key');
			}
			expect(columnNames(sqlite, 'workload_key_create_command')).toEqual(
				expect.arrayContaining(['request_hash', 'key_prefix', 'workload_key_id'])
			);
			expect(columnNames(sqlite, 'workload_key_create_command')).not.toContain('token_hash');

			insertOrganization(sqlite);
			const issued: IssuedWorkloadKey = await issueWorkloadKey();
			insertWorkloadKey(sqlite, {
				tokenHash: issued.tokenHash,
				keyPrefix: issued.keyPrefix
			});
			const stored = sqlite
				.prepare(
					`SELECT token_hash AS tokenHash, key_prefix AS keyPrefix, scopes_json AS scopesJson
					 FROM workload_key WHERE organization_id = ? AND id = ?`
				)
				.get(ORGANIZATION_ID, KEY_ID) as {
				tokenHash: string;
				keyPrefix: string;
				scopesJson: string;
			};
			expect(stored.tokenHash).toBe(issued.tokenHash);
			expect(stored.keyPrefix).toBe(issued.keyPrefix);
			expect(stored.keyPrefix.startsWith(WORKLOAD_KEY_PREFIX)).toBe(true);
			expect(stored.keyPrefix).not.toBe(issued.token);
			expect(JSON.stringify(stored)).not.toContain(issued.token);
		} finally {
			sqlite.close();
		}
	});

	it('allows signkitX names but rejects signkit_ prefixes and non-canonical timestamps', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertOrganization(sqlite);
			insertWorkloadKey(sqlite, { name: 'signkitX' });
			expect((): void =>
				insertWorkloadKey(sqlite, {
					id: '01900000-0000-7000-8000-000000000211',
					name: 'signkit_name',
					tokenHash: 'c'.repeat(64),
					keyPrefix: 'signkit_ijklmnop'
				})
			).toThrow(/CHECK constraint failed/);
			insertCreateCommand(sqlite, { name: 'signkitX' });
			expect((): void =>
				insertCreateCommand(sqlite, {
					idempotencyKey: 'create-2',
					requestHash: 'e'.repeat(64),
					name: 'signkit_name'
				})
			).toThrow(/CHECK constraint failed/);
			expect((): void =>
				insertWorkloadKey(sqlite, {
					id: '01900000-0000-7000-8000-000000000212',
					tokenHash: 'd'.repeat(64),
					keyPrefix: 'signkit_qrstuvwx',
					createdAt: 'not-a-date'
				})
			).toThrow(/CHECK constraint failed/);
			expect((): void =>
				insertWorkloadKey(sqlite, {
					id: '01900000-0000-7000-8000-000000000213',
					tokenHash: 'e'.repeat(64),
					keyPrefix: 'signkit_yzABCDEF',
					expiresAt: 'not-a-date'
				})
			).toThrow(/CHECK constraint failed/);
			expect((): void =>
				insertWorkloadKey(sqlite, {
					id: '01900000-0000-7000-8000-000000000214',
					tokenHash: 'f'.repeat(64),
					keyPrefix: 'signkit_GHJKLMNO',
					createdAt: 'now'
				})
			).toThrow(/CHECK constraint failed/);
			expect((): void =>
				insertWorkloadKey(sqlite, {
					id: '01900000-0000-7000-8000-000000000215',
					tokenHash: '1'.repeat(64),
					keyPrefix: 'signkit_PQRSTUVW',
					createdAt: '2026-09-12T12:00:00Z'
				})
			).toThrow(/CHECK constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('rejects unbounded names, non-canonical scopes, and non-expiring keys', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertOrganization(sqlite);
			expect((): void => insertWorkloadKey(sqlite, { name: ' padded ' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertWorkloadKey(sqlite, { name: '' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertWorkloadKey(sqlite, { name: 'a'.repeat(201) })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void =>
				insertWorkloadKey(sqlite, { name: `${WORKLOAD_KEY_PREFIX}secret` })
			).toThrow(/CHECK constraint failed/);
			expect((): void =>
				insertWorkloadKey(sqlite, { scopesJson: '["envelopes:send","audit:read"]' })
			).toThrow(/CHECK constraint failed/);
			expect((): void => insertWorkloadKey(sqlite, { scopesJson: '[]' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertWorkloadKey(sqlite, { scopesJson: '["secrets:read"]' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void =>
				insertWorkloadKey(sqlite, { expiresAt: '2028-09-12T12:00:00.000Z' })
			).toThrow(/CHECK constraint failed/);
			expect((): void => {
				sqlite.exec(`
					INSERT INTO workload_key (
						organization_id, id, name, token_hash, key_prefix, scopes_json,
						created_by_user_id, created_at, expires_at, rate_window_count
					) VALUES (
						'${ORGANIZATION_ID}', '${KEY_ID}', 'CI agent', '${'b'.repeat(64)}',
						'signkit_abcdefgh', '["envelopes:read"]', '${ACTOR_ID}', '${CREATED_AT}',
						NULL, 0
					)
				`);
			}).toThrow(/NOT NULL constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('enforces global token_hash uniqueness and composite tenant foreign keys', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertOrganization(sqlite);
			insertOrganization(sqlite, 'org-2');
			insertWorkloadKey(sqlite, { tokenHash: 'c'.repeat(64) });
			expect((): void =>
				insertWorkloadKey(sqlite, {
					organizationId: 'org-2',
					id: '01900000-0000-7000-8000-000000000202',
					tokenHash: 'c'.repeat(64),
					keyPrefix: 'signkit_ijklmnop'
				})
			).toThrow(/UNIQUE constraint failed/);
			expect((): void =>
				insertWorkloadKey(sqlite, {
					organizationId: 'missing-org',
					id: '01900000-0000-7000-8000-000000000203',
					tokenHash: 'd'.repeat(64),
					keyPrefix: 'signkit_qrstuvwx'
				})
			).toThrow(/FOREIGN KEY constraint failed/);
			expect((): void => insertWorkloadKey(sqlite, { id: 'not-a-uuid' })).toThrow(
				/CHECK constraint failed/
			);
		} finally {
			sqlite.close();
		}
	});

	it('records create receipts as already-issued evidence that cannot mint another secret', async () => {
		const sqlite: DatabaseSync = database();
		try {
			insertOrganization(sqlite);
			const issued: IssuedWorkloadKey = await issueWorkloadKey();
			insertWorkloadKey(sqlite, {
				tokenHash: issued.tokenHash,
				keyPrefix: issued.keyPrefix,
				scopesJson: canonicalizeWorkloadKeyScopesJson(['envelopes:send', 'drafts:write'])
			});
			insertCreateCommand(sqlite, {
				keyPrefix: issued.keyPrefix,
				scopesJson: canonicalizeWorkloadKeyScopesJson(['drafts:write', 'envelopes:send'])
			});
			const receipt = sqlite
				.prepare(
					`SELECT request_hash AS requestHash, key_prefix AS keyPrefix, workload_key_id AS workloadKeyId
					 FROM workload_key_create_command
					 WHERE organization_id = ? AND actor_id = ? AND idempotency_key = ?`
				)
				.get(ORGANIZATION_ID, ACTOR_ID, 'create-1') as {
				requestHash: string;
				keyPrefix: string;
				workloadKeyId: string;
			};
			expect(receipt).toEqual({
				requestHash: REQUEST_HASH,
				keyPrefix: issued.keyPrefix,
				workloadKeyId: KEY_ID
			});
			expect(JSON.stringify(receipt)).not.toContain(issued.token);

			expect((): void =>
				insertCreateCommand(sqlite, {
					idempotencyKey: 'create-2',
					requestHash: 'e'.repeat(64),
					keyPrefix: issued.keyPrefix
				})
			).toThrow(/UNIQUE constraint failed/);

			insertWorkloadKey(sqlite, {
				id: '01900000-0000-7000-8000-000000000205',
				tokenHash: 'f'.repeat(64),
				keyPrefix: 'signkit_yzABCDEF'
			});
			expect((): void =>
				insertCreateCommand(sqlite, {
					idempotencyKey: 'create-1',
					workloadKeyId: '01900000-0000-7000-8000-000000000205',
					keyPrefix: 'signkit_yzABCDEF'
				})
			).toThrow(/UNIQUE constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('records revoke receipts with a request fingerprint and no raw secret', async () => {
		const sqlite: DatabaseSync = database();
		try {
			insertOrganization(sqlite);
			const issued: IssuedWorkloadKey = await issueWorkloadKey();
			insertWorkloadKey(sqlite, {
				tokenHash: issued.tokenHash,
				keyPrefix: issued.keyPrefix
			});
			sqlite.exec(`
				INSERT INTO workload_key_revoke_command (
					organization_id, actor_type, actor_id, idempotency_key, request_hash,
					workload_key_id, key_prefix, revoked_at
				) VALUES (
					'${ORGANIZATION_ID}', 'user', '${ACTOR_ID}', 'revoke-1', '${'9'.repeat(64)}',
					'${KEY_ID}', '${issued.keyPrefix}', '${CREATED_AT}'
				)
			`);
			expect((): void => {
				sqlite.exec(`
					INSERT INTO workload_key_revoke_command (
						organization_id, actor_type, actor_id, idempotency_key, request_hash,
						workload_key_id, key_prefix, revoked_at
					) VALUES (
						'${ORGANIZATION_ID}', 'user', '${ACTOR_ID}', 'revoke-2', '${'8'.repeat(64)}',
						'${KEY_ID}', '${issued.keyPrefix}', '${CREATED_AT}'
					)
				`);
			}).toThrow(/UNIQUE constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('allows a fresh organization upsert before inserting a workload key', () => {
		const sqlite: DatabaseSync = database();
		try {
			sqlite.exec('BEGIN');
			sqlite.exec(`
				INSERT INTO organization (id, d6e_organization_id, name, created_at)
				VALUES ('${ORGANIZATION_ID}', '${ORGANIZATION_ID}', 'Workspace', '${CREATED_AT}')
				ON CONFLICT(id) DO UPDATE SET name = excluded.name
			`);
			insertWorkloadKey(sqlite);
			insertCreateCommand(sqlite);
			sqlite.exec('COMMIT');
			const count = sqlite.prepare('SELECT COUNT(*) AS count FROM workload_key').get() as {
				count: number;
			};
			expect(count.count).toBe(1);
		} finally {
			sqlite.close();
		}
	});
});
