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
	'migrations/d1/0007_recipient_declined.sql',
	'migrations/d1/0008_recipient_approved.sql',
	'migrations/d1/0009_field_placement.sql',
	'migrations/d1/0010_recipient_signed.sql'
];

const FAR_FUTURE: string = '2026-09-25T00:00:00.000Z';
const NEXT_EXPIRY: string = '2026-09-25T12:00:00.000Z';
const SIGNED_AT: string = '2026-09-11T00:04:00.000Z';
const SENT_AT: string = '2026-09-11T00:01:00.000Z';
const VIEWED_AT: string = '2026-09-11T00:02:00.000Z';
const CIPHERTEXT: string = 'sealed-ciphertext-3';

function database(): DatabaseSync {
	const db: DatabaseSync = new DatabaseSync(':memory:');
	for (const path of migrationPaths) db.exec(readFileSync(path, 'utf8'));
	db.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('org-1','org-1','Workspace','2026-09-11T00:00:00.000Z');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, repository_head,
			sent_commit_sha, field_generation, created_at, updated_at
		) VALUES (
			'env-1','org-1','Agreement','in_progress',3,'commit-3','commit-3',1,
			'2026-09-11T00:00:00.000Z','${VIEWED_AT}'
		);
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'sent-audit','org-1','env-1',3,'envelope.sent','user','user-1','{}',
			'hash-2','hash-3','${SENT_AT}'
		);
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'viewed-audit','org-1','env-1',4,'recipient.viewed','recipient','recipient-1','{}',
			'hash-3','hash-4','${VIEWED_AT}'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
		) VALUES (
			'recipient-1','org-1','env-1','a@example.com','A','signer','en',1,'viewed',
			'cap-hash-1','${FAR_FUTURE}',NULL,'${SENT_AT}','${VIEWED_AT}'
		);
		INSERT INTO recipient (
			id, organization_id, envelope_id, email, name, role, locale, routing_order, status,
			capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
		) VALUES (
			'recipient-2','org-1','env-1','b@example.com','B','signer','en',1,'viewed',
			'cap-hash-2','${FAR_FUTURE}',NULL,'${SENT_AT}','${VIEWED_AT}'
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
			'${FAR_FUTURE}','sealed-1','key-1','sealed-hash-1','${SENT_AT}',0,'${SENT_AT}','${SENT_AT}'
		);
		INSERT INTO delivery_outbox (
			id, organization_id, envelope_id, recipient_id, kind, status, capability_hash,
			reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
			available_at, attempts, created_at, updated_at
		) VALUES (
			'delivery-3','org-1','env-1','recipient-3','recipient_invitation','blocked','cap-hash-3',
			NULL,'${CIPHERTEXT}','key-1','sealed-hash-3',NULL,0,'${SENT_AT}','${SENT_AT}'
		);
		INSERT INTO envelope_field (
			id, organization_id, envelope_id, recipient_id, document_path, field_type, label,
			required, position, created_at, updated_at
		) VALUES (
			'field-1','org-1','env-1','recipient-1','documents/agreement.md','signature','Your signature',
			1,0,'${SENT_AT}','${SENT_AT}'
		);
	`);
	return db;
}

interface SignedCommandFields {
	recipientId: string;
	idempotencyKey: string;
	capabilityHash: string;
	auditEventId: string;
	auditSequence: number;
	previousAuditHash: string;
	auditEventHash: string;
	sentCommitSha?: string;
	expectedFieldGeneration?: number;
	fieldValuesJson?: string;
	fieldCount?: number;
	updatedAt?: string;
	routingOrder?: number;
	nextRoutingOrder?: number | null;
	nextCapabilityExpiresAt?: string | null;
	releasedDeliveryCount?: number;
	completedAuditEventId?: string | null;
	completedAuditEventHash?: string | null;
	completedAuditPayloadJson?: string | null;
}

const defaultFieldValuesJson: string = JSON.stringify([
	{ id: 'field-1', fieldType: 'signature', valueSha256: 'value-hash-1' }
]);

function insertSignedCommand(db: DatabaseSync, fields: SignedCommandFields): void {
	db.prepare(
		`INSERT INTO recipient_signed_command (
			organization_id, envelope_id, recipient_id, recipient_role, routing_order,
			actor_type, actor_id, idempotency_key, request_hash, capability_hash,
			sent_commit_sha, expected_field_generation, field_values_json, field_count,
			updated_at, next_routing_order, next_capability_expires_at,
			released_delivery_count, audit_event_id, audit_sequence,
			previous_audit_hash, audit_event_hash, audit_payload_json,
			completed_audit_event_id, completed_audit_event_hash, completed_audit_payload_json
		) VALUES ('org-1','env-1',?,'signer',?,'recipient',?,?,'request-hash',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
	).run(
		fields.recipientId,
		fields.routingOrder ?? 1,
		fields.recipientId,
		fields.idempotencyKey,
		fields.capabilityHash,
		fields.sentCommitSha ?? 'commit-3',
		fields.expectedFieldGeneration ?? 1,
		fields.fieldValuesJson ?? defaultFieldValuesJson,
		fields.fieldCount ?? 1,
		fields.updatedAt ?? SIGNED_AT,
		fields.nextRoutingOrder ?? null,
		fields.nextCapabilityExpiresAt ?? null,
		fields.releasedDeliveryCount ?? 0,
		fields.auditEventId,
		fields.auditSequence,
		fields.previousAuditHash,
		fields.auditEventHash,
		'{}',
		fields.completedAuditEventId ?? null,
		fields.completedAuditEventHash ?? null,
		fields.completedAuditPayloadJson ?? null
	);
}

function insertFieldValue(
	db: DatabaseSync,
	overrides: {
		fieldId?: string;
		recipientId?: string;
		fieldType?: string;
		valueJson?: string;
		valueSha256?: string;
	} = {}
): void {
	db.prepare(
		`INSERT INTO field_value (
			organization_id, field_id, envelope_id, recipient_id, field_type,
			value_json, value_sha256, created_at
		) VALUES ('org-1', ?, 'env-1', ?, ?, ?, ?, ?)`
	).run(
		overrides.fieldId ?? 'field-1',
		overrides.recipientId ?? 'recipient-1',
		overrides.fieldType ?? 'signature',
		overrides.valueJson ?? JSON.stringify('Jane Doe'),
		overrides.valueSha256 ?? 'value-hash-1',
		SIGNED_AT
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
): {
	status: string;
	capability_revoked_at: string | null;
	capability_expires_at: string | null;
} {
	return db
		.prepare(
			'SELECT status, capability_revoked_at, capability_expires_at FROM recipient WHERE id = ?'
		)
		.get(recipientId) as {
		status: string;
		capability_revoked_at: string | null;
		capability_expires_at: string | null;
	};
}

function commandCount(db: DatabaseSync): number {
	return (
		db.prepare('SELECT count(*) AS count FROM recipient_signed_command').get() as {
			count: number;
		}
	).count;
}

function auditEventCount(db: DatabaseSync): number {
	return (db.prepare('SELECT count(*) AS count FROM audit_event').get() as { count: number }).count;
}

function fieldValueCount(db: DatabaseSync): number {
	return (db.prepare('SELECT count(*) AS count FROM field_value').get() as { count: number }).count;
}

function outboxRow(
	db: DatabaseSync,
	recipientId: string
): {
	status: string;
	available_at: string | null;
	sealed_capability: string | null;
	reserved_capability_expires_at: string | null;
} {
	return db
		.prepare(
			`SELECT status, available_at, sealed_capability, reserved_capability_expires_at
			 FROM delivery_outbox WHERE recipient_id = ?`
		)
		.get(recipientId) as {
		status: string;
		available_at: string | null;
		sealed_capability: string | null;
		reserved_capability_expires_at: string | null;
	};
}

describe('D1 recipient signed migration', () => {
	it('completes the actor, revokes only its capability, stores the field value, and appends recipient.signed', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertSignedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'signed-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'signed-audit-1',
				auditSequence: 5,
				previousAuditHash: 'hash-4',
				auditEventHash: 'hash-5'
			});
			insertFieldValue(db);
			db.exec('COMMIT');

			expect(envelopeState(db)).toEqual({ status: 'in_progress', sent_commit_sha: 'commit-3' });
			expect(recipientRow(db, 'recipient-1')).toEqual({
				status: 'completed',
				capability_revoked_at: SIGNED_AT,
				capability_expires_at: FAR_FUTURE
			});
			expect(recipientRow(db, 'recipient-2')).toEqual({
				status: 'viewed',
				capability_revoked_at: null,
				capability_expires_at: FAR_FUTURE
			});
			const event = db
				.prepare(
					"SELECT event_type, actor_type, actor_id FROM audit_event WHERE id = 'signed-audit-1'"
				)
				.get() as { event_type: string; actor_type: string; actor_id: string };
			expect(event).toEqual({
				event_type: 'recipient.signed',
				actor_type: 'recipient',
				actor_id: 'recipient-1'
			});
			expect(auditEventCount(db)).toBe(3);
			expect(fieldValueCount(db)).toBe(1);
			const stored = db
				.prepare('SELECT value_json, value_sha256 FROM field_value WHERE field_id = ?')
				.get('field-1') as { value_json: string; value_sha256: string };
			expect(stored).toEqual({
				value_json: JSON.stringify('Jane Doe'),
				value_sha256: 'value-hash-1'
			});
			expect(outboxRow(db, 'recipient-3')).toEqual({
				status: 'blocked',
				available_at: null,
				sealed_capability: CIPHERTEXT,
				reserved_capability_expires_at: null
			});
		} finally {
			db.close();
		}
	});

	it('publishes a signer completion when the exact assigned field set is empty', () => {
		const db: DatabaseSync = database();
		try {
			db.exec("DELETE FROM envelope_field WHERE recipient_id = 'recipient-1'");
			insertSignedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'signed-empty',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'signed-audit-empty',
				auditSequence: 5,
				previousAuditHash: 'hash-4',
				auditEventHash: 'hash-5',
				fieldValuesJson: '[]',
				fieldCount: 0
			});

			expect(recipientRow(db, 'recipient-1').status).toBe('completed');
			expect(commandCount(db)).toBe(1);
			expect(fieldValueCount(db)).toBe(0);
			expect(auditEventCount(db)).toBe(3);
		} finally {
			db.close();
		}
	});

	it('releases the next routing group only after the current group has no outstanding non-CC recipient', () => {
		const db: DatabaseSync = database();
		try {
			db.exec("UPDATE recipient SET status = 'completed' WHERE id = 'recipient-2'");
			db.exec('BEGIN');
			insertSignedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'signed-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'signed-audit-1',
				auditSequence: 5,
				previousAuditHash: 'hash-4',
				auditEventHash: 'hash-5',
				nextRoutingOrder: 2,
				nextCapabilityExpiresAt: NEXT_EXPIRY,
				releasedDeliveryCount: 1
			});
			insertFieldValue(db);
			db.exec('COMMIT');

			expect(envelopeState(db).status).toBe('in_progress');
			expect(recipientRow(db, 'recipient-3')).toEqual({
				status: 'pending',
				capability_revoked_at: null,
				capability_expires_at: NEXT_EXPIRY
			});
			expect(outboxRow(db, 'recipient-3')).toEqual({
				status: 'pending',
				available_at: SIGNED_AT,
				sealed_capability: CIPHERTEXT,
				reserved_capability_expires_at: NEXT_EXPIRY
			});
			expect(auditEventCount(db)).toBe(3);
		} finally {
			db.close();
		}
	});

	it('completes the envelope and appends a chained envelope.completed event when no non-CC recipients remain', () => {
		const db: DatabaseSync = database();
		try {
			db.exec(
				"UPDATE recipient SET status = 'completed' WHERE id IN ('recipient-2','recipient-3')"
			);
			db.exec('BEGIN');
			insertSignedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'signed-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'signed-audit-1',
				auditSequence: 5,
				previousAuditHash: 'hash-4',
				auditEventHash: 'hash-5',
				completedAuditEventId: 'completed-audit-1',
				completedAuditEventHash: 'hash-6',
				completedAuditPayloadJson: '{}'
			});
			insertFieldValue(db);
			db.exec('COMMIT');

			expect(envelopeState(db)).toEqual({ status: 'completed', sent_commit_sha: 'commit-3' });
			const events = db
				.prepare(
					`SELECT sequence, event_type, previous_hash, event_hash
					 FROM audit_event WHERE envelope_id = ? ORDER BY sequence`
				)
				.all('env-1') as Array<{
				sequence: number;
				event_type: string;
				previous_hash: string;
				event_hash: string;
			}>;
			expect(events).toEqual([
				{ sequence: 3, event_type: 'envelope.sent', previous_hash: 'hash-2', event_hash: 'hash-3' },
				{
					sequence: 4,
					event_type: 'recipient.viewed',
					previous_hash: 'hash-3',
					event_hash: 'hash-4'
				},
				{
					sequence: 5,
					event_type: 'recipient.signed',
					previous_hash: 'hash-4',
					event_hash: 'hash-5'
				},
				{
					sequence: 6,
					event_type: 'envelope.completed',
					previous_hash: 'hash-5',
					event_hash: 'hash-6'
				}
			]);
		} finally {
			db.close();
		}
	});

	it('rejects a same-recipient replay attempt at the unique-index boundary without mutating state', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertSignedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'signed-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'signed-audit-1',
				auditSequence: 5,
				previousAuditHash: 'hash-4',
				auditEventHash: 'hash-5'
			});
			insertFieldValue(db);
			db.exec('COMMIT');

			expect((): void =>
				insertSignedCommand(db, {
					recipientId: 'recipient-1',
					idempotencyKey: 'signed-2',
					capabilityHash: 'cap-hash-1',
					auditEventId: 'signed-audit-2',
					auditSequence: 6,
					previousAuditHash: 'hash-5',
					auditEventHash: 'hash-6'
				})
			).toThrow(/UNIQUE constraint failed/);

			expect(commandCount(db)).toBe(1);
			expect(auditEventCount(db)).toBe(3);
			expect(recipientRow(db, 'recipient-1').status).toBe('completed');
		} finally {
			db.close();
		}
	});

	it.each([
		['a stale (mismatched) capability hash', { capabilityHash: 'wrong-hash' }],
		['a revoked capability', { revoke: true }],
		['an expired capability', { expired: true }],
		['a pending recipient', { pending: true }],
		['an approver', { role: 'approver' as const }]
	])(
		'aborts and writes nothing for %s',
		(
			_label,
			overrides: {
				capabilityHash?: string;
				revoke?: boolean;
				expired?: boolean;
				pending?: boolean;
				role?: 'approver';
			}
		) => {
			const db: DatabaseSync = database();
			try {
				if (overrides.revoke === true) {
					db.exec(
						"UPDATE recipient SET capability_revoked_at = '2026-09-11T00:03:00.000Z' WHERE id = 'recipient-1'"
					);
				}
				if (overrides.expired === true) {
					db.exec(
						"UPDATE recipient SET capability_expires_at = '2026-09-11T00:03:00.000Z' WHERE id = 'recipient-1'"
					);
				}
				if (overrides.pending === true) {
					db.exec("UPDATE recipient SET status = 'pending' WHERE id = 'recipient-1'");
				}
				if (overrides.role !== undefined) {
					db.exec(`UPDATE recipient SET role = '${overrides.role}' WHERE id = 'recipient-1'`);
				}
				db.exec('BEGIN');
				expect((): void =>
					insertSignedCommand(db, {
						recipientId: 'recipient-1',
						idempotencyKey: 'signed-1',
						capabilityHash: overrides.capabilityHash ?? 'cap-hash-1',
						auditEventId: 'signed-audit-1',
						auditSequence: 5,
						previousAuditHash: 'hash-4',
						auditEventHash: 'hash-5'
					})
				).toThrow(/publish conflict|CHECK constraint failed/);
				db.exec('ROLLBACK');

				expect(envelopeState(db)).toEqual({ status: 'in_progress', sent_commit_sha: 'commit-3' });
				expect(recipientRow(db, 'recipient-1').status).toBe(
					overrides.pending === true ? 'pending' : 'viewed'
				);
				expect(commandCount(db)).toBe(0);
				expect(auditEventCount(db)).toBe(2);
				expect(fieldValueCount(db)).toBe(0);
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
				insertSignedCommand(db, {
					recipientId: 'recipient-1',
					idempotencyKey: 'signed-1',
					capabilityHash: 'cap-hash-1',
					auditEventId: 'signed-audit-1',
					auditSequence: 5,
					previousAuditHash: 'stale-hash',
					auditEventHash: 'hash-5'
				})
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');

			expect(recipientRow(db, 'recipient-1').status).toBe('viewed');
			expect(commandCount(db)).toBe(0);
			expect(auditEventCount(db)).toBe(2);
		} finally {
			db.close();
		}
	});

	it('rolls back when the field generation no longer matches the pinned expectation', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			expect((): void =>
				insertSignedCommand(db, {
					recipientId: 'recipient-1',
					idempotencyKey: 'signed-1',
					capabilityHash: 'cap-hash-1',
					auditEventId: 'signed-audit-1',
					auditSequence: 5,
					previousAuditHash: 'hash-4',
					auditEventHash: 'hash-5',
					expectedFieldGeneration: 2
				})
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');

			expect(recipientRow(db, 'recipient-1').status).toBe('viewed');
			expect(commandCount(db)).toBe(0);
		} finally {
			db.close();
		}
	});

	it('rolls back when the declared field count does not match the recipient own fields', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			expect((): void =>
				insertSignedCommand(db, {
					recipientId: 'recipient-1',
					idempotencyKey: 'signed-1',
					capabilityHash: 'cap-hash-1',
					auditEventId: 'signed-audit-1',
					auditSequence: 5,
					previousAuditHash: 'hash-4',
					auditEventHash: 'hash-5',
					fieldCount: 2,
					fieldValuesJson: JSON.stringify([
						{ id: 'field-1', fieldType: 'signature', valueSha256: 'value-hash-1' },
						{ id: 'field-missing', fieldType: 'text', valueSha256: 'value-hash-2' }
					])
				})
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');

			expect(recipientRow(db, 'recipient-1').status).toBe('viewed');
			expect(commandCount(db)).toBe(0);
		} finally {
			db.close();
		}
	});

	it('rolls back when a declared field references a field ID this recipient does not own', () => {
		const db: DatabaseSync = database();
		try {
			db.exec(`
				INSERT INTO envelope_field (
					id, organization_id, envelope_id, recipient_id, document_path, field_type, label,
					required, position, created_at, updated_at
				) VALUES (
					'field-2','org-1','env-1','recipient-2','documents/agreement.md','text','Other',
					0,1,'${SENT_AT}','${SENT_AT}'
				);
			`);
			db.exec('BEGIN');
			expect((): void =>
				insertSignedCommand(db, {
					recipientId: 'recipient-1',
					idempotencyKey: 'signed-1',
					capabilityHash: 'cap-hash-1',
					auditEventId: 'signed-audit-1',
					auditSequence: 5,
					previousAuditHash: 'hash-4',
					auditEventHash: 'hash-5',
					fieldValuesJson: JSON.stringify([
						{ id: 'field-2', fieldType: 'text', valueSha256: 'value-hash-2' }
					])
				})
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');

			expect(recipientRow(db, 'recipient-1').status).toBe('viewed');
			expect(commandCount(db)).toBe(0);
		} finally {
			db.close();
		}
	});

	it('rolls back the entire batch when a field_value insert violates the field-identity foreign key', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertSignedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'signed-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'signed-audit-1',
				auditSequence: 5,
				previousAuditHash: 'hash-4',
				auditEventHash: 'hash-5'
			});
			// The command itself publishes (recipient completes), but the
			// application's later field_value insert claims the wrong recipient
			// for this field. The composite foreign key must reject it and the
			// whole transaction must roll back, including the completion above.
			expect((): void => insertFieldValue(db, { recipientId: 'recipient-2' })).toThrow(
				/FOREIGN KEY constraint failed/
			);
			db.exec('ROLLBACK');

			expect(recipientRow(db, 'recipient-1').status).toBe('viewed');
			expect(commandCount(db)).toBe(0);
			expect(fieldValueCount(db)).toBe(0);
			expect(auditEventCount(db)).toBe(2);
		} finally {
			db.close();
		}
	});

	it('rolls back when field_values_json length does not match field_count', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			expect((): void =>
				insertSignedCommand(db, {
					recipientId: 'recipient-1',
					idempotencyKey: 'signed-1',
					capabilityHash: 'cap-hash-1',
					auditEventId: 'signed-audit-1',
					auditSequence: 5,
					previousAuditHash: 'hash-4',
					auditEventHash: 'hash-5',
					fieldCount: 1,
					fieldValuesJson: JSON.stringify([])
				})
			).toThrow(/publish conflict/);
			db.exec('ROLLBACK');
			expect(commandCount(db)).toBe(0);
		} finally {
			db.close();
		}
	});

	it('forbids a second value for an already-signed field (one-shot immutability)', () => {
		const db: DatabaseSync = database();
		try {
			db.exec('BEGIN');
			insertSignedCommand(db, {
				recipientId: 'recipient-1',
				idempotencyKey: 'signed-1',
				capabilityHash: 'cap-hash-1',
				auditEventId: 'signed-audit-1',
				auditSequence: 5,
				previousAuditHash: 'hash-4',
				auditEventHash: 'hash-5'
			});
			insertFieldValue(db);
			db.exec('COMMIT');

			expect((): void =>
				insertFieldValue(db, { valueJson: JSON.stringify('Someone Else') })
			).toThrow(/UNIQUE constraint failed/);
			expect(fieldValueCount(db)).toBe(1);
		} finally {
			db.close();
		}
	});
});
