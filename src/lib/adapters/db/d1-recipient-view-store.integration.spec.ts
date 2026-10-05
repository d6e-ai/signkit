import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { PublishRecipientViewedCommand } from '$lib/ports/recipient-view-store';
import { D1RecipientViewStore } from './d1-recipient-view-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ENVELOPE_ID: string = '01910000-0000-7000-8000-000000000101';
const RECIPIENT_ID: string = '01910000-0000-7000-8000-000000000102';
const VIEWED_AUDIT_ID: string = '01910000-0000-7000-8000-000000000103';
const ACTOR_ID: string = 'user-1';
const COMMIT_SHA: string = '0123456789abcdef0123456789abcdef01234567';
const CAPABILITY_HASH: string = 'a'.repeat(64);
const PREVIOUS_AUDIT_HASH: string = 'b'.repeat(64);
const VIEWED_AT: string = '2026-09-22T09:00:00.000Z';

function viewedCommand(): PublishRecipientViewedCommand {
	const requestFingerprint: string = createHash('sha256')
		.update(
			JSON.stringify({
				envelopeId: ENVELOPE_ID,
				recipientId: RECIPIENT_ID,
				capabilityHash: CAPABILITY_HASH
			})
		)
		.digest('hex');
	const auditPayloadJson: string = JSON.stringify({
		recipientId: RECIPIENT_ID,
		role: 'signer',
		routingOrder: 1,
		sentCommitSha: COMMIT_SHA,
		viewedAt: VIEWED_AT
	});
	return {
		envelopeId: ENVELOPE_ID,
		recipientId: RECIPIENT_ID,
		capabilityHash: CAPABILITY_HASH,
		idempotencyKey: 'viewed-integration',
		requestFingerprint,
		recipientRole: 'signer',
		routingOrder: 1,
		expectedSentCommitSha: COMMIT_SHA,
		updatedAt: VIEWED_AT,
		expectedAuditSequence: 5,
		previousAuditHash: PREVIOUS_AUDIT_HASH,
		auditEventId: VIEWED_AUDIT_ID,
		auditEventHash: 'c'.repeat(64),
		auditPayloadJson
	};
}

function fixture(): { sqlite: DatabaseSync; store: D1RecipientViewStore } {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('${ACTOR_ID}', 'owner', 'active', '2026-09-22T08:00:00.000Z', '2026-09-22T08:00:00.000Z');
		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			repository_archive_key, repository_archive_sha256, sent_commit_sha, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', '${ACTOR_ID}', 'Agreement', 'sent', 1, '${COMMIT_SHA}',
			'archives/integration.git.gz', '${'d'.repeat(64)}', '${COMMIT_SHA}',
			'2026-09-22T08:00:00.000Z', '2026-09-22T08:30:00.000Z'
		);
		INSERT INTO recipient (
			id, envelope_id, email, name, role, locale, routing_order, status,
			capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
		) VALUES (
			'${RECIPIENT_ID}', '${ENVELOPE_ID}', 'recipient@example.com', 'Recipient', 'signer', 'ja', 1,
			'pending', '${CAPABILITY_HASH}', '2026-10-01T00:00:00.000Z', NULL,
			'2026-09-22T08:00:00.000Z', '2026-09-22T08:30:00.000Z'
		);
		INSERT INTO recipient_capability_issuance (
			envelope_id, recipient_id, capability_hash, predecessor_capability_hash, issued_at, superseded_at
		) VALUES (
			'${ENVELOPE_ID}', '${RECIPIENT_ID}', '${CAPABILITY_HASH}', NULL,
			'2026-09-22T08:30:00.000Z', NULL
		);
		INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at, hash_version
		) VALUES (
			'01910000-0000-7000-8000-000000000110', '${ENVELOPE_ID}', 5,
			'envelope.sent', 'user', '${ACTOR_ID}', '{}', '${'e'.repeat(64)}',
			'${PREVIOUS_AUDIT_HASH}', '2026-09-22T08:30:00.000Z', 3
		);
	`);
	return { sqlite, store: new D1RecipientViewStore(sqliteD1Database(sqlite)) };
}

describe('D1RecipientViewStore SQLite integration', () => {
	it('publishes and replays a viewed command against the migrated schema', async () => {
		const { sqlite, store } = fixture();
		const command: PublishRecipientViewedCommand = viewedCommand();

		try {
			await expect(store.publishViewed(command)).resolves.toMatchObject({
				outcome: 'published',
				result: { recipientId: RECIPIENT_ID, envelopeStatus: 'in_progress' }
			});
			expect(
				sqlite
					.prepare(
						`SELECT recipient.status AS recipient_status, envelope.status AS envelope_status
						 FROM recipient INNER JOIN envelope ON envelope.id = recipient.envelope_id
						 WHERE recipient.id = ?`
					)
					.get(RECIPIENT_ID)
			).toEqual({ recipient_status: 'viewed', envelope_status: 'in_progress' });
			expect(
				sqlite
					.prepare(
						`SELECT actor_type, actor_id, audit_sequence FROM recipient_viewed_command
						 WHERE recipient_id = ?`
					)
					.get(RECIPIENT_ID)
			).toEqual({ actor_type: 'recipient', actor_id: RECIPIENT_ID, audit_sequence: 6 });
			expect(
				sqlite
					.prepare(
						`SELECT event_type, actor_type, actor_id, hash_version FROM audit_event
						 WHERE id = ?`
					)
					.get(VIEWED_AUDIT_ID)
			).toEqual({
				event_type: 'recipient.viewed',
				actor_type: 'recipient',
				actor_id: RECIPIENT_ID,
				hash_version: 3
			});
			await expect(
				store.prepareViewed(
					{ ...command, idempotencyKey: 'viewed-integration-second-tab' },
					'2026-09-22T09:01:00.000Z'
				)
			).resolves.toMatchObject({ outcome: 'replayed' });
		} finally {
			sqlite.close();
		}
	});
});
