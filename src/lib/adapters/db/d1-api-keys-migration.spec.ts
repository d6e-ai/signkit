import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	canonicalizeApiKeyScopesJson,
	issueApiKey,
	API_KEY_PREFIX,
	type IssuedApiKey
} from '$lib/security/api-key';
import { applyD1Migrations, d1MigrationPaths } from './sqlite-d1-test-support';

const KEY_ID: string = '01900000-0000-7000-8000-000000000201';
const ACTOR_ID: string = 'user-1';
const OTHER_ACTOR_ID: string = 'user-2';
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

function insertMember(
	sqlite: DatabaseSync,
	userId: string = ACTOR_ID,
	status: 'active' | 'suspended' = 'active',
	role: 'owner' | 'admin' | 'member' = 'member'
): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${userId}', '${role}', '${status}', '${CREATED_AT}', '${CREATED_AT}')
	`);
}

function insertApiKey(
	sqlite: DatabaseSync,
	options: {
		id?: string;
		name?: string;
		tokenHash?: string;
		keyPrefix?: string;
		scopesJson?: string;
		ownerUserId?: string;
		createdAt?: string;
		expiresAt?: string;
		rateWindowCount?: number;
	} = {}
): void {
	sqlite.exec(`
		INSERT INTO api_key (
			id, name, token_hash, key_prefix, scopes_json,
			owner_user_id, created_at, expires_at, rate_window_count
		) VALUES (
			'${options.id ?? KEY_ID}',
			'${options.name ?? 'CI agent'}',
			'${options.tokenHash ?? 'b'.repeat(64)}',
			'${options.keyPrefix ?? 'signkit_abcdefgh'}',
			'${options.scopesJson ?? '["envelopes:read"]'}',
			'${options.ownerUserId ?? ACTOR_ID}',
			'${options.createdAt ?? CREATED_AT}',
			'${options.expiresAt ?? EXPIRES_AT}',
			${options.rateWindowCount ?? 0}
		)
	`);
}

function insertCreateCommand(
	sqlite: DatabaseSync,
	options: {
		actorId?: string;
		idempotencyKey?: string;
		requestHash?: string;
		apiKeyId?: string;
		name?: string;
		scopesJson?: string;
		keyPrefix?: string;
		expiresAt?: string;
		createdAt?: string;
	} = {}
): void {
	sqlite.exec(`
		INSERT INTO api_key_create_command (
			actor_type, actor_id, idempotency_key, request_hash,
			api_key_id, name, scopes_json, key_prefix, expires_at, created_at
		) VALUES (
			'user',
			'${options.actorId ?? ACTOR_ID}',
			'${options.idempotencyKey ?? 'create-1'}',
			'${options.requestHash ?? REQUEST_HASH}',
			'${options.apiKeyId ?? KEY_ID}',
			'${options.name ?? 'CI agent'}',
			'${options.scopesJson ?? '["envelopes:read"]'}',
			'${options.keyPrefix ?? 'signkit_abcdefgh'}',
			'${options.expiresAt ?? EXPIRES_AT}',
			'${options.createdAt ?? CREATED_AT}'
		)
	`);
}

describe('D1 API key migration', () => {
	it('applies every D1 migration including instance member and API key tables', () => {
		expect(d1MigrationPaths()).toContain('migrations/d1/0018_api_keys.sql');
		const sqlite: DatabaseSync = database();
		try {
			const tables: readonly string[] = sqlite
				.prepare(
					`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
						'instance_member', 'api_key', 'api_key_create_command', 'api_key_revoke_command'
					) ORDER BY name`
				)
				.all()
				.map((row: unknown): string => (row as { name: string }).name);
			expect(tables).toEqual([
				'api_key',
				'api_key_create_command',
				'api_key_revoke_command',
				'instance_member'
			]);
			expect(columnNames(sqlite, 'instance_member')).toEqual([
				'user_id',
				'role',
				'status',
				'created_at',
				'updated_at'
			]);
			expect(columnNames(sqlite, 'api_key')).not.toContain('organization_id');
			expect(columnNames(sqlite, 'api_key')).toContain('owner_user_id');
			expect(columnNames(sqlite, 'api_key_create_command')).not.toContain('organization_id');
			expect(columnNames(sqlite, 'api_key')).not.toContain('email');
			expect(columnNames(sqlite, 'instance_member')).not.toContain('email');
			expect(columnNames(sqlite, 'instance_member')).not.toContain('name');
			expect(columnNames(sqlite, 'instance_member')).not.toContain('instance_id');
		} finally {
			sqlite.close();
		}
	});

	it('accepts active and suspended members across owner, admin, and member roles and rejects unknown values', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite, 'owner-user', 'active', 'owner');
			insertMember(sqlite, 'admin-user', 'active', 'admin');
			insertMember(sqlite, 'suspended-user', 'suspended', 'member');
			expect((): void => insertMember(sqlite, 'invited-user', 'invited' as 'active')).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertMember(sqlite, 'closed-user', 'closed' as 'active')).toThrow(
				/CHECK constraint failed/
			);
			expect((): void =>
				insertMember(sqlite, 'super-user', 'active', 'superadmin' as 'member')
			).toThrow(/CHECK constraint failed/);
			const count = sqlite.prepare('SELECT COUNT(*) AS count FROM instance_member').get() as {
				count: number;
			};
			expect(count.count).toBe(3);
		} finally {
			sqlite.close();
		}
	});

	it('defaults role to member when omitted from the insert', () => {
		const sqlite: DatabaseSync = database();
		try {
			sqlite.exec(`
				INSERT INTO instance_member (user_id, status, created_at, updated_at)
				VALUES ('default-role-user', 'active', '${CREATED_AT}', '${CREATED_AT}')
			`);
			const row = sqlite
				.prepare('SELECT role FROM instance_member WHERE user_id = ?')
				.get('default-role-user') as { role: string };
			expect(row.role).toBe('member');
		} finally {
			sqlite.close();
		}
	});

	it('stores hashed credentials and a display prefix without raw secret columns', async () => {
		const sqlite: DatabaseSync = database();
		try {
			for (const table of [
				'api_key',
				'api_key_create_command',
				'api_key_revoke_command'
			] as const) {
				const names: readonly string[] = columnNames(sqlite, table);
				for (const secretColumn of SECRET_COLUMNS) {
					expect(names).not.toContain(secretColumn);
				}
				expect(names.includes('token_hash')).toBe(table === 'api_key');
			}
			expect(columnNames(sqlite, 'api_key_create_command')).toEqual(
				expect.arrayContaining(['request_hash', 'key_prefix', 'api_key_id'])
			);
			expect(columnNames(sqlite, 'api_key_create_command')).not.toContain('token_hash');

			insertMember(sqlite);
			const issued: IssuedApiKey = await issueApiKey();
			insertApiKey(sqlite, {
				tokenHash: issued.tokenHash,
				keyPrefix: issued.keyPrefix
			});
			const stored = sqlite
				.prepare(
					`SELECT token_hash AS tokenHash, key_prefix AS keyPrefix, scopes_json AS scopesJson,
						owner_user_id AS ownerUserId
					 FROM api_key WHERE id = ?`
				)
				.get(KEY_ID) as {
				tokenHash: string;
				keyPrefix: string;
				scopesJson: string;
				ownerUserId: string;
			};
			expect(stored.tokenHash).toBe(issued.tokenHash);
			expect(stored.keyPrefix).toBe(issued.keyPrefix);
			expect(stored.ownerUserId).toBe(ACTOR_ID);
			expect(stored.keyPrefix.startsWith(API_KEY_PREFIX)).toBe(true);
			expect(stored.keyPrefix).not.toBe(issued.token);
			expect(JSON.stringify(stored)).not.toContain(issued.token);
		} finally {
			sqlite.close();
		}
	});

	it('allows signkitX names but rejects signkit_ prefixes and non-canonical timestamps', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite);
			insertApiKey(sqlite, { name: 'signkitX' });
			expect((): void =>
				insertApiKey(sqlite, {
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
				insertApiKey(sqlite, {
					id: '01900000-0000-7000-8000-000000000212',
					tokenHash: 'd'.repeat(64),
					keyPrefix: 'signkit_qrstuvwx',
					createdAt: 'not-a-date'
				})
			).toThrow(/CHECK constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('rejects unbounded names, non-canonical scopes, and non-expiring keys', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite);
			expect((): void => insertApiKey(sqlite, { name: ' padded ' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertApiKey(sqlite, { name: '' })).toThrow(/CHECK constraint failed/);
			expect((): void => insertApiKey(sqlite, { name: 'a'.repeat(201) })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertApiKey(sqlite, { name: `${API_KEY_PREFIX}secret` })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void =>
				insertApiKey(sqlite, { scopesJson: '["envelopes:send","audit:read"]' })
			).toThrow(/CHECK constraint failed/);
			expect((): void => insertApiKey(sqlite, { scopesJson: '[]' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertApiKey(sqlite, { scopesJson: '["secrets:read"]' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => insertApiKey(sqlite, { expiresAt: '2028-09-12T12:00:00.000Z' })).toThrow(
				/CHECK constraint failed/
			);
			expect((): void => {
				sqlite.exec(`
					INSERT INTO api_key (
						id, name, token_hash, key_prefix, scopes_json,
						owner_user_id, created_at, expires_at, rate_window_count
					) VALUES (
						'${KEY_ID}', 'CI agent', '${'b'.repeat(64)}',
						'signkit_abcdefgh', '["envelopes:read"]', '${ACTOR_ID}', '${CREATED_AT}',
						NULL, 0
					)
				`);
			}).toThrow(/NOT NULL constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('enforces global token_hash uniqueness and owner foreign keys', () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite);
			insertMember(sqlite, OTHER_ACTOR_ID);
			insertApiKey(sqlite, { tokenHash: 'c'.repeat(64) });
			expect((): void =>
				insertApiKey(sqlite, {
					id: '01900000-0000-7000-8000-000000000202',
					tokenHash: 'c'.repeat(64),
					keyPrefix: 'signkit_ijklmnop',
					ownerUserId: OTHER_ACTOR_ID
				})
			).toThrow(/UNIQUE constraint failed/);
			expect((): void =>
				insertApiKey(sqlite, {
					id: '01900000-0000-7000-8000-000000000203',
					tokenHash: 'd'.repeat(64),
					keyPrefix: 'signkit_qrstuvwx',
					ownerUserId: 'missing-user'
				})
			).toThrow(/FOREIGN KEY constraint failed/);
			expect((): void => insertApiKey(sqlite, { id: 'not-a-uuid' })).toThrow(
				/CHECK constraint failed/
			);
		} finally {
			sqlite.close();
		}
	});

	it('records create receipts as already-issued evidence scoped to the actor', async () => {
		const sqlite: DatabaseSync = database();
		try {
			insertMember(sqlite);
			insertMember(sqlite, OTHER_ACTOR_ID);
			const issued: IssuedApiKey = await issueApiKey();
			insertApiKey(sqlite, {
				tokenHash: issued.tokenHash,
				keyPrefix: issued.keyPrefix,
				scopesJson: canonicalizeApiKeyScopesJson(['envelopes:send', 'drafts:write'])
			});
			insertCreateCommand(sqlite, {
				keyPrefix: issued.keyPrefix,
				scopesJson: canonicalizeApiKeyScopesJson(['drafts:write', 'envelopes:send'])
			});
			const receipt = sqlite
				.prepare(
					`SELECT request_hash AS requestHash, key_prefix AS keyPrefix, api_key_id AS apiKeyId
					 FROM api_key_create_command
					 WHERE actor_id = ? AND idempotency_key = ?`
				)
				.get(ACTOR_ID, 'create-1') as {
				requestHash: string;
				keyPrefix: string;
				apiKeyId: string;
			};
			expect(receipt).toEqual({
				requestHash: REQUEST_HASH,
				keyPrefix: issued.keyPrefix,
				apiKeyId: KEY_ID
			});
			expect(JSON.stringify(receipt)).not.toContain(issued.token);

			expect((): void =>
				insertCreateCommand(sqlite, {
					idempotencyKey: 'create-2',
					requestHash: 'e'.repeat(64),
					keyPrefix: issued.keyPrefix
				})
			).toThrow(/UNIQUE constraint failed/);

			insertApiKey(sqlite, {
				id: '01900000-0000-7000-8000-000000000205',
				tokenHash: 'f'.repeat(64),
				keyPrefix: 'signkit_yzABCDEF',
				ownerUserId: OTHER_ACTOR_ID
			});
			insertCreateCommand(sqlite, {
				actorId: OTHER_ACTOR_ID,
				idempotencyKey: 'create-1',
				apiKeyId: '01900000-0000-7000-8000-000000000205',
				keyPrefix: 'signkit_yzABCDEF'
			});
			expect((): void =>
				insertCreateCommand(sqlite, {
					idempotencyKey: 'create-1',
					apiKeyId: '01900000-0000-7000-8000-000000000205',
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
			insertMember(sqlite);
			const issued: IssuedApiKey = await issueApiKey();
			insertApiKey(sqlite, {
				tokenHash: issued.tokenHash,
				keyPrefix: issued.keyPrefix
			});
			sqlite.exec(`
				INSERT INTO api_key_revoke_command (
					actor_type, actor_id, idempotency_key, request_hash,
					api_key_id, key_prefix, revoked_at
				) VALUES (
					'user', '${ACTOR_ID}', 'revoke-1', '${'9'.repeat(64)}',
					'${KEY_ID}', '${issued.keyPrefix}', '${CREATED_AT}'
				)
			`);
			expect((): void => {
				sqlite.exec(`
					INSERT INTO api_key_revoke_command (
						actor_type, actor_id, idempotency_key, request_hash,
						api_key_id, key_prefix, revoked_at
					) VALUES (
						'user', '${ACTOR_ID}', 'revoke-2', '${'8'.repeat(64)}',
						'${KEY_ID}', '${issued.keyPrefix}', '${CREATED_AT}'
					)
				`);
			}).toThrow(/UNIQUE constraint failed/);
		} finally {
			sqlite.close();
		}
	});
});
