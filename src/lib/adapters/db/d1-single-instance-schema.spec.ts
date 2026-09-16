import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations } from './sqlite-d1-test-support';

const MEMBER_ID: string = 'user-1';
const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const CREATED_AT: string = '2026-09-16T00:00:00.000Z';

function migratedDatabase(): DatabaseSync {
	const database: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(database);
	return database;
}

describe('fresh D1 single-instance schema', () => {
	it('contains no organization tables or columns', () => {
		const database: DatabaseSync = migratedDatabase();
		const tables = database
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.all() as { name: string }[];
		expect(tables.map(({ name }: { name: string }): string => name)).not.toContain('organization');
		expect(tables.map(({ name }: { name: string }): string => name)).not.toContain(
			'api_key_organization_grant'
		);

		for (const { name } of tables) {
			const columns = database.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
			expect(columns.map(({ name: column }: { name: string }): string => column)).not.toContain(
				'organization_id'
			);
		}
	});

	it('requires every envelope to belong to a local instance member', () => {
		const database: DatabaseSync = migratedDatabase();
		const insertEnvelope = database.prepare(`INSERT INTO envelope (
			id, created_by_user_id, title, status, created_at, updated_at
		) VALUES (?, ?, 'Agreement', 'draft', ?, ?)`);

		expect((): void => {
			insertEnvelope.run(ENVELOPE_ID, MEMBER_ID, CREATED_AT, CREATED_AT);
		}).toThrow();

		database
			.prepare(
				`INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
				VALUES (?, 'owner', 'active', ?, ?)`
			)
			.run(MEMBER_ID, CREATED_AT, CREATED_AT);
		expect((): void => {
			insertEnvelope.run(ENVELOPE_ID, MEMBER_ID, CREATED_AT, CREATED_AT);
		}).not.toThrow();
	});

	it('uses audit hash version 3 for the current schema', () => {
		const database: DatabaseSync = migratedDatabase();
		const hashVersionColumn = (
			database.prepare("PRAGMA table_info('audit_event')").all() as {
				name: string;
				dflt_value: string | null;
			}[]
		).find(({ name }: { name: string }): boolean => name === 'hash_version');
		expect(hashVersionColumn?.dflt_value).toBe('3');
	});
});
