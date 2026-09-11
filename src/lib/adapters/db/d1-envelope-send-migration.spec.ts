import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationPaths: readonly string[] = [
	'migrations/d1/0001_core.sql',
	'migrations/d1/0002_envelope_commands.sql',
	'migrations/d1/0003_draft_revisions.sql',
	'migrations/d1/0004_envelope_ready.sql',
	'migrations/d1/0005_envelope_send.sql'
];

function database(): DatabaseSync {
	const db: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of migrationPaths) db.exec(readFileSync(path, 'utf8'));
	db.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at) VALUES ('org-1','org-1','Workspace','2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (id, organization_id, title, status, repository_generation, repository_head, created_at, updated_at)
		VALUES ('env-1','org-1','Agreement','ready',2,'commit-2','2026-09-11T00:00:00.000Z','2026-09-11T00:01:00.000Z');
		INSERT INTO audit_event (id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json, previous_hash, event_hash, occurred_at)
		VALUES ('ready-audit','org-1','env-1',2,'envelope.ready','user','user-1','{}','hash-1','hash-2','2026-09-11T00:01:00.000Z');
		INSERT INTO recipient (id, organization_id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at)
		VALUES ('recipient-1','org-1','env-1','a@example.com','A','signer','en',1,'pending','2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z');
	`);
	return db;
}

function insertCommand(db: DatabaseSync): void {
	db.exec(`INSERT INTO envelope_send_command (
		organization_id,envelope_id,actor_type,actor_id,idempotency_key,request_hash,
		expected_generation,ready_audit_event_id,commit_sha,initial_routing_order,
		delivery_count,queued_delivery_count,delivery_manifest_hash,delivery_manifest_json,initial_capability_expires_at,
		updated_at,audit_event_id,audit_sequence,previous_audit_hash,audit_event_hash,audit_payload_json
	) VALUES ('org-1','env-1','user','user-1','send-1','request-hash',2,'ready-audit','commit-2',1,
		1,1,'manifest-hash','[]','2026-09-25T00:02:00.000Z','2026-09-11T00:02:00.000Z',
		'sent-audit',3,'hash-2','hash-3','{}')`);
}

function reserveDelivery(db: DatabaseSync): void {
	db.exec(`
		UPDATE recipient SET capability_hash='cap-hash', capability_expires_at='2026-09-25T00:02:00.000Z', updated_at='2026-09-11T00:02:00.000Z'
		WHERE organization_id='org-1' AND id='recipient-1';
		INSERT INTO delivery_outbox (id,organization_id,envelope_id,recipient_id,kind,status,capability_hash,reserved_capability_expires_at,
			sealed_capability,sealing_key_id,sealed_capability_sha256,available_at,attempts,created_at,updated_at)
		VALUES ('delivery-1','org-1','env-1','recipient-1','recipient_invitation','pending','cap-hash',
			'2026-09-25T00:02:00.000Z','sealed','key-1','sealed-hash','2026-09-11T00:02:00.000Z',0,'2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z');
	`);
}

describe('D1 envelope send migration', () => {
	it('publishes sent only after the final guard verifies capability and outbox rows', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertCommand(db);
			reserveDelivery(db);
			db.exec("INSERT INTO envelope_send_publish VALUES ('org-1','user','user-1','send-1')");
			db.exec('COMMIT');
			const envelope = db
				.prepare("SELECT status, sent_commit_sha FROM envelope WHERE id='env-1'")
				.get() as { status: string; sent_commit_sha: string };
			expect(envelope).toEqual({ status: 'sent', sent_commit_sha: 'commit-2' });
			const event = db
				.prepare("SELECT event_type FROM audit_event WHERE id='sent-audit'")
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
			const envelope = db.prepare("SELECT status FROM envelope WHERE id='env-1'").get() as {
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
			db.exec("UPDATE recipient SET status='viewed' WHERE id='recipient-1'");
			db.exec('BEGIN');
			insertCommand(db);
			db.exec(`
				UPDATE recipient SET capability_hash='cap-hash', capability_expires_at='2026-09-25T00:02:00.000Z'
				WHERE organization_id='org-1' AND id='recipient-1' AND status='pending'
					AND capability_hash IS NULL AND capability_expires_at IS NULL;
				INSERT INTO delivery_outbox (id,organization_id,envelope_id,recipient_id,kind,status,capability_hash,
					reserved_capability_expires_at,sealed_capability,sealing_key_id,sealed_capability_sha256,
					available_at,attempts,created_at,updated_at)
				VALUES ('delivery-1','org-1','env-1','recipient-1','recipient_invitation','pending','cap-hash',
					'2026-09-25T00:02:00.000Z','sealed','key-1','sealed-hash','2026-09-11T00:02:00.000Z',
					0,'2026-09-11T00:02:00.000Z','2026-09-11T00:02:00.000Z');
			`);
			expect((): void =>
				db.exec("INSERT INTO envelope_send_publish VALUES ('org-1','user','user-1','send-1')")
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');
			const envelope = db.prepare("SELECT status FROM envelope WHERE id='env-1'").get() as {
				status: string;
			};
			expect(envelope.status).toBe('ready');
		} finally {
			db.close();
		}
	});
});
