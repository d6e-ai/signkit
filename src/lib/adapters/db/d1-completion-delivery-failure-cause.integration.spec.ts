import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { D1CompletionDeliveryStore } from './d1-completion-delivery-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

// Node:sqlite emulates D1's SQL dialect and CHECK-constraint semantics for
// this test; it never runs inside actual Cloudflare workerd.

const ENVELOPE_ID: string = '01980000-0000-7000-8000-000000000001';
const SIGNER_ID: string = '01980000-0000-7000-8000-000000000002';
const DELIVERY_ID: string = '01980000-0000-7000-8000-000000000010';
const HISTORICAL_DELIVERY_ID: string = '01980000-0000-7000-8000-000000000011';
const CLAIMED_AT: string = '2026-09-12T00:00:00.000Z';
const STALE_BEFORE: string = '2026-09-11T23:55:00.000Z';

function createFixture(): { database: D1Database; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	return { database: sqliteD1Database(sqlite), sqlite };
}

function seedCompletedEnvelope(sqlite: DatabaseSync): void {
	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('user-1', 'owner', 'active', '2026-09-11T00:00:00.000Z', '2026-09-11T00:00:00.000Z');

		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head,
			sent_commit_sha, repository_archive_key, repository_archive_sha256, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', 'user-1', 'Completed Agreement', 'completed', 1, 'commit-1',
			'commit-1', 'archive-key', '${'a'.repeat(64)}', '2026-09-11T00:00:00.000Z', '2026-09-11T00:02:00.000Z'
		);

		INSERT INTO recipient (
			id, envelope_id, email, name, role, locale, routing_order, status,
			created_at, updated_at
		) VALUES
			('${SIGNER_ID}', '${ENVELOPE_ID}', 'signer@example.com', 'Signer', 'signer', 'en', 1, 'completed', '2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z');

		INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'01980000-0000-7000-8000-000000000020', '${ENVELOPE_ID}', 1, 'envelope.completed', 'system', 'system',
			'{}', '${'0'.repeat(64)}', '${'e'.repeat(64)}', '2026-09-11T00:02:00.000Z'
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
			'commit-1', 0, '01980000-0000-7000-8000-000000000020', 1, '${'e'.repeat(64)}', '2026-09-11T00:03:00.000Z', '01980000-0000-7000-8000-000000000021'
		);
		INSERT INTO completion_artifact_pdf (
			envelope_id, pdf_object_key, pdf_sha256, pdf_byte_size,
			pdf_manifest_object_key, pdf_manifest_sha256, published_at
		) VALUES (
			'${ENVELOPE_ID}', 'completion/example.pdf', '${'b'.repeat(64)}', 128,
			'completion/pdf-manifest.json.gz', '${'c'.repeat(64)}', '2026-09-11T00:03:00.000Z'
		);
	`);
}

describe('D1CompletionDeliveryStore terminal cleanup failure_cause_code', () => {
	it('records a known failure_cause_code for a delivery the sweep newly terminates, never a silent NULL', async () => {
		const { database, sqlite } = createFixture();
		try {
			seedCompletedEnvelope(sqlite);
			sqlite.exec(`
				INSERT INTO completion_delivery_outbox (
					id, envelope_id, recipient_id, status, token_hash, access_expires_at,
					access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
					available_at, attempts, locked_at, claim_token, delivered_at,
					provider_message_id, last_error, retryable, created_at, updated_at,
					generation, predecessor_delivery_id, failure_cause_code
				) VALUES (
					'${DELIVERY_ID}', '${ENVELOPE_ID}', '${SIGNER_ID}', 'pending', '${'1'.repeat(64)}',
					'2026-10-12T00:00:00.000Z', NULL, 'sealed-blob', 'key-1', '${'2'.repeat(64)}',
					'2026-09-11T00:04:00.000Z', 0, NULL, NULL, NULL, NULL, NULL,
					1, '2026-09-11T00:04:00.000Z', '2026-09-11T00:04:00.000Z', 0, NULL, NULL
				);
			`);
			// The delivery was eligible when enrolled; the recipient becoming
			// `prefill` afterward is what the sweep below must newly terminate.
			sqlite.prepare('UPDATE recipient SET role = ? WHERE id = ?').run('prefill', SIGNER_ID);

			const store = new D1CompletionDeliveryStore(database);
			const claimed = await store.claimPendingDeliveries({
				claimToken: 'claim-token-0123456789',
				claimedAt: CLAIMED_AT,
				staleBefore: STALE_BEFORE,
				limit: 10
			});
			expect(claimed).toHaveLength(0);

			const row = sqlite
				.prepare(
					'SELECT status, retryable, sealed_token, access_revoked_at, last_error, failure_cause_code FROM completion_delivery_outbox WHERE id = ?'
				)
				.get(DELIVERY_ID) as {
				status: string;
				retryable: number;
				sealed_token: string | null;
				access_revoked_at: string | null;
				last_error: string | null;
				failure_cause_code: string | null;
			};
			expect(row.status).toBe('failed');
			expect(row.retryable).toBe(0);
			expect(row.sealed_token).toBeNull();
			expect(row.access_revoked_at).toBe(CLAIMED_AT);
			expect(row.last_error).toBe('delivery_not_eligible');
			expect(row.failure_cause_code).toBe('delivery_not_eligible');
		} finally {
			sqlite.close();
		}
	});

	it('leaves a pre-existing historical NULL failure_cause_code row untouched by the sweep', async () => {
		const { database, sqlite } = createFixture();
		try {
			seedCompletedEnvelope(sqlite);
			// A row already terminally failed before this column existed: the
			// sweep must never backfill or otherwise touch it.
			sqlite.exec(`
				INSERT INTO completion_delivery_outbox (
					id, envelope_id, recipient_id, status, token_hash, access_expires_at,
					access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
					available_at, attempts, locked_at, claim_token, delivered_at,
					provider_message_id, last_error, retryable, created_at, updated_at,
					generation, predecessor_delivery_id, failure_cause_code
				) VALUES (
					'${HISTORICAL_DELIVERY_ID}', '${ENVELOPE_ID}', '${SIGNER_ID}', 'failed', '${'3'.repeat(64)}',
					'2026-09-12T00:00:00.000Z', '2026-09-11T00:05:00.000Z', NULL, 'key-1', '${'4'.repeat(64)}',
					'2026-09-11T00:04:00.000Z', 10, NULL, NULL, NULL, NULL, 'delivery_attempts_exhausted',
					0, '2026-09-11T00:04:00.000Z', '2026-09-11T00:05:00.000Z', 0, NULL, NULL
				);
			`);

			const store = new D1CompletionDeliveryStore(database);
			await store.claimPendingDeliveries({
				claimToken: 'claim-token-9876543210',
				claimedAt: CLAIMED_AT,
				staleBefore: STALE_BEFORE,
				limit: 10
			});

			const row = sqlite
				.prepare(
					'SELECT last_error, failure_cause_code, updated_at FROM completion_delivery_outbox WHERE id = ?'
				)
				.get(HISTORICAL_DELIVERY_ID) as {
				last_error: string | null;
				failure_cause_code: string | null;
				updated_at: string;
			};
			expect(row.last_error).toBe('delivery_attempts_exhausted');
			expect(row.failure_cause_code).toBeNull();
			expect(row.updated_at).toBe('2026-09-11T00:05:00.000Z');
		} finally {
			sqlite.close();
		}
	});

	it('bounds failure_cause_code to the sanitized shape at the database layer, mirroring sanitizeCompletionDeliveryErrorCode', () => {
		const { sqlite } = createFixture();
		try {
			seedCompletedEnvelope(sqlite);
			const insert = (id: string, recipientId: string, failureCauseCode: string | null): void => {
				sqlite
					.prepare(
						`INSERT INTO recipient (
							id, envelope_id, email, name, role, locale, routing_order, status,
							created_at, updated_at
						) VALUES (?, ?, ?, 'Extra', 'signer', 'en', 9, 'completed',
							'2026-09-11T00:01:00.000Z', '2026-09-11T00:02:00.000Z')`
					)
					.run(recipientId, ENVELOPE_ID, `extra-${recipientId}@example.com`);
				sqlite
					.prepare(
						`INSERT INTO completion_delivery_outbox (
							id, envelope_id, recipient_id, status, token_hash, access_expires_at,
							access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
							available_at, attempts, locked_at, claim_token, delivered_at,
							provider_message_id, last_error, retryable, created_at, updated_at,
							generation, predecessor_delivery_id, failure_cause_code
						) VALUES (
							?, ?, ?, 'failed', ?, '2026-09-12T00:00:00.000Z',
							'2026-09-11T00:05:00.000Z', NULL, 'key-1', ?,
							'2026-09-11T00:04:00.000Z', 10, NULL, NULL, NULL, NULL, 'delivery_attempts_exhausted',
							0, '2026-09-11T00:04:00.000Z', '2026-09-11T00:05:00.000Z', 0, NULL, ?
						)`
					)
					.run(
						id,
						ENVELOPE_ID,
						recipientId,
						`${id}-token`.padEnd(64, '0'),
						`${id}-hash`.padEnd(64, '0'),
						failureCauseCode
					);
			};

			expect(() =>
				insert('01980000-0000-7000-8000-000000000030', '01980000-0000-7000-8000-000000000130', null)
			).not.toThrow();
			expect(() =>
				insert(
					'01980000-0000-7000-8000-000000000031',
					'01980000-0000-7000-8000-000000000131',
					'mail_delivery_failed'
				)
			).not.toThrow();
			expect(() =>
				insert(
					'01980000-0000-7000-8000-000000000032',
					'01980000-0000-7000-8000-000000000132',
					'Not-Lowercase'
				)
			).toThrow();
			expect(() =>
				insert(
					'01980000-0000-7000-8000-000000000033',
					'01980000-0000-7000-8000-000000000133',
					`skca1_${'x'.repeat(10)}`
				)
			).toThrow();
		} finally {
			sqlite.close();
		}
	});
});
