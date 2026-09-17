import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations, d1MigrationPaths } from './sqlite-d1-test-support';

const CREATED_AT: string = '2026-09-17T00:00:00.000Z';

describe('D1 instance member identity snapshot migration', () => {
	it('adds bounded display-only identity columns that remain mutable', () => {
		expect(d1MigrationPaths()).toContain(
			'migrations/d1/0050_instance_member_identity_snapshot.sql'
		);
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			sqlite.exec(`
				INSERT INTO instance_member (
					user_id, display_name, email, role, status, created_at, updated_at
				) VALUES (
					'user-1', 'KIMURA Yu', 'yu.kimura@cauchye.com',
					'owner', 'active', '${CREATED_AT}', '${CREATED_AT}'
				)
			`);

			sqlite.exec(`
				UPDATE instance_member
				SET display_name = 'Yu Kimura', email = 'yu@example.com'
				WHERE user_id = 'user-1'
			`);

			const row = sqlite
				.prepare('SELECT display_name, email, role, status FROM instance_member WHERE user_id = ?')
				.get('user-1') as Record<string, unknown>;
			expect(row).toEqual({
				display_name: 'Yu Kimura',
				email: 'yu@example.com',
				role: 'owner',
				status: 'active'
			});

			expect(() => {
				sqlite.exec(
					`UPDATE instance_member SET email = 'UPPER@example.com' WHERE user_id = 'user-1'`
				);
			}).toThrow(/CHECK constraint failed/);
			expect(() => {
				sqlite.exec(
					`UPDATE instance_member SET display_name = '  padded' WHERE user_id = 'user-1'`
				);
			}).toThrow(/CHECK constraint failed/);
		} finally {
			sqlite.close();
		}
	});
});
