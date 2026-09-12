import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations, d1MigrationPaths } from './sqlite-d1-test-support';

const OWNER_ID: string = 'user-owner-1';
const CREATED_AT: string = '2026-09-12T12:00:00.000Z';
const REQUEST_HASH: string = 'a'.repeat(64);

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

describe('D1 instance bootstrap migration', () => {
	it('applies every migration and establishes singleton instance_bootstrap and receipt tables', () => {
		expect(d1MigrationPaths()).toContain('migrations/d1/0019_instance_bootstrap.sql');
		const sqlite: DatabaseSync = database();
		try {
			const tables = sqlite
				.prepare(
					`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
						'instance_member', 'instance_bootstrap', 'instance_bootstrap_command'
					) ORDER BY name`
				)
				.all()
				.map((row: unknown): string => (row as { name: string }).name);

			expect(tables).toEqual([
				'instance_bootstrap',
				'instance_bootstrap_command',
				'instance_member'
			]);

			expect(columnNames(sqlite, 'instance_bootstrap')).toEqual([
				'singleton_key',
				'owner_user_id',
				'created_at'
			]);

			expect(columnNames(sqlite, 'instance_bootstrap_command')).toEqual([
				'actor_type',
				'actor_id',
				'idempotency_key',
				'request_hash',
				'owner_user_id',
				'created_at'
			]);

			const secretColumns = ['token', 'secret', 'plaintext', 'credential', 'password'];
			for (const col of secretColumns) {
				expect(columnNames(sqlite, 'instance_bootstrap')).not.toContain(col);
				expect(columnNames(sqlite, 'instance_bootstrap_command')).not.toContain(col);
			}
		} finally {
			sqlite.close();
		}
	});

	it('enforces singleton constraint on instance_bootstrap', () => {
		const sqlite: DatabaseSync = database();
		try {
			sqlite.exec(`
				INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
				VALUES ('${OWNER_ID}', 'owner', 'active', '${CREATED_AT}', '${CREATED_AT}')
			`);

			sqlite.exec(`
				INSERT INTO instance_bootstrap (singleton_key, owner_user_id, created_at)
				VALUES (1, '${OWNER_ID}', '${CREATED_AT}')
			`);

			// Fails if singleton_key is not 1
			expect(() => {
				sqlite.exec(`
					INSERT INTO instance_bootstrap (singleton_key, owner_user_id, created_at)
					VALUES (2, '${OWNER_ID}', '${CREATED_AT}')
				`);
			}).toThrow(/CHECK constraint failed/);

			// Fails on duplicate singleton_key = 1 (primary key)
			expect(() => {
				sqlite.exec(`
					INSERT INTO instance_bootstrap (singleton_key, owner_user_id, created_at)
					VALUES (1, '${OWNER_ID}', '${CREATED_AT}')
				`);
			}).toThrow(/UNIQUE constraint failed/);
		} finally {
			sqlite.close();
		}
	});

	it('enforces command receipt primary key and constraints', () => {
		const sqlite: DatabaseSync = database();
		try {
			sqlite.exec(`
				INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
				VALUES ('${OWNER_ID}', 'owner', 'active', '${CREATED_AT}', '${CREATED_AT}')
			`);

			sqlite.exec(`
				INSERT INTO instance_bootstrap_command (
					actor_type, actor_id, idempotency_key, request_hash, owner_user_id, created_at
				)
				VALUES ('user', '${OWNER_ID}', 'idem-1', '${REQUEST_HASH}', '${OWNER_ID}', '${CREATED_AT}')
			`);

			// Duplicate primary key
			expect(() => {
				sqlite.exec(`
					INSERT INTO instance_bootstrap_command (
						actor_type, actor_id, idempotency_key, request_hash, owner_user_id, created_at
					)
					VALUES ('user', '${OWNER_ID}', 'idem-1', '${REQUEST_HASH}', '${OWNER_ID}', '${CREATED_AT}')
				`);
			}).toThrow(/UNIQUE constraint failed/);

			// Invalid request_hash shape
			expect(() => {
				sqlite.exec(`
					INSERT INTO instance_bootstrap_command (
						actor_type, actor_id, idempotency_key, request_hash, owner_user_id, created_at
					)
					VALUES ('user', '${OWNER_ID}', 'idem-2', 'not-sha256', '${OWNER_ID}', '${CREATED_AT}')
				`);
			}).toThrow(/CHECK constraint failed/);
		} finally {
			sqlite.close();
		}
	});
});
