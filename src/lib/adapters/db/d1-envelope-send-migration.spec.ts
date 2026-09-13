import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyD1MigrationsThrough } from './sqlite-d1-test-support';

const MIGRATIONS_THROUGH: string = 'migrations/d1/0009_field_placement.sql';

function database(): DatabaseSync {
	const db: DatabaseSync = new DatabaseSync(':memory:');
	applyD1MigrationsThrough(db, MIGRATIONS_THROUGH);
	db.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at) VALUES ('org-1','org-1','Workspace','2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (id, organization_id, title, status, repository_generation, repository_head, created_at, updated_at)
		VALUES ('01920000-0000-7000-8000-000000000001','org-1','Agreement','draft',2,'commit-2','2026-09-11T00:00:00.000Z','2026-09-11T00:00:30.000Z');
		INSERT INTO audit_event (id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json, previous_hash, event_hash, occurred_at)
		VALUES ('01960000-0000-7000-8000-00000000009f','org-1','01920000-0000-7000-8000-000000000001',1,'draft.revision_created','user','user-1','{}',NULL,'hash-1','2026-09-11T00:00:30.000Z');
		INSERT INTO envelope_ready_command (
			organization_id,envelope_id,actor_type,actor_id,idempotency_key,request_hash,
			expected_generation,commit_sha,recipients_json,recipient_count,updated_at,
			audit_event_id,audit_sequence,previous_audit_hash,audit_event_hash,audit_payload_json
		) VALUES (
			'org-1','01920000-0000-7000-8000-000000000001','user','user-1','ready-1','ready-request-hash',2,'commit-2','[]',1,
			'2026-09-11T00:01:00.000Z','01960000-0000-7000-8000-0000000000a0',2,'hash-1','hash-2','{}'
		);
		INSERT INTO recipient (id, organization_id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at)
		VALUES ('01930000-0000-7000-8000-000000000001','org-1','01920000-0000-7000-8000-000000000001','a@example.com','A','signer','en',1,'pending','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z');
		INSERT INTO envelope_field_placement_command (
			organization_id,envelope_id,actor_type,actor_id,idempotency_key,request_hash,
			expected_generation,expected_field_generation,commit_sha,fields_json,field_count,
			updated_at,audit_event_id,audit_sequence,previous_audit_hash,audit_event_hash,audit_payload_json
		) VALUES (
			'org-1','01920000-0000-7000-8000-000000000001','user','user-1','fields-1','fields-request-hash',2,0,'commit-2',
			'[{"recipientId":"01930000-0000-7000-8000-000000000001"}]',1,'2026-09-11T00:01:30.000Z','01960000-0000-7000-8000-0000000000a2',3,
			'hash-2','hash-3','{}'
		);
	`);
	return db;
}

function insertCommand(db: DatabaseSync): void {
	db.exec(`INSERT INTO envelope_send_command (
		organization_id,envelope_id,actor_type,actor_id,idempotency_key,request_hash,
		expected_generation,ready_audit_event_id,commit_sha,initial_routing_order,
		delivery_count,queued_delivery_count,delivery_manifest_hash,delivery_manifest_json,initial_capability_expires_at,
		updated_at,audit_event_id,audit_sequence,previous_audit_hash,audit_event_hash,audit_payload_json
	) VALUES ('org-1','01920000-0000-7000-8000-000000000001','user','user-1','send-1','request-hash',2,'01960000-0000-7000-8000-0000000000a0','commit-2',1,
		1,1,'manifest-hash','[]','2026-09-25T00:02:00.000Z','2026-09-11T00:02:00.000Z',
		'01960000-0000-7000-8000-0000000000a1',4,'hash-3','hash-4','{}')`);
}

function reserveDelivery(db: DatabaseSync): void {
	db.exec(`
		UPDATE recipient SET capability_hash='cap-hash', capability_expires_at='2026-09-25T00:02:00.000Z', updated_at='2026-09-11T00:02:00.000Z'
		WHERE organization_id='org-1' AND id='01930000-0000-7000-8000-000000000001';
		INSERT INTO delivery_outbox (id,organization_id,envelope_id,recipient_id,kind,status,capability_hash,reserved_capability_expires_at,
			sealed_capability,sealing_key_id,sealed_capability_sha256,available_at,attempts,created_at,updated_at)
		VALUES ('01940000-0000-7000-8000-000000000001','org-1','01920000-0000-7000-8000-000000000001','01930000-0000-7000-8000-000000000001','recipient_invitation','pending','cap-hash',
			'2026-09-25T00:02:00.000Z','sealed','key-1','sealed-hash','2026-09-11T00:02:00.000Z',0,'2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z');
	`);
}

describe('D1 envelope send migration', () => {
	it('publishes sent after ready then field placement when the final guard verifies delivery', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertCommand(db);
			reserveDelivery(db);
			db.exec("INSERT INTO envelope_send_publish VALUES ('org-1','user','user-1','send-1')");
			db.exec('COMMIT');
			const envelope = db
				.prepare(
					"SELECT status, sent_commit_sha FROM envelope WHERE id='01920000-0000-7000-8000-000000000001'"
				)
				.get() as { status: string; sent_commit_sha: string };
			expect(envelope).toEqual({ status: 'sent', sent_commit_sha: 'commit-2' });
			const event = db
				.prepare(
					"SELECT event_type FROM audit_event WHERE id='01960000-0000-7000-8000-0000000000a1'"
				)
				.get() as { event_type: string };
			expect(event.event_type).toBe('envelope.sent');
		} finally {
			db.close();
		}
	});

	it('aborts and rolls back when the final guard sees a missing delivery', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertCommand(db);
			expect((): void =>
				db.exec("INSERT INTO envelope_send_publish VALUES ('org-1','user','user-1','send-1')")
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');
			const envelope = db
				.prepare("SELECT status FROM envelope WHERE id='01920000-0000-7000-8000-000000000001'")
				.get() as {
				status: string;
			};
			expect(envelope.status).toBe('ready');
			expect(
				(
					db.prepare('SELECT COUNT(*) AS count FROM envelope_send_command').get() as {
						count: number;
					}
				).count
			).toBe(0);
		} finally {
			db.close();
		}
	});

	it('aborts when a recipient reservation update matched zero rows', () => {
		const db: DatabaseSync = database();
		try {
			db.exec(
				"UPDATE recipient SET status='viewed' WHERE id='01930000-0000-7000-8000-000000000001'"
			);
			db.exec('BEGIN');
			insertCommand(db);
			db.exec(`
				UPDATE recipient SET capability_hash='cap-hash', capability_expires_at='2026-09-25T00:02:00.000Z'
				WHERE organization_id='org-1' AND id='01930000-0000-7000-8000-000000000001' AND status='pending'
					AND capability_hash IS NULL AND capability_expires_at IS NULL;
				INSERT INTO delivery_outbox (id,organization_id,envelope_id,recipient_id,kind,status,capability_hash,
					reserved_capability_expires_at,sealed_capability,sealing_key_id,sealed_capability_sha256,
					available_at,attempts,created_at,updated_at)
				VALUES ('01940000-0000-7000-8000-000000000001','org-1','01920000-0000-7000-8000-000000000001','01930000-0000-7000-8000-000000000001','recipient_invitation','pending','cap-hash',
					'2026-09-25T00:02:00.000Z','sealed','key-1','sealed-hash','2026-09-11T00:02:00.000Z',
					0,'2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z');
			`);
			expect((): void =>
				db.exec("INSERT INTO envelope_send_publish VALUES ('org-1','user','user-1','send-1')")
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');
			const envelope = db
				.prepare("SELECT status FROM envelope WHERE id='01920000-0000-7000-8000-000000000001'")
				.get() as {
				status: string;
			};
			expect(envelope.status).toBe('ready');
		} finally {
			db.close();
		}
	});

	it('rejects an audit event that is not the ready anchor for the current Git revision', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertCommand(db);
			db.exec(
				"UPDATE envelope_send_command SET ready_audit_event_id='01960000-0000-7000-8000-0000000000a2' WHERE idempotency_key='send-1'"
			);
			reserveDelivery(db);
			expect((): void =>
				db.exec("INSERT INTO envelope_send_publish VALUES ('org-1','user','user-1','send-1')")
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');
			const envelope = db
				.prepare("SELECT status FROM envelope WHERE id='01920000-0000-7000-8000-000000000001'")
				.get() as {
				status: string;
			};
			expect(envelope.status).toBe('ready');
		} finally {
			db.close();
		}
	});
});
