import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	applyD1MigrationInTransaction,
	applyD1Migrations,
	applyD1MigrationsThrough,
	d1MigrationPaths
} from './sqlite-d1-test-support';

const BEFORE_FIX: string = 'migrations/d1/0041_webhook_endpoint_parity_upgrade.sql';
const READY_ANCHOR_MIGRATION: string = 'migrations/d1/0042_envelope_send_ready_anchor.sql';
const ENVELOPE_ID: string = '01920000-0000-7000-8000-000000000001';
const RECIPIENT_ID: string = '01930000-0000-7000-8000-000000000001';
const READY_AUDIT_ID: string = '01960000-0000-7000-8000-0000000000a0';
const FIELDS_AUDIT_ID: string = '01960000-0000-7000-8000-0000000000a2';
const SENT_AUDIT_ID: string = '01960000-0000-7000-8000-0000000000a1';

function seedReadyThenFields(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('org-1','org-1','Workspace','2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			field_generation, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}','org-1','Agreement','draft',1,'commit-1',0,
			'2026-09-11T00:00:00.000Z','2026-09-11T00:00:30.000Z'
		);
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES
			('01960000-0000-7000-8000-00000000009e','org-1','${ENVELOPE_ID}',1,'envelope.created','user','user-1','{}',NULL,'hash-1','2026-09-11T00:00:00.000Z'),
			('01960000-0000-7000-8000-00000000009f','org-1','${ENVELOPE_ID}',2,'draft.revision_created','user','user-1','{}','hash-1','hash-2','2026-09-11T00:00:30.000Z');
		INSERT INTO envelope_ready_command (
			organization_id,envelope_id,actor_type,actor_id,idempotency_key,request_hash,
			expected_generation,commit_sha,recipients_json,recipient_count,updated_at,
			audit_event_id,audit_sequence,previous_audit_hash,audit_event_hash,audit_payload_json
		) VALUES (
			'org-1','${ENVELOPE_ID}','user','user-1','ready-1','ready-request-hash',1,'commit-1','[]',1,
			'2026-09-11T00:01:00.000Z','${READY_AUDIT_ID}',3,'hash-2','hash-3','{}'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES (
			'${RECIPIENT_ID}','org-1','${ENVELOPE_ID}','a@example.com','A','signer','en',1,'pending',
			'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'
		);
		INSERT INTO envelope_field_placement_command (
			organization_id,envelope_id,actor_type,actor_id,idempotency_key,request_hash,
			expected_generation,expected_field_generation,commit_sha,fields_json,field_count,
			updated_at,audit_event_id,audit_sequence,previous_audit_hash,audit_event_hash,audit_payload_json
		) VALUES (
			'org-1','${ENVELOPE_ID}','user','user-1','fields-1','fields-request-hash',1,0,'commit-1',
			'[{"recipientId":"${RECIPIENT_ID}"}]',1,'2026-09-11T00:01:30.000Z','${FIELDS_AUDIT_ID}',4,
			'hash-3','hash-4','{}'
		);
	`);
}

function database(): DatabaseSync {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	seedReadyThenFields(sqlite);
	return sqlite;
}

function insertCommand(
	sqlite: DatabaseSync,
	overrides: {
		readyAuditEventId?: string;
		auditSequence?: number;
		previousAuditHash?: string;
		queuedDeliveryCount?: number;
		deliveryCount?: number;
		idempotencyKey?: string;
		auditEventId?: string;
	} = {}
): void {
	const readyAuditEventId: string = overrides.readyAuditEventId ?? READY_AUDIT_ID;
	const auditSequence: number = overrides.auditSequence ?? 5;
	const previousAuditHash: string = overrides.previousAuditHash ?? 'hash-4';
	const queuedDeliveryCount: number = overrides.queuedDeliveryCount ?? 1;
	const deliveryCount: number = overrides.deliveryCount ?? 1;
	const idempotencyKey: string = overrides.idempotencyKey ?? 'send-1';
	const auditEventId: string = overrides.auditEventId ?? SENT_AUDIT_ID;
	sqlite.exec(`INSERT INTO envelope_send_command (
		organization_id,envelope_id,actor_type,actor_id,idempotency_key,request_hash,
		expected_generation,ready_audit_event_id,commit_sha,initial_routing_order,
		delivery_count,queued_delivery_count,delivery_manifest_hash,delivery_manifest_json,initial_capability_expires_at,
		updated_at,audit_event_id,audit_sequence,previous_audit_hash,audit_event_hash,audit_payload_json
	) VALUES ('org-1','${ENVELOPE_ID}','user','user-1','${idempotencyKey}','request-hash',1,'${readyAuditEventId}','commit-1',1,
		${deliveryCount},${queuedDeliveryCount},'manifest-hash','[]','2026-09-25T00:02:00.000Z','2026-09-11T00:02:00.000Z',
		'${auditEventId}',${auditSequence},'${previousAuditHash}','hash-5','{}')`);
}

function reserveDelivery(sqlite: DatabaseSync): void {
	sqlite.exec(`
		UPDATE recipient SET capability_hash='cap-hash', capability_expires_at='2026-09-25T00:02:00.000Z',
			updated_at='2026-09-11T00:02:00.000Z'
		WHERE organization_id='org-1' AND id='${RECIPIENT_ID}';
		INSERT INTO delivery_outbox (
			id,organization_id,envelope_id,recipient_id,kind,status,capability_hash,reserved_capability_expires_at,
			sealed_capability,sealing_key_id,sealed_capability_sha256,available_at,attempts,created_at,updated_at
		) VALUES (
			'01940000-0000-7000-8000-000000000001','org-1','${ENVELOPE_ID}','${RECIPIENT_ID}','recipient_invitation','pending','cap-hash',
			'2026-09-25T00:02:00.000Z','sealed','key-1','sealed-hash','2026-09-11T00:02:00.000Z',0,'2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z'
		);
	`);
}

function publish(sqlite: DatabaseSync, idempotencyKey: string = 'send-1'): void {
	sqlite.exec(
		`INSERT INTO envelope_send_publish VALUES ('org-1','user','user-1','${idempotencyKey}')`
	);
}

function rollbackEvidence(sqlite: DatabaseSync): Record<string, unknown> {
	return sqlite
		.prepare(
			`SELECT envelope.status, envelope.field_generation, envelope.repository_generation,
				(SELECT COUNT(*) FROM envelope_send_command) AS commands,
				(SELECT COUNT(*) FROM delivery_outbox) AS deliveries,
				(SELECT COUNT(*) FROM audit_event WHERE event_type='envelope.sent') AS sent_events
			 FROM envelope WHERE id='${ENVELOPE_ID}'`
		)
		.get() as Record<string, unknown>;
}

describe('D1 envelope send ready-anchor migration 0042', () => {
	it('is applied after the webhook endpoint parity upgrade and does not toggle foreign_keys', () => {
		expect(d1MigrationPaths()).toContain(READY_ANCHOR_MIGRATION);
		expect(d1MigrationPaths().indexOf(READY_ANCHOR_MIGRATION)).toBeGreaterThan(
			d1MigrationPaths().indexOf(BEFORE_FIX)
		);
		const sql: string = readFileSync(READY_ANCHOR_MIGRATION, 'utf8');
		expect(sql).not.toMatch(/PRAGMA foreign_keys\s*=/);
		expect(sql).toContain('DROP TRIGGER IF EXISTS envelope_send_publish_guard');
	});

	it('splits the ready Git-revision anchor from the current audit head', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1Migrations(sqlite);
			const trigger = sqlite
				.prepare(
					`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='envelope_send_publish_guard'`
				)
				.get() as { sql: string };
			expect(trigger.sql).toContain('JOIN envelope_ready_command ready');
			expect(trigger.sql).toContain('previous.sequence = command.audit_sequence - 1');
			expect(trigger.sql).toContain("ready_event.event_type = 'envelope.ready'");
			expect(trigger.sql).not.toContain('previous.id = command.ready_audit_event_id');
			expect(trigger.sql).toContain('hash_version');
			expect(trigger.sql).toContain("'signer', 'approver', 'viewer'");
		} finally {
			sqlite.close();
		}
	});

	it('rejects send after fields placement on 0041 and publishes after 0042', () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		try {
			applyD1MigrationsThrough(sqlite, BEFORE_FIX);
			seedReadyThenFields(sqlite);
			sqlite.exec('BEGIN');
			insertCommand(sqlite);
			reserveDelivery(sqlite);
			expect((): void => publish(sqlite)).toThrow(/publish conflict/);
			sqlite.exec('ROLLBACK');
			expect(rollbackEvidence(sqlite)).toEqual({
				status: 'ready',
				field_generation: 1,
				repository_generation: 1,
				commands: 0,
				deliveries: 0,
				sent_events: 0
			});

			applyD1MigrationInTransaction(sqlite, READY_ANCHOR_MIGRATION);

			sqlite.exec('BEGIN');
			insertCommand(sqlite);
			reserveDelivery(sqlite);
			publish(sqlite);
			sqlite.exec('COMMIT');
			const envelope = sqlite
				.prepare(
					`SELECT status, sent_commit_sha, field_generation FROM envelope WHERE id='${ENVELOPE_ID}'`
				)
				.get() as { status: string; sent_commit_sha: string; field_generation: number };
			expect(envelope).toEqual({
				status: 'sent',
				sent_commit_sha: 'commit-1',
				field_generation: 1
			});
			const event = sqlite
				.prepare(
					`SELECT event_type, sequence, hash_version FROM audit_event WHERE id='${SENT_AUDIT_ID}'`
				)
				.get() as { event_type: string; sequence: number; hash_version: number };
			expect(event).toEqual({ event_type: 'envelope.sent', sequence: 5, hash_version: 2 });
		} finally {
			sqlite.close();
		}
	});

	it('publishes sent after ready then field placement when the final guard verifies delivery', () => {
		const sqlite: DatabaseSync = database();
		try {
			sqlite.exec('BEGIN');
			insertCommand(sqlite);
			reserveDelivery(sqlite);
			publish(sqlite);
			sqlite.exec('COMMIT');
			const envelope = sqlite
				.prepare(`SELECT status, sent_commit_sha FROM envelope WHERE id='${ENVELOPE_ID}'`)
				.get() as { status: string; sent_commit_sha: string };
			expect(envelope).toEqual({ status: 'sent', sent_commit_sha: 'commit-1' });
			const event = sqlite
				.prepare(`SELECT event_type FROM audit_event WHERE id='${SENT_AUDIT_ID}'`)
				.get() as { event_type: string };
			expect(event.event_type).toBe('envelope.sent');
		} finally {
			sqlite.close();
		}
	});

	it('aborts a stale audit head and rolls command plus outbox back atomically', () => {
		const sqlite: DatabaseSync = database();
		try {
			sqlite.exec('BEGIN');
			insertCommand(sqlite, { auditSequence: 4, previousAuditHash: 'hash-3' });
			reserveDelivery(sqlite);
			expect((): void => publish(sqlite)).toThrow(/publish conflict/);
			sqlite.exec('ROLLBACK');
			expect(rollbackEvidence(sqlite)).toEqual({
				status: 'ready',
				field_generation: 1,
				repository_generation: 1,
				commands: 0,
				deliveries: 0,
				sent_events: 0
			});
		} finally {
			sqlite.close();
		}
	});

	it('rejects an audit event that is not the ready anchor for the current Git revision', () => {
		const sqlite: DatabaseSync = database();
		try {
			sqlite.exec('BEGIN');
			insertCommand(sqlite, { readyAuditEventId: FIELDS_AUDIT_ID });
			reserveDelivery(sqlite);
			expect((): void => publish(sqlite)).toThrow(/publish conflict/);
			sqlite.exec('ROLLBACK');
			expect(rollbackEvidence(sqlite)).toEqual({
				status: 'ready',
				field_generation: 1,
				repository_generation: 1,
				commands: 0,
				deliveries: 0,
				sent_events: 0
			});
		} finally {
			sqlite.close();
		}
	});

	it('aborts when the delivery outbox count does not match the command manifest', () => {
		const sqlite: DatabaseSync = database();
		try {
			sqlite.exec('BEGIN');
			insertCommand(sqlite);
			reserveDelivery(sqlite);
			sqlite.exec(`
				INSERT INTO delivery_outbox (
					id,organization_id,envelope_id,recipient_id,kind,status,capability_hash,reserved_capability_expires_at,
					sealed_capability,sealing_key_id,sealed_capability_sha256,available_at,attempts,created_at,updated_at
				) VALUES (
					'01940000-0000-7000-8000-000000000002','org-1','${ENVELOPE_ID}','${RECIPIENT_ID}','recipient_invitation','pending','cap-hash',
					'2026-09-25T00:02:00.000Z','sealed','key-1','sealed-hash','2026-09-11T00:02:00.000Z',0,'2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z'
				);
			`);
			expect((): void => publish(sqlite)).toThrow(/publish conflict/);
			sqlite.exec('ROLLBACK');
			expect(rollbackEvidence(sqlite)).toEqual({
				status: 'ready',
				field_generation: 1,
				repository_generation: 1,
				commands: 0,
				deliveries: 0,
				sent_events: 0
			});
		} finally {
			sqlite.close();
		}
	});

	it('aborts and rolls back when the final guard sees a missing delivery', () => {
		const sqlite: DatabaseSync = database();
		try {
			sqlite.exec('BEGIN');
			insertCommand(sqlite);
			expect((): void => publish(sqlite)).toThrow(/publish conflict/);
			sqlite.exec('ROLLBACK');
			expect(rollbackEvidence(sqlite)).toEqual({
				status: 'ready',
				field_generation: 1,
				repository_generation: 1,
				commands: 0,
				deliveries: 0,
				sent_events: 0
			});
		} finally {
			sqlite.close();
		}
	});

	it('replays the same send command key after a successful publish', () => {
		const sqlite: DatabaseSync = database();
		try {
			sqlite.exec('BEGIN');
			insertCommand(sqlite);
			reserveDelivery(sqlite);
			publish(sqlite);
			sqlite.exec('COMMIT');
			expect((): void => insertCommand(sqlite)).toThrow(/UNIQUE constraint failed/);
			expect((): void => publish(sqlite)).toThrow(/UNIQUE constraint failed/);
			const evidence = sqlite
				.prepare(
					`SELECT envelope.status,
						(SELECT COUNT(*) FROM envelope_send_command) AS commands,
						(SELECT COUNT(*) FROM envelope_send_publish) AS publishes,
						(SELECT COUNT(*) FROM audit_event WHERE event_type='envelope.sent') AS sent_events,
						(SELECT COUNT(*) FROM delivery_outbox) AS deliveries
					 FROM envelope WHERE id='${ENVELOPE_ID}'`
				)
				.get() as Record<string, unknown>;
			expect(evidence).toEqual({
				status: 'sent',
				commands: 1,
				publishes: 1,
				sent_events: 1,
				deliveries: 1
			});
		} finally {
			sqlite.close();
		}
	});
});
