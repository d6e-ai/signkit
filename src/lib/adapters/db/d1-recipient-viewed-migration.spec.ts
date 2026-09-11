import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationPaths: readonly string[] = [
	'migrations/d1/0001_core.sql',
	'migrations/d1/0002_envelope_commands.sql',
	'migrations/d1/0003_draft_revisions.sql',
	'migrations/d1/0004_envelope_ready.sql',
	'migrations/d1/0005_envelope_send.sql',
	'migrations/d1/0006_recipient_viewed.sql'
];

const FAR_FUTURE: string = '2026-09-25T00:00:00.000Z';
const VIEWED_AT: string = '2026-09-11T00:02:00.000Z';

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
			'2026-09-11T00:00:00.000Z','2026-09-11T00:01:00.000Z'
		);
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'sent-audit','org-1','env-1',3,'envelope.sent','user','user-1','{}',
			'hash-2','hash-3','2026-09-11T00:01:00.000Z'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
		) VALUES (
			'recipient-1','org-1','env-1','a@example.com','A','signer','en',1,'pending',
			'cap-hash-1','${FAR_FUTURE}',NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
		) VALUES (
			'recipient-2','org-1','env-1','b@example.com','B','signer','en',2,'pending',
			'cap-hash-2','${FAR_FUTURE}',NULL,'2026-09-11T00:01:00.000Z','2026-09-11T00:01:00.000Z'
		);
	`);
	return db;
}

interface ViewedCommandFields {
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
}

function insertViewedCommand(db: DatabaseSync, fields: ViewedCommandFields): void {
	db.prepare(
		`INSERT INTO recipient_viewed_command (
			organization_id, envelope_id, recipient_id, recipient_role, routing_order,
			actor_type, actor_id, idempotency_key, request_hash, capability_hash,
			sent_commit_sha, updated_at, audit_event_id, audit_sequence,
			previous_audit_hash, audit_event_hash, audit_payload_json
		) VALUES ('org-1','env-1',?,'signer',?,'recipient',?,?,'request-hash',?,?,?,?,?,?,?,'{}')`
	).run(
		fields.recipientId,
		fields.routingOrder ?? 1,
		fields.recipientId,
		fields.idempotencyKey,
		fields.capabilityHash,
		fields.sentCommitSha ?? 'commit-3',
		fields.updatedAt ?? VIEWED_AT,
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

function recipientStatus(db: DatabaseSync, recipientId: string): string {
	return (
		db.prepare('SELECT status FROM recipient WHERE id = ?').get(recipientId) as { status: string }
	).status;
}

function commandCount(db: DatabaseSync): number {
	return (
		db.prepare('SELECT count(*) AS count FROM recipient_viewed_command').get() as {
			count: number;
		}
	).count;
}

function auditEventCount(db: DatabaseSync): number {
	return (db.prepare('SELECT count(*) AS count FROM audit_event').get() as { count: number }).count;
}

describe('D1 recipient viewed migration', () => {
	it('publishes pending to viewed, envelope sent to in_progress, and one audit event atomically', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertViewedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'viewed-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'viewed-audit-1',
				auditSequence: 4,
				previousAuditHash: 'hash-3',
				auditEventHash: 'hash-4'
			});
			db.exec('COMMIT');

			expect(envelopeState(db)).toEqual({ status: 'in_progress', sent_commit_sha: 'commit-3' });
			expect(recipientStatus(db, 'recipient-1')).toBe('viewed');
			expect(recipientStatus(db, 'recipient-2')).toBe('pending');
			const event = db
				.prepare(
					"SELECT event_type, actor_type, actor_id FROM audit_event WHERE id = 'viewed-audit-1'"
				)
				.get() as { event_type: string; actor_type: string; actor_id: string };
			expect(event).toEqual({
				event_type: 'recipient.viewed',
				actor_type: 'recipient',
				actor_id: 'recipient-1'
			});
		} finally {
			db.close();
		}
	});

	it('leaves envelope in_progress unchanged when a second recipient views the same envelope', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertViewedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'viewed-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'viewed-audit-1',
				auditSequence: 4,
				previousAuditHash: 'hash-3',
				auditEventHash: 'hash-4'
			});
			db.exec('COMMIT');

			db.exec('BEGIN');
			insertViewedCommand(db, {
				recipientId: 'recipient-2',
				idempotencyKey: 'viewed-2',
				capabilityHash: 'cap-hash-2',
				routingOrder: 2,
				auditEventId: 'viewed-audit-2',
				auditSequence: 5,
				previousAuditHash: 'hash-4',
				auditEventHash: 'hash-5'
			});
			db.exec('COMMIT');

			expect(envelopeState(db)).toEqual({ status: 'in_progress', sent_commit_sha: 'commit-3' });
			expect(recipientStatus(db, 'recipient-2')).toBe('viewed');
			expect(auditEventCount(db)).toBe(3);
		} finally {
			db.close();
		}
	});

	it('rejects a same-recipient replay attempt at the unique-index boundary without mutating state', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertViewedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'viewed-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'viewed-audit-1',
				auditSequence: 4,
				previousAuditHash: 'hash-3',
				auditEventHash: 'hash-4'
			});
			db.exec('COMMIT');

			expect((): void =>
				insertViewedCommand(db, {
					recipientId: 'recipient-1',
					idempotencyKey: 'viewed-2',
					capabilityHash: 'cap-hash-1',
					auditEventId: 'viewed-audit-2',
					auditSequence: 5,
					previousAuditHash: 'hash-4',
					auditEventHash: 'hash-5'
				})
			).toThrow(/UNIQUE constraint failed/);

			expect(commandCount(db)).toBe(1);
			expect(auditEventCount(db)).toBe(2);
			expect(recipientStatus(db, 'recipient-1')).toBe('viewed');
		} finally {
			db.close();
		}
	});

	it.each([
		['a stale (mismatched) capability hash', { capabilityHash: 'wrong-hash' }],
		['a revoked capability', { revoke: true }],
		['an expired capability', { expired: true }]
	])(
		'aborts and writes nothing for %s',
		(_label, overrides: { capabilityHash?: string; revoke?: boolean; expired?: boolean }) => {
			const db: DatabaseSync = database();
			try {
				if (overrides.revoke === true) {
					db.exec(
						"UPDATE recipient SET capability_revoked_at = '2026-09-11T00:01:30.000Z' WHERE id = 'recipient-1'"
					);
				}
				if (overrides.expired === true) {
					db.exec(
						"UPDATE recipient SET capability_expires_at = '2026-09-11T00:01:30.000Z' WHERE id = 'recipient-1'"
					);
				}
				db.exec('BEGIN');
				expect((): void =>
					insertViewedCommand(db, {
						recipientId: 'recipient-1',
						idempotencyKey: 'viewed-1',
						capabilityHash: overrides.capabilityHash ?? 'cap-hash-1',
						auditEventId: 'viewed-audit-1',
						auditSequence: 4,
						previousAuditHash: 'hash-3',
						auditEventHash: 'hash-4'
					})
				).toThrow(/publish conflict/);
				db.exec('ROLLBACK');

				expect(envelopeState(db)).toEqual({ status: 'sent', sent_commit_sha: 'commit-3' });
				expect(recipientStatus(db, 'recipient-1')).toBe('pending');
				expect(commandCount(db)).toBe(0);
				expect(auditEventCount(db)).toBe(1);
			} finally {
				db.close();
			}
		}
	);

	it('aborts and writes nothing when a swapped capability targets the wrong recipient row', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			expect((): void =>
				insertViewedCommand(db, {
					recipientId: 'recipient-1',
					idempotencyKey: 'viewed-1',
					capabilityHash: 'cap-hash-2',
					routingOrder: 2,
					auditEventId: 'viewed-audit-1',
					auditSequence: 4,
					previousAuditHash: 'hash-3',
					auditEventHash: 'hash-4'
				})
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');

			expect(recipientStatus(db, 'recipient-1')).toBe('pending');
			expect(recipientStatus(db, 'recipient-2')).toBe('pending');
			expect(commandCount(db)).toBe(0);
			expect(auditEventCount(db)).toBe(1);
		} finally {
			db.close();
		}
	});

	it('rolls back the recipient transition when the audit head no longer matches', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			expect((): void =>
				insertViewedCommand(db, {
					recipientId: 'recipient-1',
					idempotencyKey: 'viewed-1',
					capabilityHash: 'cap-hash-1',
					auditEventId: 'viewed-audit-1',
					auditSequence: 4,
					previousAuditHash: 'stale-hash',
					auditEventHash: 'hash-4'
				})
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');

			expect(envelopeState(db)).toEqual({ status: 'sent', sent_commit_sha: 'commit-3' });
			expect(recipientStatus(db, 'recipient-1')).toBe('pending');
			expect(commandCount(db)).toBe(0);
			expect(auditEventCount(db)).toBe(1);
		} finally {
			db.close();
		}
	});

	it('resolves a two-recipient audit race by aborting the loser and keeping the winner intact', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertViewedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'viewed-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'viewed-audit-1',
				auditSequence: 4,
				previousAuditHash: 'hash-3',
				auditEventHash: 'hash-4'
			});
			db.exec('COMMIT');

			db.exec('BEGIN');
			expect((): void =>
				insertViewedCommand(db, {
					recipientId: 'recipient-2',
					idempotencyKey: 'viewed-2',
					capabilityHash: 'cap-hash-2',
					auditEventId: 'viewed-audit-2',
					auditSequence: 4,
					previousAuditHash: 'hash-3',
					auditEventHash: 'hash-5'
				})
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');

			expect(recipientStatus(db, 'recipient-1')).toBe('viewed');
			expect(recipientStatus(db, 'recipient-2')).toBe('pending');
			expect(envelopeState(db)).toEqual({ status: 'in_progress', sent_commit_sha: 'commit-3' });
			expect(commandCount(db)).toBe(1);
			expect(auditEventCount(db)).toBe(2);
			const events = db
				.prepare(
					'SELECT sequence, event_type FROM audit_event WHERE envelope_id = ? ORDER BY sequence'
				)
				.all('env-1') as Array<{ sequence: number; event_type: string }>;
			expect(events).toEqual([
				{ sequence: 3, event_type: 'envelope.sent' },
				{ sequence: 4, event_type: 'recipient.viewed' }
			]);
		} finally {
			db.close();
		}
	});
});
