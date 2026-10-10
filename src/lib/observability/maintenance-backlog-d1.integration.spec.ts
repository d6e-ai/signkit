import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyD1Migrations, sqliteD1Database } from '$lib/adapters/db/sqlite-d1-test-support';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import type { MaintenanceBacklogSnapshot } from './maintenance-backlog';
import { D1MaintenanceBacklog } from './maintenance-backlog-d1';

/**
 * Exercises the real multi-table `UNION ALL` query against a freshly
 * migrated SQLite database (D1's own engine), not a mocked `D1Database`. A
 * mock can never catch a column/table typo; this does. "D1" here means
 * SignKit's D1 migrations applied through `node:sqlite`, the same harness
 * every other `*.integration.spec.ts` D1 adapter test in this codebase
 * uses — it is not a live Cloudflare D1 binding.
 */

const T0: string = '2026-01-01T00:00:00.000Z';

function iso(offsetMs: number): string {
	return new Date(new Date(T0).valueOf() + offsetMs).toISOString();
}

interface Fixture {
	sqlite: DatabaseSync;
	database: ReturnType<typeof sqliteD1Database>;
	envelopeId: string;
	recipientId: string;
}

/** Minimal valid parent rows every queue table's foreign keys require. */
function baseFixture(): Fixture {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);

	const envelopeId: string = newUuidV7();
	const recipientId: string = newUuidV7();
	const anchorEventId: string = newUuidV7();
	const invitationId: string = newUuidV7();
	const webhookEndpointId: string = newUuidV7();
	const webhookAuditEventId: string = newUuidV7();

	sqlite.exec(`
		INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
		VALUES ('user-1', 'owner', 'active', '${T0}', '${T0}');

		INSERT INTO envelope (
			id, created_by_user_id, title, status, repository_generation, repository_head, sent_commit_sha, created_at, updated_at
		) VALUES (
			'${envelopeId}', 'user-1', 'Agreement', 'sent', 1, 'commit-1', 'commit-1', '${T0}', '${T0}'
		);

		INSERT INTO recipient (
			id, envelope_id, email, name, role, locale, routing_order, status, capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
		) VALUES (
			'${recipientId}', '${envelopeId}', 'recipient@example.com', 'Recipient', 'signer', 'en', 1, 'pending', 'capability-hash', '2026-09-25T00:00:00.000Z', NULL, '${T0}', '${T0}'
		);

		INSERT INTO instance_invitation (
			id, role, status, token_hash, email_binding, invited_by_user_id, created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id
		) VALUES (
			'${invitationId}', 'member', 'pending', '${'a'.repeat(64)}', '${'b'.repeat(64)}', 'user-1', '${T0}', '2026-01-03T00:00:00.000Z', NULL, NULL, NULL, NULL
		);

		INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'${anchorEventId}', '${envelopeId}', 1, 'envelope.completed', 'system', NULL, '{}', NULL, '${'c'.repeat(64)}', '${T0}'
		);

		INSERT INTO completion_artifact (
			envelope_id, schema_version, manifest_sha256, json_object_key, json_sha256, markdown_object_key, markdown_sha256,
			sent_commit_sha, field_generation, anchor_audit_event_id, audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
		) VALUES (
			'${envelopeId}', 1, '${'d'.repeat(64)}', 'completion/json', '${'e'.repeat(64)}', 'completion/markdown', '${'f'.repeat(64)}',
			'commit-1', 1, '${anchorEventId}', 1, '${'c'.repeat(64)}', '${T0}', '${anchorEventId}'
		);

		INSERT INTO completion_artifact_pdf (
			envelope_id, pdf_object_key, pdf_sha256, pdf_manifest_object_key, pdf_manifest_sha256, published_at
		) VALUES (
			'${envelopeId}', 'completion/pdf', '${'1'.repeat(64)}', 'completion/pdf-manifest', '${'2'.repeat(64)}', '${T0}'
		);

		INSERT INTO webhook_endpoint (
			id, url, description, status, events_json, secret_hash, signing_secret, secret_prefix, created_at, created_by_user_id, revoked_at, revoked_by_user_id
		) VALUES (
			'${webhookEndpointId}', 'https://example.com/hook', NULL, 'active', '["envelope.sent"]', '${'3'.repeat(64)}', 'signing-secret-0123456789', 'whsec_abc', '${T0}', 'user-1', NULL, NULL
		);

		INSERT INTO audit_event (
			id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'${webhookAuditEventId}', '${envelopeId}', 2, 'envelope.sent', 'system', NULL, '{}', '${'c'.repeat(64)}', '${'4'.repeat(64)}', '${T0}'
		);
	`);

	// `audit_event_enqueue_webhooks` (0033_webhook_enqueue.sql) already inserted
	// the matching `webhook_outbox` row when the `envelope.sent` audit event
	// above was inserted, for every active endpoint subscribed to that event
	// type — which is exactly the row this suite exercises.

	sqlite.exec(`
		INSERT INTO instance_invitation_delivery_outbox (
			id, invitation_id, locale, status, sealed_payload, sealing_key_id, sealed_payload_sha256, available_at, attempts, retryable, claim_token, locked_at, delivered_at, provider_message_id, last_error, created_at, updated_at
		) VALUES (
			'${newUuidV7()}', '${invitationId}', 'en', 'pending', 'sealed', 'key-1', '${'5'.repeat(64)}', '${T0}', 0, 1, NULL, NULL, NULL, NULL, NULL, '${T0}', '${T0}'
		);

		INSERT INTO completion_artifact_job (
			envelope_id, status, claim_token, attempts, available_at, locked_at, retryable, last_error, created_at, updated_at
		) VALUES (
			'${envelopeId}', 'pending', NULL, 0, '${T0}', NULL, 1, NULL, '${T0}', '${T0}'
		);

		INSERT INTO docx_conversion_job (
			id, envelope_id, direction, request_key, request_fingerprint, status, claim_token, attempts, available_at, locked_at, retryable, last_error,
			source_object_key, source_sha256, source_byte_size, source_commit_sha, source_archive_key, source_archive_sha256, target_path, expected_generation,
			actor_type, actor_id, actor_name, actor_email, idempotency_key,
			result_generation, result_commit_sha, result_archive_sha256, result_object_key, result_sha256, result_byte_size, result_skipped_pdf_count,
			created_at, updated_at, completed_at
		) VALUES (
			'${newUuidV7()}', '${envelopeId}', 'export', 'export-1', 'fingerprint-1', 'pending', NULL, 0, '${T0}', NULL, 1, NULL,
			NULL, NULL, NULL, 'commit-1', 'archive-key-1', '${'6'.repeat(64)}', NULL, NULL,
			NULL, NULL, NULL, NULL, NULL,
			NULL, NULL, NULL, NULL, NULL, NULL, NULL,
			'${T0}', '${T0}', NULL
		);

		INSERT INTO pdf_seal_job (
			id, envelope_id, operation_id, validation_id, status, next_action, claim_token, attempt_sequence, retry_failures, available_at, locked_at, retryable,
			last_error_code, source_object_key, source_sha256, source_byte_size, requested_profile, signer_certificate_sha256, seal_policy_id, validation_policy_id,
			tsa_policy_id, tsa_trust_bundle_sha256, provider_receipt_id, sealed_object_key, sealed_sha256, sealed_byte_size, achieved_profile, validator_receipt_id,
			validation_checks_json, validation_report_object_key, validation_report_sha256, validation_report_byte_size, validated_at,
			created_at, updated_at, ready_at, failed_at
		) VALUES (
			'${newUuidV7()}', '${envelopeId}', '${newUuidV7()}', '${newUuidV7()}', 'pending', 'submit', NULL, 0, 0, '${T0}', NULL, NULL,
			NULL, 'completion/pdf', '${'1'.repeat(64)}', 100, 'pades-b-b', '${'7'.repeat(64)}', 'seal-policy-v1', 'validation-policy-v1',
			NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
			NULL, NULL, NULL, NULL, NULL,
			'${T0}', '${T0}', NULL, NULL
		);

		INSERT INTO delivery_outbox (
			id, envelope_id, recipient_id, kind, status, capability_hash, reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
			available_at, attempts, locked_at, delivered_at, provider_message_id, last_error, created_at, updated_at, claim_token, retryable
		) VALUES (
			'${newUuidV7()}', '${envelopeId}', '${recipientId}', 'recipient_invitation', 'pending', 'capability-hash', '2026-09-25T00:00:00.000Z', 'sealed', 'key-1', '${'8'.repeat(64)}',
			'${T0}', 0, NULL, NULL, NULL, NULL, '${T0}', '${T0}', NULL, 1
		);

		INSERT INTO completion_delivery_outbox (
			id, envelope_id, recipient_id, status, token_hash, access_expires_at, access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
			available_at, attempts, locked_at, claim_token, delivered_at, provider_message_id, last_error, retryable, created_at, updated_at
		) VALUES (
			'${newUuidV7()}', '${envelopeId}', '${recipientId}', 'pending', '${'9'.repeat(64)}', '2026-09-25T00:00:00.000Z', NULL, 'sealed', 'key-1', '${'0'.repeat(64)}',
			'${T0}', 0, NULL, NULL, NULL, NULL, NULL, 1, '${T0}', '${T0}'
		);
	`);

	return { sqlite, database: sqliteD1Database(sqlite), envelopeId, recipientId };
}

describe('D1MaintenanceBacklog SQLite integration', () => {
	it('executes the real UNION ALL query across all seven queue tables with one pending row each', async () => {
		const fixture: Fixture = baseFixture();
		try {
			const now: Date = new Date(T0);
			const snapshot: MaintenanceBacklogSnapshot = await new D1MaintenanceBacklog(
				fixture.database
			).snapshot(now);

			expect(snapshot).toHaveLength(7);
			for (const row of snapshot) {
				expect(row.pendingCount).toBe(1);
				expect(row.oldestPendingAgeSeconds).toBe(0);
				expect(row.oldestOverdueAgeSeconds).toBe(0);
				expect(row.permanentlyFailedCount).toBe(0);
			}
			expect(snapshot.map((row) => row.queue).toSorted()).toEqual(
				[
					'completion_artifact',
					'completion_delivery',
					'delivery',
					'docx_conversion',
					'instance_invitation_delivery',
					'pdf_seal',
					'webhook_delivery'
				].toSorted()
			);
		} finally {
			fixture.sqlite.close();
		}
	});

	it('reports every queue as empty against a freshly migrated, otherwise unpopulated database', async () => {
		const sqlite: DatabaseSync = new DatabaseSync(':memory:');
		applyD1Migrations(sqlite);
		try {
			const snapshot: MaintenanceBacklogSnapshot = await new D1MaintenanceBacklog(
				sqliteD1Database(sqlite)
			).snapshot(new Date(T0));

			expect(snapshot).toHaveLength(7);
			for (const row of snapshot) {
				expect(row.pendingCount).toBe(0);
				expect(row.oldestPendingAgeSeconds).toBeNull();
				expect(row.oldestOverdueAgeSeconds).toBeNull();
				expect(row.permanentlyFailedCount).toBe(0);
			}
		} finally {
			sqlite.close();
		}
	});

	it('distinguishes a permanently failed row, a future-dated retry, and a stale-looking retry from the true backlog age', async () => {
		const fixture: Fixture = baseFixture();
		try {
			// `delivery_outbox` already has one pending row created at T0 and due
			// at T0. Add: a permanently failed row (counts only toward
			// permanentlyFailedCount), a retry due in the past (overdue,
			// created long ago — this is the bug fix under test: a retry must
			// not reset the true backlog age), and a retry delayed into the
			// future (counts toward pendingCount but not overdue).
			fixture.sqlite.exec(`
				INSERT INTO delivery_outbox (
					id, envelope_id, recipient_id, kind, status, capability_hash, reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
					available_at, attempts, locked_at, delivered_at, provider_message_id, last_error, created_at, updated_at, claim_token, retryable
				) VALUES (
					'${newUuidV7()}', '${fixture.envelopeId}', '${fixture.recipientId}', 'recipient_invitation', 'failed', 'capability-hash-2', '2026-09-25T00:00:00.000Z', NULL, 'key-1', '${'a'.repeat(64)}',
					'${iso(60_000)}', 5, NULL, NULL, NULL, 'permanently_failed', '${iso(-3600_000)}', '${iso(60_000)}', NULL, 0
				);

				INSERT INTO delivery_outbox (
					id, envelope_id, recipient_id, kind, status, capability_hash, reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
					available_at, attempts, locked_at, delivered_at, provider_message_id, last_error, created_at, updated_at, claim_token, retryable
				) VALUES (
					'${newUuidV7()}', '${fixture.envelopeId}', '${fixture.recipientId}', 'recipient_invitation', 'failed', 'capability-hash-3', '2026-09-25T00:00:00.000Z', 'sealed', 'key-1', '${'b'.repeat(64)}',
					'${iso(-60_000)}', 1, NULL, NULL, NULL, 'retry_pending', '${iso(-7200_000)}', '${iso(-60_000)}', NULL, 1
				);

				INSERT INTO delivery_outbox (
					id, envelope_id, recipient_id, kind, status, capability_hash, reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
					available_at, attempts, locked_at, delivered_at, provider_message_id, last_error, created_at, updated_at, claim_token, retryable
				) VALUES (
					'${newUuidV7()}', '${fixture.envelopeId}', '${fixture.recipientId}', 'recipient_invitation', 'failed', 'capability-hash-4', '2026-09-25T00:00:00.000Z', 'sealed', 'key-1', '${'c'.repeat(64)}',
					'${iso(3600_000)}', 1, NULL, NULL, NULL, 'retry_delayed', '${iso(-30_000)}', '${iso(-30_000)}', NULL, 1
				);
			`);

			const now: Date = new Date(T0);
			const snapshot: MaintenanceBacklogSnapshot = await new D1MaintenanceBacklog(
				fixture.database
			).snapshot(now);
			const delivery = snapshot.find((row) => row.queue === 'delivery');
			if (delivery === undefined) throw new Error('delivery queue missing from snapshot');

			// Original pending row (created/due at T0) + the two retryable
			// failures (due-in-the-past and delayed-to-the-future) = 3. The
			// permanently failed row never counts here.
			expect(delivery.pendingCount).toBe(3);
			expect(delivery.permanentlyFailedCount).toBe(1);
			// Oldest true age is the retry created 7200s ago, NOT reset by its
			// available_at having moved to 60s in the past.
			expect(delivery.oldestPendingAgeSeconds).toBe(7200);
			// Oldest *overdue* age only considers rows due now: the past-due
			// retry (available_at 60s ago). The future-delayed retry (due in
			// 3600s) must not count, even though it is still "pending".
			expect(delivery.oldestOverdueAgeSeconds).toBe(60);
		} finally {
			fixture.sqlite.close();
		}
	});

	it('keeps webhook lifetime age anchored to its event while a retry is delayed', async () => {
		const fixture = baseFixture();
		try {
			fixture.sqlite.exec(`UPDATE webhook_outbox SET status = 'failed', retryable = 1,
				available_at = '${iso(3_600_000)}', attempts = 1`);
			const snapshot = await new D1MaintenanceBacklog(fixture.database).snapshot(
				new Date(iso(1_800_000))
			);
			expect(snapshot.find((row) => row.queue === 'webhook_delivery')).toMatchObject({
				pendingCount: 1,
				oldestPendingAgeSeconds: 1800,
				oldestOverdueAgeSeconds: null
			});
		} finally {
			fixture.sqlite.close();
		}
	});
});
