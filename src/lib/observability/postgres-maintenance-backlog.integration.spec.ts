import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newUuidV7 } from '$lib/ids/uuid-v7';
import type { MaintenanceBacklogSnapshot } from './maintenance-backlog';
import { PostgresMaintenanceBacklog } from './maintenance-backlog-postgres';

/**
 * Exercises the real multi-table `UNION ALL` query against a real
 * PostgreSQL instance, not a mocked SQL client. Runs in its own schema so
 * it never touches `public` or any other suite's tables; skipped entirely
 * when `POSTGRES_TEST_URL` is unset, matching every other PostgreSQL
 * `*.integration.spec.ts` in this codebase.
 */

const DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = DATABASE_URL === undefined ? describe.skip : describe;

const T0: string = '2026-01-01T00:00:00.000Z';

function iso(offsetMs: number): string {
	return new Date(new Date(T0).valueOf() + offsetMs).toISOString();
}

postgresDescribe('PostgresMaintenanceBacklog', () => {
	const schema: string = `signkit_opsfix_backlog_${newUuidV7().replaceAll('-', '')}`;
	let sql: ReturnType<typeof postgres> | null = null;

	beforeEach(async () => {
		sql = postgres(DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schema}"`);
		await sql.unsafe(`SET search_path TO "${schema}"`);
		const paths: string[] = readdirSync('migrations/postgres')
			.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
			.sort();
		for (const path of paths) {
			await sql.unsafe(readFileSync(`migrations/postgres/${path}`, 'utf8'));
		}
	});

	afterEach(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		await sql.end({ timeout: 5 });
	});

	async function seedBaseFixture(client: ReturnType<typeof postgres>): Promise<{
		envelopeId: string;
		recipientId: string;
	}> {
		const envelopeId: string = newUuidV7();
		const recipientId: string = newUuidV7();
		const anchorEventId: string = newUuidV7();
		const invitationId: string = newUuidV7();
		const webhookEndpointId: string = newUuidV7();
		const webhookAuditEventId: string = newUuidV7();

		await client`
			INSERT INTO instance_member (user_id, role, status, created_at, updated_at)
			VALUES ('user-1', 'owner', 'active', ${T0}::timestamptz, ${T0}::timestamptz)
		`;
		await client`
			INSERT INTO envelope (
				id, created_by_user_id, title, status, repository_generation, repository_head, sent_commit_sha, created_at, updated_at
			) VALUES (
				${envelopeId}, 'user-1', 'Agreement', 'sent', 1, 'commit-1', 'commit-1', ${T0}::timestamptz, ${T0}::timestamptz
			)
		`;
		await client`
			INSERT INTO recipient (
				id, envelope_id, email, name, role, locale, routing_order, status, capability_hash, capability_expires_at, capability_revoked_at, created_at, updated_at
			) VALUES (
				${recipientId}, ${envelopeId}, 'recipient@example.com', 'Recipient', 'signer', 'en', 1, 'pending', 'capability-hash', '2026-09-25T00:00:00.000Z'::timestamptz, NULL, ${T0}::timestamptz, ${T0}::timestamptz
			)
		`;
		await client`
			INSERT INTO instance_invitation (
				id, role, status, token_hash, email_binding, invited_by_user_id, created_at, expires_at, accepted_at, accepted_by_user_id, revoked_at, revoked_by_user_id
			) VALUES (
				${invitationId}, 'member', 'pending', ${'a'.repeat(64)}, ${'b'.repeat(64)}, 'user-1', ${T0}::timestamptz, '2026-01-03T00:00:00.000Z'::timestamptz, NULL, NULL, NULL, NULL
			)
		`;
		await client`
			INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json, previous_hash, event_hash, occurred_at
			) VALUES (
				${anchorEventId}, ${envelopeId}, 1, 'envelope.completed', 'system', NULL, '{}', NULL, ${'c'.repeat(64)}, ${T0}::timestamptz
			)
		`;
		await client`
			INSERT INTO completion_artifact (
				envelope_id, schema_version, manifest_sha256, json_object_key, json_sha256, markdown_object_key, markdown_sha256,
				sent_commit_sha, field_generation, anchor_audit_event_id, audit_head_sequence, audit_head_event_hash, published_at, audit_event_id
			) VALUES (
				${envelopeId}, 1, ${'d'.repeat(64)}, 'completion/json', ${'e'.repeat(64)}, 'completion/markdown', ${'f'.repeat(64)},
				'commit-1', 1, ${anchorEventId}, 1, ${'c'.repeat(64)}, ${T0}::timestamptz, ${anchorEventId}
			)
		`;
		await client`
			INSERT INTO completion_artifact_pdf (
				envelope_id, pdf_object_key, pdf_sha256, pdf_manifest_object_key, pdf_manifest_sha256, published_at
			) VALUES (
				${envelopeId}, 'completion/pdf', ${'1'.repeat(64)}, 'completion/pdf-manifest', ${'2'.repeat(64)}, ${T0}::timestamptz
			)
		`;
		await client`
			INSERT INTO webhook_endpoint (
				id, url, description, status, events_json, secret_hash, signing_secret, secret_prefix, created_at, created_by_user_id, revoked_at, revoked_by_user_id
			) VALUES (
				${webhookEndpointId}, 'https://example.com/hook', NULL, 'active', '["envelope.sent"]', ${'3'.repeat(64)}, 'signing-secret-0123456789', 'whsec_abc', ${T0}::timestamptz, 'user-1', NULL, NULL
			)
		`;
		// `audit_event_enqueue_webhooks` (0032_webhook_enqueue.sql) inserts the
		// matching `webhook_outbox` row for every active, subscribed endpoint.
		await client`
			INSERT INTO audit_event (
				id, envelope_id, sequence, event_type, actor_type, actor_id, payload_json, previous_hash, event_hash, occurred_at
			) VALUES (
				${webhookAuditEventId}, ${envelopeId}, 2, 'envelope.sent', 'system', NULL, '{}', ${'c'.repeat(64)}, ${'4'.repeat(64)}, ${T0}::timestamptz
			)
		`;

		await client`
			INSERT INTO instance_invitation_delivery_outbox (
				id, invitation_id, locale, status, sealed_payload, sealing_key_id, sealed_payload_sha256, available_at, attempts, retryable, claim_token, locked_at, delivered_at, provider_message_id, last_error, created_at, updated_at
			) VALUES (
				${newUuidV7()}, ${invitationId}, 'en', 'pending', 'sealed', 'key-1', ${'5'.repeat(64)}, ${T0}::timestamptz, 0, true, NULL, NULL, NULL, NULL, NULL, ${T0}::timestamptz, ${T0}::timestamptz
			)
		`;
		await client`
			INSERT INTO completion_artifact_job (
				envelope_id, status, claim_token, attempts, available_at, locked_at, retryable, last_error, created_at, updated_at
			) VALUES (
				${envelopeId}, 'pending', NULL, 0, ${T0}::timestamptz, NULL, true, NULL, ${T0}::timestamptz, ${T0}::timestamptz
			)
		`;
		await client`
			INSERT INTO docx_conversion_job (
				id, envelope_id, direction, request_key, request_fingerprint, status, claim_token, attempts, available_at, locked_at, retryable, last_error,
				source_object_key, source_sha256, source_byte_size, source_commit_sha, source_archive_key, source_archive_sha256, target_path, expected_generation,
				actor_type, actor_id, actor_name, actor_email, idempotency_key,
				result_generation, result_commit_sha, result_archive_sha256, result_object_key, result_sha256, result_byte_size, result_skipped_pdf_count,
				created_at, updated_at, completed_at
			) VALUES (
				${newUuidV7()}, ${envelopeId}, 'export', 'export-1', 'fingerprint-1', 'pending', NULL, 0, ${T0}::timestamptz, NULL, true, NULL,
				NULL, NULL, NULL, 'commit-1', 'archive-key-1', ${'6'.repeat(64)}, NULL, NULL,
				NULL, NULL, NULL, NULL, NULL,
				NULL, NULL, NULL, NULL, NULL, NULL, NULL,
				${T0}::timestamptz, ${T0}::timestamptz, NULL
			)
		`;
		await client`
			INSERT INTO pdf_seal_job (
				id, envelope_id, operation_id, validation_id, status, next_action, claim_token, attempt_sequence, retry_failures, available_at, locked_at, retryable,
				last_error_code, source_object_key, source_sha256, source_byte_size, requested_profile, signer_certificate_sha256, seal_policy_id, validation_policy_id,
				tsa_policy_id, tsa_trust_bundle_sha256, provider_receipt_id, sealed_object_key, sealed_sha256, sealed_byte_size, achieved_profile, validator_receipt_id,
				validation_checks_json, validation_report_object_key, validation_report_sha256, validation_report_byte_size, validated_at,
				created_at, updated_at, ready_at, failed_at
			) VALUES (
				${newUuidV7()}, ${envelopeId}, ${newUuidV7()}, ${newUuidV7()}, 'pending', 'submit', NULL, 0, 0, ${T0}::timestamptz, NULL, NULL,
				NULL, 'completion/pdf', ${'1'.repeat(64)}, 100, 'pades-b-b', ${'7'.repeat(64)}, 'seal-policy-v1', 'validation-policy-v1',
				NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
				NULL, NULL, NULL, NULL, NULL,
				${T0}::timestamptz, ${T0}::timestamptz, NULL, NULL
			)
		`;
		await client`
			INSERT INTO delivery_outbox (
				id, envelope_id, recipient_id, kind, status, capability_hash, reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
				available_at, attempts, locked_at, delivered_at, provider_message_id, last_error, created_at, updated_at, claim_token, retryable
			) VALUES (
				${newUuidV7()}, ${envelopeId}, ${recipientId}, 'recipient_invitation', 'pending', 'capability-hash', '2026-09-25T00:00:00.000Z'::timestamptz, 'sealed', 'key-1', ${'8'.repeat(64)},
				${T0}::timestamptz, 0, NULL, NULL, NULL, NULL, ${T0}::timestamptz, ${T0}::timestamptz, NULL, true
			)
		`;
		await client`
			INSERT INTO completion_delivery_outbox (
				id, envelope_id, recipient_id, status, token_hash, access_expires_at, access_revoked_at, sealed_token, sealing_key_id, sealed_token_sha256,
				available_at, attempts, locked_at, claim_token, delivered_at, provider_message_id, last_error, retryable, created_at, updated_at
			) VALUES (
				${newUuidV7()}, ${envelopeId}, ${recipientId}, 'pending', ${'9'.repeat(64)}, '2026-09-25T00:00:00.000Z'::timestamptz, NULL, 'sealed', 'key-1', ${'0'.repeat(64)},
				${T0}::timestamptz, 0, NULL, NULL, NULL, NULL, NULL, true, ${T0}::timestamptz, ${T0}::timestamptz
			)
		`;

		await client`
			INSERT INTO completion_artifact_pdf_repair (
				envelope_id, status, claim_token, attempts, available_at, locked_at,
				retryable, last_error, created_at, updated_at
			) VALUES (${envelopeId}, 'pending', NULL, 0, ${T0}::timestamptz, NULL, true, NULL, ${T0}::timestamptz, ${T0}::timestamptz)
		`;
		return { envelopeId, recipientId };
	}

	it('executes the real UNION ALL query across all eight queue tables with one pending row each', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		await seedBaseFixture(sql);

		const now: Date = new Date(T0);
		const snapshot: MaintenanceBacklogSnapshot = await new PostgresMaintenanceBacklog(sql).snapshot(
			now
		);

		expect(snapshot).toHaveLength(8);
		for (const row of snapshot) {
			expect(row.pendingCount).toBe(1);
			expect(row.oldestPendingAgeSeconds).toBe(0);
			expect(row.oldestOverdueAgeSeconds).toBe(0);
			expect(row.permanentlyFailedCount).toBe(0);
		}
	});

	it('reports every queue as empty against a freshly migrated, otherwise unpopulated schema', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const emptySchema: string = `signkit_opsfix_backlog_empty_${newUuidV7().replaceAll('-', '')}`;
		await sql.unsafe(`CREATE SCHEMA "${emptySchema}"`);
		try {
			await sql.unsafe(`SET search_path TO "${emptySchema}"`);
			const paths: string[] = readdirSync('migrations/postgres')
				.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
				.sort();
			for (const path of paths) {
				await sql.unsafe(readFileSync(`migrations/postgres/${path}`, 'utf8'));
			}

			const snapshot: MaintenanceBacklogSnapshot = await new PostgresMaintenanceBacklog(
				sql
			).snapshot(new Date(T0));

			expect(snapshot).toHaveLength(8);
			for (const row of snapshot) {
				expect(row.pendingCount).toBe(0);
				expect(row.oldestPendingAgeSeconds).toBeNull();
				expect(row.oldestOverdueAgeSeconds).toBeNull();
				expect(row.permanentlyFailedCount).toBe(0);
			}
		} finally {
			await sql.unsafe(`SET search_path TO "${schema}"`);
			await sql.unsafe(`DROP SCHEMA "${emptySchema}" CASCADE`);
		}
	});

	it('distinguishes a permanently failed row, a future-dated retry, and the true backlog age from available_at resets', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		const { envelopeId, recipientId } = await seedBaseFixture(sql);

		await sql`
			INSERT INTO delivery_outbox (
				id, envelope_id, recipient_id, kind, status, capability_hash, reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
				available_at, attempts, locked_at, delivered_at, provider_message_id, last_error, created_at, updated_at, claim_token, retryable
			) VALUES (
				${newUuidV7()}, ${envelopeId}, ${recipientId}, 'recipient_invitation', 'failed', 'capability-hash-2', '2026-09-25T00:00:00.000Z'::timestamptz, NULL, 'key-1', ${'a'.repeat(64)},
				${iso(60_000)}::timestamptz, 5, NULL, NULL, NULL, 'permanently_failed', ${iso(-3_600_000)}::timestamptz, ${iso(60_000)}::timestamptz, NULL, false
			)
		`;
		await sql`
			INSERT INTO delivery_outbox (
				id, envelope_id, recipient_id, kind, status, capability_hash, reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
				available_at, attempts, locked_at, delivered_at, provider_message_id, last_error, created_at, updated_at, claim_token, retryable
			) VALUES (
				${newUuidV7()}, ${envelopeId}, ${recipientId}, 'recipient_invitation', 'failed', 'capability-hash-3', '2026-09-25T00:00:00.000Z'::timestamptz, 'sealed', 'key-1', ${'b'.repeat(64)},
				${iso(-60_000)}::timestamptz, 1, NULL, NULL, NULL, 'retry_pending', ${iso(-7_200_000)}::timestamptz, ${iso(-60_000)}::timestamptz, NULL, true
			)
		`;
		await sql`
			INSERT INTO delivery_outbox (
				id, envelope_id, recipient_id, kind, status, capability_hash, reserved_capability_expires_at, sealed_capability, sealing_key_id, sealed_capability_sha256,
				available_at, attempts, locked_at, delivered_at, provider_message_id, last_error, created_at, updated_at, claim_token, retryable
			) VALUES (
				${newUuidV7()}, ${envelopeId}, ${recipientId}, 'recipient_invitation', 'failed', 'capability-hash-4', '2026-09-25T00:00:00.000Z'::timestamptz, 'sealed', 'key-1', ${'c'.repeat(64)},
				${iso(3_600_000)}::timestamptz, 1, NULL, NULL, NULL, 'retry_delayed', ${iso(-30_000)}::timestamptz, ${iso(-30_000)}::timestamptz, NULL, true
			)
		`;

		const now: Date = new Date(T0);
		const snapshot: MaintenanceBacklogSnapshot = await new PostgresMaintenanceBacklog(sql).snapshot(
			now
		);
		const delivery = snapshot.find((row) => row.queue === 'delivery');
		if (delivery === undefined) throw new Error('delivery queue missing from snapshot');

		expect(delivery.pendingCount).toBe(3);
		expect(delivery.permanentlyFailedCount).toBe(1);
		expect(delivery.oldestPendingAgeSeconds).toBe(7200);
		expect(delivery.oldestOverdueAgeSeconds).toBe(60);
	});

	it('keeps webhook lifetime age anchored to its event while a retry is delayed', async () => {
		if (sql === null) throw new Error('PostgreSQL unavailable');
		await seedBaseFixture(sql);
		await sql`
			UPDATE webhook_outbox SET status = 'failed', retryable = true,
				available_at = ${iso(3_600_000)}::timestamptz, attempts = 1
		`;
		const snapshot = await new PostgresMaintenanceBacklog(sql).snapshot(new Date(iso(1_800_000)));
		expect(snapshot.find((row) => row.queue === 'webhook_delivery')).toMatchObject({
			pendingCount: 1,
			oldestPendingAgeSeconds: 1800,
			oldestOverdueAgeSeconds: null
		});
	});
});
