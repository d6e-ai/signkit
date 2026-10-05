import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	canonicalRecipientSignFingerprint,
	type PublishRecipientSignedCommand
} from '$lib/ports/recipient-sign-store';
import { D1RecipientSignStore } from './d1-recipient-sign-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ENVELOPE_ID: string = '01910000-0000-7000-8000-000000000201';
const RECIPIENT_ID: string = '01910000-0000-7000-8000-000000000202';
const SIBLING_ID: string = '01910000-0000-7000-8000-000000000203';
const FIELD_ID: string = '01910000-0000-7000-8000-000000000204';
const SIGNED_AUDIT_ID: string = '01910000-0000-7000-8000-000000000205';
const ACTOR_ID: string = 'user-1';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const CAPABILITY_HASH: string = 'a'.repeat(64);
const PREVIOUS_AUDIT_HASH: string = 'b'.repeat(64);
const SIGNED_AT: string = '2026-09-22T10:00:00.000Z';

function signedCommand(): PublishRecipientSignedCommand {
	const valueJson: string = JSON.stringify('Kyu');
	const valueSha256: string = createHash('sha256').update(valueJson).digest('hex');
	const requestFingerprint: string = createHash('sha256')
		.update(
			canonicalRecipientSignFingerprint({
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				capabilityHash: CAPABILITY_HASH,
				expectedFieldGeneration: 1,
				values: [{ fieldId: FIELD_ID, value: 'Kyu' }]
			})
		)
		.digest('hex');
	const auditPayloadJson: string = JSON.stringify({
		recipientId: RECIPIENT_ID,
		role: 'signer',
		routingOrder: 1,
		sentCommitSha: COMMIT_SHA,
		fields: [{ id: FIELD_ID, fieldType: 'signature', valueSha256 }],
		signedAt: SIGNED_AT
	});
	return {
		capabilityHash: CAPABILITY_HASH,
		expectedEnvelopeId: ENVELOPE_ID,
		expectedRecipientId: RECIPIENT_ID,
		idempotencyKey: 'signed-integration',
		requestFingerprint,
		recipientRole: 'signer',
		routingOrder: 1,
		expectedSentCommitSha: COMMIT_SHA,
		expectedFieldGeneration: 1,
		fieldValues: [{ fieldId: FIELD_ID, fieldType: 'signature', valueJson, valueSha256 }],
		updatedAt: SIGNED_AT,
		nextRoutingOrder: null,
		nextCapabilityExpiresAt: null,
		releasedDeliveryCount: 0,
		expectedAuditSequence: 6,
		previousAuditHash: PREVIOUS_AUDIT_HASH,
		auditEventId: SIGNED_AUDIT_ID,
		auditEventHash: 'c'.repeat(64),
		auditPayloadJson,
		completedAuditEventId: null,
		completedAuditEventHash: null,
		completedAuditPayloadJson: null
	};
}

function fixture(): { sqlite: DatabaseSync; store: D1RecipientSignStore } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${ACTOR_ID}', 'owner', 'active', '2026-09-22T08:00:00.000Z', '2026-09-22T08:00:00.000Z');
		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, sent_commit_sha,
			field_generation, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', '${ACTOR_ID}', 'Agreement', 'in_progress', 1, '${COMMIT_SHA}',
			'archives/integration.git.gz', '${'d'.repeat(64)}', '${COMMIT_SHA}', 1,
			'2026-09-22T08:00:00.000Z', '2026-09-22T09:00:00.000Z'
		);
		INSERT INTO recipient (
			id, envelope_id, email, name, role, locale, routing_order, status,
			capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
		) VALUES
			('${RECIPIENT_ID}', '${ENVELOPE_ID}', 'recipient@example.com', 'Recipient', 'signer', 'ja', 1,
			 'viewed', '${CAPABILITY_HASH}', '2026-10-01T00:00:00.000Z', NULL,
			 '2026-09-22T08:00:00.000Z', '2026-09-22T09:00:00.000Z'),
			('${SIBLING_ID}', '${ENVELOPE_ID}', 'sibling@example.com', 'Sibling', 'signer', 'ja', 1,
			 'viewed', '${'f'.repeat(64)}', '2026-10-01T00:00:00.000Z', NULL,
			 '2026-09-22T08:00:00.000Z', '2026-09-22T09:00:00.000Z');
		INSERT INTO envelope_field (
			id, envelope_id, recipient_id, document_id, document_path, field_type, label,
			required, position, created_at, updated_at, page, x, y, width, height
		) VALUES (
			'${FIELD_ID}', '${ENVELOPE_ID}', '${RECIPIENT_ID}', NULL, 'agreement.pdf',
			'signature', 'Signature', 1, 0, '2026-09-22T08:00:00.000Z',
			'2026-09-22T08:00:00.000Z', 1, 0.2, 0.3, 0.2, 0.05
		);
		INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at, hash_version
		) VALUES (
			'01910000-0000-7000-8000-000000000210', '${ENVELOPE_ID}', 6,
			'recipient.viewed', 'recipient', '${RECIPIENT_ID}', '{}', '${'e'.repeat(64)}',
			'${PREVIOUS_AUDIT_HASH}', '2026-09-22T09:00:00.000Z', 3
		);
	`);
	return { sqlite, store: new D1RecipientSignStore(sqliteD1Database(sqlite)) };
}

describe('D1RecipientSignStore SQLite integration', () => {
	it('publishes field values and a signed command against the migrated schema', async () => {
		const { sqlite, store } = fixture();
		const command: PublishRecipientSignedCommand = signedCommand();

		try {
			await expect(store.publishSign(command)).resolves.toMatchObject({
				outcome: 'published',
				result: { recipientId: RECIPIENT_ID, envelopeStatus: 'in_progress' }
			});
			expect(
				sqlite
					.prepare('SELECT status, capability_revoked_at FROM recipient WHERE id = ?')
					.get(RECIPIENT_ID)
			).toEqual({ status: 'completed', capability_revoked_at: SIGNED_AT });
			expect(
				sqlite
					.prepare(
						`SELECT actor_type, actor_id, audit_sequence FROM recipient_signed_command
						 WHERE recipient_id = ?`
					)
					.get(RECIPIENT_ID)
			).toEqual({ actor_type: 'recipient', actor_id: RECIPIENT_ID, audit_sequence: 7 });
			expect(
				sqlite
					.prepare('SELECT field_type, value_json FROM field_value WHERE field_id = ?')
					.get(FIELD_ID)
			).toEqual({ field_type: 'signature', value_json: JSON.stringify('Kyu') });
			expect(
				sqlite
					.prepare('SELECT event_type, actor_type, actor_id FROM audit_event WHERE id = ?')
					.get(SIGNED_AUDIT_ID)
			).toEqual({
				event_type: 'recipient.signed',
				actor_type: 'recipient',
				actor_id: RECIPIENT_ID
			});
		} finally {
			sqlite.close();
		}
	});
});
