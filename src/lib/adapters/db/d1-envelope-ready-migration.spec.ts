import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationPaths: readonly string[] = [
	'migrations/d1/0001_core.sql',
	'migrations/d1/0002_envelope_commands.sql',
	'migrations/d1/0003_draft_revisions.sql',
	'migrations/d1/0004_envelope_ready.sql'
];

function migratedDatabase(): DatabaseSync {
	const database: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of migrationPaths) database.exec(readFileSync(path, 'utf8'));
	database.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('org-1', 'org-1', 'Workspace', '2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			created_at, updated_at
		) VALUES (
			'01920000-0000-7000-8000-000000000001', 'org-1', 'Agreement', 'draft', 1, 'commit-1',
			'2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
		);
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type,
			actor_id, payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'01960000-0000-7000-8000-000000000001', 'org-1', '01920000-0000-7000-8000-000000000001', 1, 'envelope.created', 'user',
			'user-1', '{}', NULL, 'hash-1', '2026-09-11T00:00:00.000Z'
		);
	`);
	return database;
}

function readyStatement(database: DatabaseSync): StatementSync {
	return database.prepare(`
		INSERT INTO envelope_ready_command (
			organization_id, envelope_id, actor_type, actor_id, idempotency_key,
			request_hash, expected_generation, commit_sha, recipients_json,
			recipient_count, updated_at, audit_event_id, audit_sequence,
			previous_audit_hash, audit_event_hash, audit_payload_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
}

function insertReadyCommand(database: DatabaseSync, expectedGeneration: number): void {
	readyStatement(database).run(
		'org-1',
		'01920000-0000-7000-8000-000000000001',
		'user',
		'user-1',
		'ready-1',
		'request-1',
		expectedGeneration,
		'commit-1',
		'[]',
		1,
		'2026-09-11T00:01:00.000Z',
		'01960000-0000-7000-8000-000000000002',
		2,
		'hash-1',
		'hash-2',
		'{}'
	);
}

describe('D1 envelope ready migration', () => {
	it('executes the real trigger and publishes one audit-linked ready transition', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			database.exec('BEGIN');
			insertReadyCommand(database, 1);
			database
				.prepare(
					`
					INSERT INTO recipient (
						id, organization_id, envelope_id, email, name, role, locale,
						routing_order, status, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`
				)
				.run(
					'01930000-0000-7000-8000-000000000001',
					'org-1',
					'01920000-0000-7000-8000-000000000001',
					'alice@example.com',
					'Alice',
					'signer',
					'en',
					1,
					'pending',
					'2026-09-11T00:01:00.000Z',
					'2026-09-11T00:01:00.000Z'
				);
			database.exec('COMMIT');

			const envelope = database
				.prepare("SELECT status FROM envelope WHERE id = '01920000-0000-7000-8000-000000000001'")
				.get() as {
				status: string;
			};
			const events = database
				.prepare(
					"SELECT sequence, event_type FROM audit_event WHERE envelope_id = '01920000-0000-7000-8000-000000000001' ORDER BY sequence"
				)
				.all() as Array<{ sequence: number; event_type: string }>;
			expect(envelope.status).toBe('ready');
			expect(events).toEqual([
				{ sequence: 1, event_type: 'envelope.created' },
				{ sequence: 2, event_type: 'envelope.ready' }
			]);
		} finally {
			database.close();
		}
	});

	it('rolls back trigger effects when a later recipient projection write fails', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			database.exec('BEGIN');
			insertReadyCommand(database, 1);
			expect((): void => {
				database.exec(`
					INSERT INTO recipient (
						id, organization_id, envelope_id, email, name, role, locale,
						routing_order, status, created_at, updated_at
					) VALUES (
						'01930000-0000-7000-8000-000000000001', 'org-1', '01920000-0000-7000-8000-000000000001', 'alice@example.com', 'Alice',
						'invalid-role', 'en', 1, 'pending',
						'2026-09-11T00:01:00.000Z', '2026-09-11T00:01:00.000Z'
					)
				`);
			}).toThrow();
			database.exec('ROLLBACK');

			const envelope = database
				.prepare("SELECT status FROM envelope WHERE id = '01920000-0000-7000-8000-000000000001'")
				.get() as {
				status: string;
			};
			const commandCount = database
				.prepare('SELECT count(*) AS count FROM envelope_ready_command')
				.get() as {
				count: number;
			};
			const eventCount = database.prepare('SELECT count(*) AS count FROM audit_event').get() as {
				count: number;
			};
			expect(envelope.status).toBe('draft');
			expect(commandCount.count).toBe(0);
			expect(eventCount.count).toBe(1);
		} finally {
			database.close();
		}
	});

	it('aborts a stale generation without leaving a command or audit row', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			expect((): void => insertReadyCommand(database, 2)).toThrow(/publish conflict/);
			const commandCount = database
				.prepare('SELECT count(*) AS count FROM envelope_ready_command')
				.get() as {
				count: number;
			};
			const eventCount = database.prepare('SELECT count(*) AS count FROM audit_event').get() as {
				count: number;
			};
			expect(commandCount.count).toBe(0);
			expect(eventCount.count).toBe(1);
		} finally {
			database.close();
		}
	});
});
