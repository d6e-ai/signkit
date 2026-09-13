import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	applyD1MigrationInTransaction,
	applyD1MigrationsThrough,
	d1MigrationPaths
} from './sqlite-d1-test-support';

const REISSUE_MIGRATION: string = 'migrations/d1/0036_capability_reissue.sql';
const VOID_MIGRATION: string = 'migrations/d1/0038_envelope_void_agent_actor.sql';
const BEFORE_REISSUE: string = 'migrations/d1/0035_completion_artifact_pdf.sql';
const BEFORE_VOID: string = 'migrations/d1/0037_orphan_sweep_checkpoint.sql';

const ORG_ID: string = 'org-1';
const ENV_ID: string = '01900000-0000-7000-8000-000000000001';
const REC_ID: string = '01900000-0000-7000-8000-000000000002';
const OUTBOX_ID: string = '01900000-0000-7000-8000-000000000010';

function seedDeliveryOutbox(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORG_ID}', '${ORG_ID}', 'Workspace', '2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, created_at, updated_at
		) VALUES (
			'${ENV_ID}', '${ORG_ID}', 'Agreement', 'sent', 1,
			'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, role, routing_order, name, email, locale,
			status, capability_hash, capability_expires_at, created_at, updated_at
		) VALUES (
			'${REC_ID}', '${ORG_ID}', '${ENV_ID}', 'signer', 1, 'Signer', 'signer@example.test', 'en',
			'pending', '${'1'.repeat(64)}', '2026-09-25T00:00:00.000Z',
			'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
		);
		INSERT INTO delivery_outbox (
			id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
			reserved_capability_expires_at, sealed_capability, sealing_key_id,
			sealed_capability_sha256, available_at, attempts, created_at, updated_at, retryable
		) VALUES (
			'${OUTBOX_ID}', '${ORG_ID}', '${ENV_ID}', '${REC_ID}', 'recipient_invitation', 'pending',
			'${'1'.repeat(64)}', '2026-09-25T00:00:00.000Z', 'sealed-blob-1', 'key-1',
			'${'c'.repeat(64)}', '2026-09-11T00:00:00.000Z', 0,
			'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z', 1
		);
	`);
}

describe('D1 capability-reissue migration 0036', () => {
	it('is applied after the PDF artifact migration and does not toggle foreign_keys', () => {
		expect(d1MigrationPaths()).toContain(REISSUE_MIGRATION);
		expect(d1MigrationPaths().indexOf(REISSUE_MIGRATION)).toBeGreaterThan(
			d1MigrationPaths().indexOf(BEFORE_REISSUE)
		);
		const sql: string = readFileSync(REISSUE_MIGRATION, 'utf8');
		expect(sql).toContain('PRAGMA defer_foreign_keys = ON');
		expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=/);
	});

	it('rebuilds a seeded delivery_outbox inside a D1-style transaction', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1MigrationsThrough(sqlite, BEFORE_REISSUE);
			seedDeliveryOutbox(sqlite);
			applyD1MigrationInTransaction(sqlite, REISSUE_MIGRATION);
			const row = sqlite
				.prepare('SELECT id, status, sealed_capability FROM delivery_outbox WHERE id = ?')
				.get(OUTBOX_ID) as { id: string; status: string; sealed_capability: string };
			expect(row).toEqual({
				id: OUTBOX_ID,
				status: 'pending',
				sealed_capability: 'sealed-blob-1'
			});
			const fk = sqlite.prepare('PRAGMA foreign_key_check').all() as unknown[];
			expect(fk).toEqual([]);
		} finally {
			sqlite.close();
		}
	});
});

describe('D1 envelope-void agent-actor migration 0038', () => {
	it('defers foreign keys instead of toggling them during the table rebuild', () => {
		expect(d1MigrationPaths()).toContain(VOID_MIGRATION);
		const sql: string = readFileSync(VOID_MIGRATION, 'utf8');
		expect(sql).toContain('PRAGMA defer_foreign_keys = ON');
		expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=/);
	});

	it('rebuilds envelope_void_command inside a D1-style transaction after a seeded workspace', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1MigrationsThrough(sqlite, BEFORE_VOID);
			sqlite.exec(`
				INSERT INTO organization (id, d6e_organization_id, name, created_at)
				VALUES ('${ORG_ID}', '${ORG_ID}', 'Workspace', '2026-09-12T00:00:00.000Z');
				INSERT INTO envelope (
					id, organization_id, title, status, repository_generation, created_at, updated_at
				) VALUES (
					'${ENV_ID}', '${ORG_ID}', 'Agreement', 'draft', 0,
					'2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z'
				);
			`);
			applyD1MigrationInTransaction(sqlite, VOID_MIGRATION);
			const tableSql = sqlite
				.prepare(
					`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'envelope_void_command'`
				)
				.get() as { sql: string };
			expect(tableSql.sql).toMatch(
				/actor_type TEXT NOT NULL CHECK \(actor_type IN \('user', 'agent'/
			);
			const fk = sqlite.prepare('PRAGMA foreign_key_check').all() as unknown[];
			expect(fk).toEqual([]);
		} finally {
			sqlite.close();
		}
	});
});
