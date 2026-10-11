import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1CompletionAccessReissueStore } from './d1-completion-access-reissue';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

// Node:sqlite emulates D1's SQL dialect for this test; it never runs inside
// actual Cloudflare workerd.

const ENVELOPE_ID: string = '01990000-0000-7000-8000-000000000001';
const SIGNER_ID: string = '01990000-0000-7000-8000-000000000002';
const APPROVER_ID: string = '01990000-0000-7000-8000-000000000003';
const AT: string = '2026-09-11T00:00:00.000Z';

function createFixture(): { database: D1Database; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return { database: sqliteD1Database(sqlite), sqlite };
}

function seedEnvelope(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('user-1', 'owner', 'active', '${AT}', '${AT}');

		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			sent_commit_sha, repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', 'user-1', 'Synthetic status fixture', 'completed', 1, 'commit-1',
			'commit-1', 'archive-key', '${'a'.repeat(64)}', '${AT}', '${AT}'
		);
	`);
}

describe('D1CompletionAccessReissueStore.listCurrentDeliveries integration', () => {
	it('returns null for an envelope that does not exist, never conflating it with an empty listing', async () => {
		const { database, sqlite } = createFixture();
		try {
			const store = new D1CompletionAccessReissueStore(database);
			expect(await store.listCurrentDeliveries('01990000-0000-7000-8000-00000000ffff')).toBeNull();
		} finally {
			sqlite.close();
		}
	});

	it('returns an empty array for an existing envelope with no completion deliveries yet', async () => {
		const { database, sqlite } = createFixture();
		try {
			seedEnvelope(sqlite);
			const store = new D1CompletionAccessReissueStore(database);
			expect(await store.listCurrentDeliveries(ENVELOPE_ID)).toEqual([]);
		} finally {
			sqlite.close();
		}
	});

	it('surfaces failureCauseCode on a current generation, and null on a historical one, without inferring either', async () => {
		const { database, sqlite } = createFixture();
		try {
			seedEnvelope(sqlite);
			sqlite.exec(`
				INSERT INTO recipient (
					id, envelope_id, email, name, role, locale, routing_order, status, created_at, updated_at
				) VALUES
					('${SIGNER_ID}', '${ENVELOPE_ID}', 'signer@example.com', 'Signer', 'signer', 'en', 1, 'completed', '${AT}', '${AT}'),
					('${APPROVER_ID}', '${ENVELOPE_ID}', 'approver@example.com', 'Approver', 'approver', 'en', 2, 'completed', '${AT}', '${AT}');

				INSERT INTO audit_event (
					id, envelope_id, sequence, event_type, actor_type, actor_id,
					payload_json, previous_hash, event_hash, occurred_at
				) VALUES (
					'01990000-0000-7000-8000-000000000020', '${ENVELOPE_ID}', 1, 'envelope.completed', 'system', 'system',
					'{}', '${'0'.repeat(64)}', '${'e'.repeat(64)}', '${AT}'
				);

				INSERT INTO completion_artifact (
					envelope_id, schema_version, manifest_sha256,
					json_object_key, json_sha256, markdown_object_key, markdown_sha256,
					sent_commit_sha, field_generation, anchor_audit_event_id,
					audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
				) VALUES (
					'${ENVELOPE_ID}', 1, '${'m'.repeat(64)}',
					'completion-artifacts/v1/envelopes/${ENVELOPE_ID}/sha256/${'j'.repeat(64)}.json.gz', '${'j'.repeat(64)}',
					'completion-artifacts/v1/envelopes/${ENVELOPE_ID}/sha256/${'d'.repeat(64)}.md.gz', '${'d'.repeat(64)}',
					'commit-1', 0, '01990000-0000-7000-8000-000000000020', 1, '${'e'.repeat(64)}', '${AT}', '01990000-0000-7000-8000-000000000021'
				);

				-- signerId's generation was terminated by a known cause after
				-- this column existed; approverId's predates the column entirely.
				INSERT INTO completion_delivery_outbox (
					id, envelope_id, recipient_id, status, token_hash, access_expires_at,
					access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
					available_at, attempts, locked_at, claim_token, delivered_at,
					provider_message_id, last_error, retryable, created_at, updated_at,
					generation, predecessor_delivery_id, failure_cause_code
				) VALUES (
					'01990000-0000-7000-8000-000000000030', '${ENVELOPE_ID}', '${SIGNER_ID}', 'failed', '${'1'.repeat(64)}',
					'${AT}', '${AT}', NULL, 'key-1', '${'2'.repeat(64)}',
					'${AT}', 10, NULL, NULL, NULL, NULL, 'delivery_attempts_exhausted',
					0, '${AT}', '${AT}', 0, NULL, 'mail_delivery_failed'
				);

				INSERT INTO completion_delivery_outbox (
					id, envelope_id, recipient_id, status, token_hash, access_expires_at,
					access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
					available_at, attempts, locked_at, claim_token, delivered_at,
					provider_message_id, last_error, retryable, created_at, updated_at,
					generation, predecessor_delivery_id, failure_cause_code
				) VALUES (
					'01990000-0000-7000-8000-000000000031', '${ENVELOPE_ID}', '${APPROVER_ID}', 'failed', '${'3'.repeat(64)}',
					'${AT}', '${AT}', NULL, 'key-1', '${'4'.repeat(64)}',
					'${AT}', 10, NULL, NULL, NULL, NULL, 'delivery_attempts_exhausted',
					0, '${AT}', '${AT}', 0, NULL, NULL
				);
			`);

			const store = new D1CompletionAccessReissueStore(database);
			const rows = await store.listCurrentDeliveries(ENVELOPE_ID);
			expect(rows).not.toBeNull();
			const byRecipient = new Map((rows ?? []).map((row) => [row.recipientId, row]));
			expect(byRecipient.get(SIGNER_ID)?.failureCauseCode).toBe('mail_delivery_failed');
			expect(byRecipient.get(APPROVER_ID)?.failureCauseCode).toBeNull();
		} finally {
			sqlite.close();
		}
	});
});
