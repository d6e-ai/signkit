import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationPaths: readonly string[] = [
	'migrations/d1/0001_core.sql',
	'migrations/d1/0002_envelope_commands.sql',
	'migrations/d1/0003_draft_revisions.sql',
	'migrations/d1/0004_envelope_ready.sql',
	'migrations/d1/0005_envelope_send.sql',
	'migrations/d1/0006_recipient_viewed.sql',
	'migrations/d1/0007_recipient_declined.sql',
	'migrations/d1/0008_recipient_approved.sql',
	'migrations/d1/0009_field_placement.sql'
];

function migratedDatabase(): DatabaseSync {
	const database: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of migrationPaths) database.exec(readFileSync(path, 'utf8'));
	database.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('org-1', 'org-1', 'Workspace', '2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			field_generation, created_at, updated_at
		) VALUES (
			'01920000-0000-7000-8000-000000000001', 'org-1', 'Agreement', 'ready', 1, 'commit-1',
			0, '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'
		);
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type,
			actor_id, payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'01960000-0000-7000-8000-000000000001', 'org-1', '01920000-0000-7000-8000-000000000001', 1, 'envelope.ready', 'user',
			'user-1', '{}', NULL, 'hash-1', '2026-09-11T00:00:00.000Z'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale,
			routing_order, status, created_at, updated_at
		) VALUES
			('01930000-0000-7000-8000-000000000001', 'org-1', '01920000-0000-7000-8000-000000000001', 'alice@example.com', 'Alice', 'signer', 'en',
				1, 'pending', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z'),
			('01930000-0000-7000-8000-000000000002', 'org-1', '01920000-0000-7000-8000-000000000001', 'bob@example.com', 'Bob', 'viewer', 'en',
				2, 'pending', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z');
	`);
	return database;
}

function fieldsJson(recipientId: string = '01930000-0000-7000-8000-000000000001'): string {
	return JSON.stringify([
		{
			id: '01950000-0000-7000-8000-000000000001',
			organizationId: 'org-1',
			envelopeId: '01920000-0000-7000-8000-000000000001',
			recipientId,
			documentPath: 'documents/agreement.md',
			fieldType: 'signature',
			label: 'Signature',
			required: true,
			position: 1
		}
	]);
}

function placementStatement(database: DatabaseSync): StatementSync {
	return database.prepare(`
		INSERT INTO envelope_field_placement_command (
			organization_id, envelope_id, actor_type, actor_id, idempotency_key,
			request_hash, expected_generation, expected_field_generation, commit_sha,
			fields_json, field_count, updated_at, audit_event_id, audit_sequence,
			previous_audit_hash, audit_event_hash, audit_payload_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
}

function insertPlacementCommand(
	database: DatabaseSync,
	options: {
		expectedGeneration?: number;
		expectedFieldGeneration?: number;
		recipientId?: string;
	} = {}
): void {
	placementStatement(database).run(
		'org-1',
		'01920000-0000-7000-8000-000000000001',
		'user',
		'user-1',
		'fields-1',
		'request-1',
		options.expectedGeneration ?? 1,
		options.expectedFieldGeneration ?? 0,
		'commit-1',
		fieldsJson(options.recipientId),
		1,
		'2026-09-11T00:01:00.000Z',
		'01960000-0000-7000-8000-000000000002',
		2,
		'hash-1',
		'hash-2',
		'{}'
	);
}

function insertFieldRow(database: DatabaseSync): void {
	database
		.prepare(
			`INSERT INTO envelope_field (
				id, organization_id, envelope_id, recipient_id, document_path, field_type,
				label, required, position, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			'01950000-0000-7000-8000-000000000001',
			'org-1',
			'01920000-0000-7000-8000-000000000001',
			'01930000-0000-7000-8000-000000000001',
			'documents/agreement.md',
			'signature',
			'Signature',
			1,
			1,
			'2026-09-11T00:01:00.000Z',
			'2026-09-11T00:01:00.000Z'
		);
}

describe('D1 envelope field placement migration', () => {
	it('executes the real trigger and publishes one audit-linked replace-all transition', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			database.exec('BEGIN');
			insertPlacementCommand(database);
			database.exec(
				"DELETE FROM envelope_field WHERE organization_id = 'org-1' AND envelope_id = '01920000-0000-7000-8000-000000000001'"
			);
			insertFieldRow(database);
			database.exec('COMMIT');

			const envelope = database
				.prepare(
					"SELECT field_generation FROM envelope WHERE id = '01920000-0000-7000-8000-000000000001'"
				)
				.get() as { field_generation: number };
			const events = database
				.prepare(
					"SELECT sequence, event_type FROM audit_event WHERE envelope_id = '01920000-0000-7000-8000-000000000001' ORDER BY sequence"
				)
				.all() as Array<{ sequence: number; event_type: string }>;
			const fields = database
				.prepare('SELECT id FROM envelope_field WHERE organization_id = ? AND envelope_id = ?')
				.all('org-1', '01920000-0000-7000-8000-000000000001') as Array<{ id: string }>;
			expect(envelope.field_generation).toBe(1);
			expect(events).toEqual([
				{ sequence: 1, event_type: 'envelope.ready' },
				{ sequence: 2, event_type: 'envelope.fields_placed' }
			]);
			expect(fields).toEqual([{ id: '01950000-0000-7000-8000-000000000001' }]);
		} finally {
			database.close();
		}
	});

	it('replaces the entire field set on a second command', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			database.exec('BEGIN');
			insertPlacementCommand(database);
			database.exec(
				"DELETE FROM envelope_field WHERE organization_id = 'org-1' AND envelope_id = '01920000-0000-7000-8000-000000000001'"
			);
			insertFieldRow(database);
			database.exec('COMMIT');

			const replacementFieldsJson: string = JSON.stringify([
				{
					id: '01950000-0000-7000-8000-000000000002',
					organizationId: 'org-1',
					envelopeId: '01920000-0000-7000-8000-000000000001',
					recipientId: '01930000-0000-7000-8000-000000000001',
					documentPath: 'documents/other.md',
					fieldType: 'date',
					label: 'Date',
					required: false,
					position: 2
				}
			]);
			database.exec('BEGIN');
			placementStatement(database).run(
				'org-1',
				'01920000-0000-7000-8000-000000000001',
				'user',
				'user-1',
				'fields-2',
				'request-2',
				1,
				1,
				'commit-1',
				replacementFieldsJson,
				1,
				'2026-09-11T00:02:00.000Z',
				'01960000-0000-7000-8000-000000000003',
				3,
				'hash-2',
				'hash-3',
				'{}'
			);
			expect((): void => {
				database.exec(
					"DELETE FROM envelope_field WHERE organization_id = 'org-1' AND envelope_id = '01920000-0000-7000-8000-000000000001'"
				);
				database
					.prepare(
						`INSERT INTO envelope_field (
							id, organization_id, envelope_id, recipient_id, document_path, field_type,
							label, required, position, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.run(
						'01950000-0000-7000-8000-000000000002',
						'org-1',
						'01920000-0000-7000-8000-000000000001',
						'01930000-0000-7000-8000-000000000001',
						'documents/other.md',
						'date',
						'Date',
						0,
						2,
						'2026-09-11T00:02:00.000Z',
						'2026-09-11T00:02:00.000Z'
					);
			}).not.toThrow();
			database.exec('COMMIT');

			const fields = database
				.prepare('SELECT id FROM envelope_field WHERE organization_id = ? AND envelope_id = ?')
				.all('org-1', '01920000-0000-7000-8000-000000000001') as Array<{ id: string }>;
			const envelope = database
				.prepare(
					"SELECT field_generation FROM envelope WHERE id = '01920000-0000-7000-8000-000000000001'"
				)
				.get() as { field_generation: number };
			expect(fields).toEqual([{ id: '01950000-0000-7000-8000-000000000002' }]);
			expect(envelope.field_generation).toBe(2);
		} finally {
			database.close();
		}
	});

	it('rolls back trigger effects when a later field row insert fails', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			database.exec('BEGIN');
			insertPlacementCommand(database);
			database.exec(
				"DELETE FROM envelope_field WHERE organization_id = 'org-1' AND envelope_id = '01920000-0000-7000-8000-000000000001'"
			);
			expect((): void => {
				database.exec(`
					INSERT INTO envelope_field (
						id, organization_id, envelope_id, recipient_id, document_path, field_type,
						label, required, position, created_at, updated_at
					) VALUES (
						'01950000-0000-7000-8000-000000000001', 'org-1', '01920000-0000-7000-8000-000000000001', '01930000-0000-7000-8000-000000000001', 'documents/agreement.md', 'invalid-type',
						'Signature', 1, 1, '2026-09-11T00:01:00.000Z', '2026-09-11T00:01:00.000Z'
					)
				`);
			}).toThrow();
			database.exec('ROLLBACK');

			const envelope = database
				.prepare(
					"SELECT field_generation FROM envelope WHERE id = '01920000-0000-7000-8000-000000000001'"
				)
				.get() as { field_generation: number };
			const commandCount = database
				.prepare('SELECT count(*) AS count FROM envelope_field_placement_command')
				.get() as { count: number };
			const eventCount = database.prepare('SELECT count(*) AS count FROM audit_event').get() as {
				count: number;
			};
			expect(envelope.field_generation).toBe(0);
			expect(commandCount.count).toBe(0);
			expect(eventCount.count).toBe(1);
		} finally {
			database.close();
		}
	});

	it('aborts when a declared field references a recipient who is not a signer', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			expect((): void =>
				insertPlacementCommand(database, { recipientId: '01930000-0000-7000-8000-000000000002' })
			).toThrow(/publish conflict/);
			const commandCount = database
				.prepare('SELECT count(*) AS count FROM envelope_field_placement_command')
				.get() as { count: number };
			const envelope = database
				.prepare(
					"SELECT field_generation FROM envelope WHERE id = '01920000-0000-7000-8000-000000000001'"
				)
				.get() as { field_generation: number };
			expect(commandCount.count).toBe(0);
			expect(envelope.field_generation).toBe(0);
		} finally {
			database.close();
		}
	});

	it('aborts when a declared field references a recipient outside the envelope', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			expect((): void =>
				insertPlacementCommand(database, { recipientId: 'missing-recipient' })
			).toThrow(/publish conflict/);
		} finally {
			database.close();
		}
	});

	it('aborts a stale repository generation without leaving a command or audit row', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			expect((): void => insertPlacementCommand(database, { expectedGeneration: 2 })).toThrow(
				/publish conflict/
			);
			const commandCount = database
				.prepare('SELECT count(*) AS count FROM envelope_field_placement_command')
				.get() as { count: number };
			const eventCount = database.prepare('SELECT count(*) AS count FROM audit_event').get() as {
				count: number;
			};
			expect(commandCount.count).toBe(0);
			expect(eventCount.count).toBe(1);
		} finally {
			database.close();
		}
	});

	it('aborts a stale field generation without leaving a command or audit row', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			expect((): void => insertPlacementCommand(database, { expectedFieldGeneration: 1 })).toThrow(
				/publish conflict/
			);
			const commandCount = database
				.prepare('SELECT count(*) AS count FROM envelope_field_placement_command')
				.get() as { count: number };
			expect(commandCount.count).toBe(0);
		} finally {
			database.close();
		}
	});

	it('rejects a field generation that cannot be incremented as a portable integer', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			expect((): void =>
				insertPlacementCommand(database, { expectedFieldGeneration: 2_147_483_647 })
			).toThrow();
			const commandCount = database
				.prepare('SELECT count(*) AS count FROM envelope_field_placement_command')
				.get() as { count: number };
			expect(commandCount.count).toBe(0);
		} finally {
			database.close();
		}
	});

	it('rejects two field types at the same recipient document position', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			insertFieldRow(database);
			expect((): void => {
				database
					.prepare(
						`INSERT INTO envelope_field (
							id, organization_id, envelope_id, recipient_id, document_path, field_type,
							label, required, position, created_at, updated_at
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.run(
						'01950000-0000-7000-8000-000000000002',
						'org-1',
						'01920000-0000-7000-8000-000000000001',
						'01930000-0000-7000-8000-000000000001',
						'documents/agreement.md',
						'initials',
						'Initials',
						1,
						1,
						'2026-09-11T00:01:00.000Z',
						'2026-09-11T00:01:00.000Z'
					);
			}).toThrow();
		} finally {
			database.close();
		}
	});

	it('aborts when the envelope is not ready', () => {
		const database: DatabaseSync = migratedDatabase();
		try {
			database.exec(
				"UPDATE envelope SET status = 'sent' WHERE id = '01920000-0000-7000-8000-000000000001'"
			);
			expect((): void => insertPlacementCommand(database)).toThrow(/publish conflict/);
		} finally {
			database.close();
		}
	});
});
