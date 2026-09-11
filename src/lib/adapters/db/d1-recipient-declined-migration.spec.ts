import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationPaths: readonly string[] = [
	'migrations/d1/0001_core.sql',
	'migrations/d1/0002_envelope_commands.sql',
	'migrations/d1/0003_draft_revisions.sql',
	'migrations/d1/0004_envelope_ready.sql',
	'migrations/d1/0005_envelope_send.sql',
	'migrations/d1/0006_recipient_viewed.sql',
	'migrations/d1/0007_recipient_declined.sql'
];

const FAR_FUTURE: string = '2026-09-25T00:00:00.000Z';
const DECLINED_AT: string = '2026-09-11T00:03:00.000Z';
const SENT_AT: string = '2026-09-11T00:01:00.000Z';

function database(): DatabaseSync {
	const db: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of migrationPaths) db.exec(readFileSync(path, 'utf8'));
	db.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('org-1','org-1','Workspace','2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			sent_commit_sha, created_at, updated_at
		) VALUES (
			'env-1','org-1','Agreement','sent',3,'commit-3','commit-3',
			'2026-09-11T00:00:00.000Z','${SENT_AT}'
		);
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'sent-audit','org-1','env-1',3,'envelope.sent','user','user-1','{}',
			'hash-2','hash-3','${SENT_AT}'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
		) VALUES (
			'recipient-1','org-1','env-1','a@example.com','A','signer','en',1,'pending',
			'cap-hash-1','${FAR_FUTURE}',NULL,'${SENT_AT}','${SENT_AT}'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
		) VALUES (
			'recipient-2','org-1','env-1','b@example.com','B','signer','en',1,'pending',
			'cap-hash-2','${FAR_FUTURE}',NULL,'${SENT_AT}','${SENT_AT}'
		);
			INSERT INTO recipient (
				id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
				capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
			) VALUES (
				'recipient-3','org-1','env-1','c@example.com','C','signer','en',2,'pending',
				'cap-hash-3',NULL,NULL,'${SENT_AT}','${SENT_AT}'
			);
			INSERT INTO recipient (
				id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
				capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
			) VALUES (
				'recipient-cc','org-1','env-1','cc@example.com','CC','cc','en',1,'pending',
				NULL,NULL,NULL,'${SENT_AT}','${SENT_AT}'
			);
		INSERT INTO delivery_outbox (
			id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
			reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
			available_at, attempts, created_at, updated_at
		) VALUES (
			'delivery-1','org-1','env-1','recipient-1','recipient_invitation','pending','cap-hash-1',
			'${FAR_FUTURE}','sealed','key-1','sealed-hash','${SENT_AT}',0,'${SENT_AT}','${SENT_AT}'
		);
		INSERT INTO delivery_outbox (
			id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
			reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
			available_at, attempts, created_at, updated_at
		) VALUES (
			'delivery-3','org-1','env-1','recipient-3','recipient_invitation','blocked','cap-hash-3',
			NULL,'sealed','key-1','sealed-hash',NULL,0,'${SENT_AT}','${SENT_AT}'
		);
	`);
	return db;
}

interface DeclinedCommandFields {
	recipientId: string;
	idempotencyKey: string;
	capabilityHash: string;
	auditEventId: string;
	auditSequence: number;
	previousAuditHash: string;
	auditEventHash: string;
	sentCommitSha?: string;
	updatedAt?: string;
	routingOrder?: number;
	recipientRole?: 'signer' | 'approver';
}

function insertDeclinedCommand(db: DatabaseSync, fields: DeclinedCommandFields): void {
	db.prepare(
		`INSERT INTO recipient_declined_command (
			organization_id, envelope_id, recipient_id, recipient_role, routing_order,
			actor_type, actor_id, idempotency_key, request_hash, capability_hash,
			sent_commit_sha, updated_at, audit_event_id, audit_sequence,
			previous_audit_hash, audit_event_hash, audit_payload_json
		) VALUES ('org-1','env-1',?,?,?,'recipient',?,?,'request-hash',?,?,?,?,?,?,?,'{}')`
	).run(
		fields.recipientId,
		fields.recipientRole ?? 'signer',
		fields.routingOrder ?? 1,
		fields.recipientId,
		fields.idempotencyKey,
		fields.capabilityHash,
		fields.sentCommitSha ?? 'commit-3',
		fields.updatedAt ?? DECLINED_AT,
		fields.auditEventId,
		fields.auditSequence,
		fields.previousAuditHash,
		fields.auditEventHash
	);
}

function envelopeState(db: DatabaseSync): { status: string; sent_commit_sha: string } {
	return db.prepare("SELECT status, sent_commit_sha FROM envelope WHERE id = 'env-1'").get() as {
		status: string;
		sent_commit_sha: string;
	};
}

function recipientRow(
	db: DatabaseSync,
	recipientId: string
): { status: string; capability_revoked_at: string | null } {
	return db
		.prepare('SELECT status, capability_revoked_at FROM recipient WHERE id = ?')
		.get(recipientId) as { status: string; capability_revoked_at: string | null };
}

function commandCount(db: DatabaseSync): number {
	return (
		db.prepare('SELECT count(*) AS count FROM recipient_declined_command').get() as {
			count: number;
		}
	).count;
}

function auditEventCount(db: DatabaseSync): number {
	return (db.prepare('SELECT count(*) AS count FROM audit_event').get() as { count: number }).count;
}

function outboxRow(
	db: DatabaseSync,
	recipientId: string
): { status: string; available_at: string | null } {
	return db
		.prepare('SELECT status, available_at FROM delivery_outbox WHERE recipient_id = ?')
		.get(recipientId) as { status: string; available_at: string | null };
}

describe('D1 recipient declined migration', () => {
	it('atomically declines the actor, revokes siblings without changing status, and appends one audit event', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertDeclinedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'declined-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'declined-audit-1',
				auditSequence: 4,
				previousAuditHash: 'hash-3',
				auditEventHash: 'hash-4'
			});
			db.exec('COMMIT');

			expect(envelopeState(db)).toEqual({ status: 'declined', sent_commit_sha: 'commit-3' });
			expect(recipientRow(db, 'recipient-1')).toEqual({
				status: 'declined',
				capability_revoked_at: DECLINED_AT
			});
			expect(recipientRow(db, 'recipient-2')).toEqual({
				status: 'pending',
				capability_revoked_at: DECLINED_AT
			});
			expect(recipientRow(db, 'recipient-3')).toEqual({
				status: 'pending',
				capability_revoked_at: DECLINED_AT
			});
			expect(recipientRow(db, 'recipient-cc')).toEqual({
				status: 'pending',
				capability_revoked_at: null
			});
			const event = db
				.prepare(
					"SELECT event_type, actor_type, actor_id FROM audit_event WHERE id = 'declined-audit-1'"
				)
				.get() as { event_type: string; actor_type: string; actor_id: string };
			expect(event).toEqual({
				event_type: 'recipient.declined',
				actor_type: 'recipient',
				actor_id: 'recipient-1'
			});
			expect(auditEventCount(db)).toBe(2);
		} finally {
			db.close();
		}
	});

	it('leaves blocked later-group outbox rows untouched', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertDeclinedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'declined-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'declined-audit-1',
				auditSequence: 4,
				previousAuditHash: 'hash-3',
				auditEventHash: 'hash-4'
			});
			db.exec('COMMIT');

			expect(outboxRow(db, 'recipient-1')).toEqual({ status: 'pending', available_at: SENT_AT });
			expect(outboxRow(db, 'recipient-3')).toEqual({ status: 'blocked', available_at: null });
			expect(readFileSync('migrations/d1/0007_recipient_declined.sql', 'utf8')).not.toMatch(
				/(?:INSERT INTO|UPDATE)\s+delivery_outbox/i
			);
		} finally {
			db.close();
		}
	});

	it('rejects a same-recipient replay attempt at the unique-index boundary without mutating state', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertDeclinedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'declined-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'declined-audit-1',
				auditSequence: 4,
				previousAuditHash: 'hash-3',
				auditEventHash: 'hash-4'
			});
			db.exec('COMMIT');

			expect((): void =>
				insertDeclinedCommand(db, {
					recipientId: 'recipient-1',
					idempotencyKey: 'declined-2',
					capabilityHash: 'cap-hash-1',
					auditEventId: 'declined-audit-2',
					auditSequence: 5,
					previousAuditHash: 'hash-4',
					auditEventHash: 'hash-5'
				})
			).toThrow(/UNIQUE constraint failed/);

			expect(commandCount(db)).toBe(1);
			expect(auditEventCount(db)).toBe(2);
			expect(recipientRow(db, 'recipient-1').status).toBe('declined');
		} finally {
			db.close();
		}
	});

	it.each([
		['a stale (mismatched) capability hash', { capabilityHash: 'wrong-hash' }],
		['a revoked capability', { revoke: true }],
		['an expired capability', { expired: true }],
		['a viewer', { role: 'viewer' as const }],
		['a prefill recipient', { role: 'prefill' as const }]
	])(
		'aborts and writes nothing for %s',
		(
			_label,
			overrides: {
				capabilityHash?: string;
				revoke?: boolean;
				expired?: boolean;
				role?: 'viewer' | 'prefill';
			}
		) => {
			const db: DatabaseSync = database();
			try {
				if (overrides.revoke === true) {
					db.exec(
						"UPDATE recipient SET capability_revoked_at = '2026-09-11T00:02:00.000Z' WHERE id = 'recipient-1'"
					);
				}
				if (overrides.expired === true) {
					db.exec(
						"UPDATE recipient SET capability_expires_at = '2026-09-11T00:02:00.000Z' WHERE id = 'recipient-1'"
					);
				}
				if (overrides.role !== undefined) {
					db.exec(`UPDATE recipient SET role = '${overrides.role}' WHERE id = 'recipient-1'`);
				}
				db.exec('BEGIN');
				expect((): void =>
					insertDeclinedCommand(db, {
						recipientId: 'recipient-1',
						idempotencyKey: 'declined-1',
						capabilityHash: overrides.capabilityHash ?? 'cap-hash-1',
						auditEventId: 'declined-audit-1',
						auditSequence: 4,
						previousAuditHash: 'hash-3',
						auditEventHash: 'hash-4'
					})
				).toThrow(/publish conflict/);
				db.exec('ROLLBACK');

				expect(envelopeState(db)).toEqual({ status: 'sent', sent_commit_sha: 'commit-3' });
				expect(recipientRow(db, 'recipient-1').status).toBe('pending');
				expect(recipientRow(db, 'recipient-2').capability_revoked_at).toBeNull();
				expect(commandCount(db)).toBe(0);
				expect(auditEventCount(db)).toBe(1);
				expect(outboxRow(db, 'recipient-3')).toEqual({ status: 'blocked', available_at: null });
			} finally {
				db.close();
			}
		}
	);

	it('rolls back the recipient transition when the audit head no longer matches', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			expect((): void =>
				insertDeclinedCommand(db, {
					recipientId: 'recipient-1',
					idempotencyKey: 'declined-1',
					capabilityHash: 'cap-hash-1',
					auditEventId: 'declined-audit-1',
					auditSequence: 4,
					previousAuditHash: 'stale-hash',
					auditEventHash: 'hash-4'
				})
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');

			expect(envelopeState(db)).toEqual({ status: 'sent', sent_commit_sha: 'commit-3' });
			expect(recipientRow(db, 'recipient-1')).toEqual({
				status: 'pending',
				capability_revoked_at: null
			});
			expect(recipientRow(db, 'recipient-2').capability_revoked_at).toBeNull();
			expect(commandCount(db)).toBe(0);
			expect(auditEventCount(db)).toBe(1);
		} finally {
			db.close();
		}
	});

	it('resolves concurrent recipient declines by aborting the loser and keeping the winner intact', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertDeclinedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'declined-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'declined-audit-1',
				auditSequence: 4,
				previousAuditHash: 'hash-3',
				auditEventHash: 'hash-4'
			});
			db.exec('COMMIT');

			db.exec('BEGIN');
			expect((): void =>
				insertDeclinedCommand(db, {
					recipientId: 'recipient-2',
					idempotencyKey: 'declined-2',
					capabilityHash: 'cap-hash-2',
					auditEventId: 'declined-audit-2',
					auditSequence: 4,
					previousAuditHash: 'hash-3',
					auditEventHash: 'hash-5'
				})
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');

			expect(recipientRow(db, 'recipient-1')).toEqual({
				status: 'declined',
				capability_revoked_at: DECLINED_AT
			});
			expect(recipientRow(db, 'recipient-2')).toEqual({
				status: 'pending',
				capability_revoked_at: DECLINED_AT
			});
			expect(envelopeState(db)).toEqual({ status: 'declined', sent_commit_sha: 'commit-3' });
			expect(commandCount(db)).toBe(1);
			expect(auditEventCount(db)).toBe(2);
			const events = db
				.prepare(
					'SELECT sequence, event_type FROM audit_event WHERE envelope_id = ? ORDER BY sequence'
				)
				.all('env-1') as Array<{ sequence: number; event_type: string }>;
			expect(events).toEqual([
				{ sequence: 3, event_type: 'envelope.sent' },
				{ sequence: 4, event_type: 'recipient.declined' }
			]);
			expect(outboxRow(db, 'recipient-3')).toEqual({ status: 'blocked', available_at: null });
		} finally {
			db.close();
		}
	});
});
