import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations, d1MigrationPaths } from './sqlite-d1-test-support';

const API_KEY_MUTATION_TABLES: readonly string[] = [
	'draft_revision_command',
	'envelope_ready_command',
	'envelope_field_placement_command',
	'envelope_send_command',
	'envelope_void_command'
];

function database(): DatabaseSync {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return sqlite;
}

function tableSql(sqlite: DatabaseSync, table: string): string {
	const row = sqlite
		.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
		.get(table) as { sql: string } | undefined;
	if (row === undefined) throw new Error(`Missing table ${table}`);
	return row.sql;
}

describe('D1 envelope void agent actor migration', () => {
	it('is applied after the orphan checkpoint migration', () => {
		expect(d1MigrationPaths()).toContain('migrations/d1/0038_envelope_void_agent_actor.sql');
		const index: number = d1MigrationPaths().indexOf(
			'migrations/d1/0038_envelope_void_agent_actor.sql'
		);
		expect(index).toBeGreaterThan(
			d1MigrationPaths().indexOf('migrations/d1/0037_orphan_sweep_checkpoint.sql')
		);
	});

	it('lets API-key mutation tables accept agent actors and keeps session-only tables user-only', () => {
		const sqlite: DatabaseSync = database();
		try {
			for (const table of API_KEY_MUTATION_TABLES) {
				const sql: string = tableSql(sqlite, table);
				expect(sql).toMatch(/actor_type TEXT NOT NULL CHECK \(actor_type IN \('user', 'agent'/);
				expect(sql).not.toMatch(/CHECK \(actor_type = 'user'\)/);
			}
			expect(tableSql(sqlite, 'api_key_create_command')).toMatch(/CHECK \(actor_type = 'user'\)/);
			expect(tableSql(sqlite, 'instance_member_command')).toMatch(/CHECK \(actor_type = 'user'\)/);
			const trigger = sqlite
				.prepare(
					`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'envelope_void_command_publish'`
				)
				.get() as { sql: string };
			expect(trigger.sql).toContain('hash_version');
			expect(trigger.sql).toContain("'envelope.voided'");
			expect(trigger.sql).toContain('NEW.actor_type');
		} finally {
			sqlite.close();
		}
	});

	it('rejects actor types other than user or agent on envelope_void_command', () => {
		const sqlite: DatabaseSync = database();
		try {
			sqlite.exec(`
				INSERT INTO organization (id, d6e_organization_id, name, created_at)
				VALUES ('org-1', 'org-1', 'Workspace', '2026-09-12T00:00:00.000Z');
				INSERT INTO envelope (
					id, organization_id, title, status, repository_generation, created_at, updated_at
				) VALUES (
					'01900000-0000-7000-8000-000000000001', 'org-1', 'Agreement', 'draft', 0,
					'2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'
				);
			`);
			expect(() =>
				sqlite.exec(`
					INSERT INTO envelope_void_command (
						organization_id, envelope_id, actor_type, actor_id, idempotency_key, request_hash,
						previous_status, expected_generation, updated_at, audit_event_id, audit_sequence,
						previous_audit_hash, audit_event_hash, audit_payload_json,
						revocation_evidence_version, revoked_recipient_ids_json, revoked_recipient_count
					) VALUES (
						'org-1', '01900000-0000-7000-8000-000000000001', 'system', 'worker', 'void-1',
						'${'a'.repeat(64)}', 'draft', 0, '2026-09-12T02:00:00.000Z',
						'01960000-0000-7000-8000-0000000000b1', 2, 'head-hash', 'void-hash',
						'{"previousStatus":"draft"}', 1, '[]', 0
					);
				`)
			).toThrow(/CHECK constraint failed/i);
		} finally {
			sqlite.close();
		}
	});
});
