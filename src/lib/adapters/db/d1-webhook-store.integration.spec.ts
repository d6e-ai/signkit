import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { WebhookApplication } from '$lib/application/webhooks/webhook-service';
import type { FailWebhookDeliveryCommand } from '$lib/ports/webhook-store';
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_MAX_PAYLOAD_BYTES } from '$lib/security/webhook';
import { AesGcmWebhookSigningSecretSealer } from '$lib/security/webhook-signing-secret';
import { WebhookTargetRejectedError } from '$lib/security/webhook-url';
import { D1WebhookStore } from './d1-webhook-store';
import { applyD1Migrations, sqliteD1Database } from './sqlite-d1-test-support';

const ORGANIZATION_ID: string = 'org-1';
const ENVELOPE_ID: string = '01920000-0000-7000-8000-000000000001';
const ENDPOINT_ID: string = '01900000-0000-7000-8000-000000000401';
const ACTOR_ID: string = 'user-1';
const PLAINTEXT_SECRET: string = 'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const TEST_KEY: string = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const CLAIMED_AT: string = '2026-09-13T00:10:00.000Z';
const STALE_BEFORE: string = '2026-09-13T00:05:00.000Z';
const AVAILABLE_AT: string = '2026-09-13T00:00:00.000Z';

interface Fixture {
	database: D1Database;
	sqlite: DatabaseSync;
	store: D1WebhookStore;
	sealer: AesGcmWebhookSigningSecretSealer;
}

async function createFixture(): Promise<Fixture> {
	const sqlite: DatabaseSync = new DatabaseSync(':memory:');
	applyD1Migrations(sqlite);
	const sealer: AesGcmWebhookSigningSecretSealer = new AesGcmWebhookSigningSecretSealer(TEST_KEY);
	const sealed = await sealer.seal(PLAINTEXT_SECRET, {
		organizationId: ORGANIZATION_ID,
		endpointId: ENDPOINT_ID
	});
	sqlite.exec(`
		INSERT INTO organization (id, d6e_organization_id, name, created_at)
		VALUES ('${ORGANIZATION_ID}', '${ORGANIZATION_ID}', 'Workspace', '${AVAILABLE_AT}');
		INSERT INTO envelope (
			id, organization_id, title, status, repository_generation, created_at, updated_at
		) VALUES (
			'${ENVELOPE_ID}', '${ORGANIZATION_ID}', 'Agreement', 'completed', 1,
			'${AVAILABLE_AT}', '${AVAILABLE_AT}'
		);
		INSERT INTO webhook_endpoint (
			id, organization_id, url, description, status, events_json, secret_hash,
			signing_secret, sealing_key_id, secret_prefix, created_at, created_by_user_id
		) VALUES (
			'${ENDPOINT_ID}', '${ORGANIZATION_ID}', 'https://hooks.example.com/signkit', NULL, 'active',
			'["envelope.voided"]', '${'a'.repeat(64)}', '${sealed.sealedSigningSecret}',
			'${sealed.sealingKeyId}', 'skwh1_abcdefgh', '${AVAILABLE_AT}', '${ACTOR_ID}'
		);
	`);
	const database: D1Database = sqliteD1Database(sqlite);
	return { database, sqlite, store: new D1WebhookStore(database), sealer };
}

function insertAuditEvent(sqlite: DatabaseSync, auditEventId: string): void {
	sqlite.exec(`
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			'${auditEventId}', '${ORGANIZATION_ID}', '${ENVELOPE_ID}',
			(SELECT COALESCE(MAX(sequence), 0) + 1 FROM audit_event
				WHERE organization_id = '${ORGANIZATION_ID}' AND envelope_id = '${ENVELOPE_ID}'),
			'envelope.completed', 'system', 'system', '{}', '${'0'.repeat(64)}', '${'e'.repeat(64)}',
			'${AVAILABLE_AT}'
		);
	`);
}

function insertOutbox(
	sqlite: DatabaseSync,
	auditEventId: string,
	overrides: {
		status?: string;
		attempts?: number;
		retryable?: number;
		availableAt?: string;
		claimToken?: string | null;
		lockedAt?: string | null;
		payloadJson?: string;
	} = {}
): void {
	insertAuditEvent(sqlite, auditEventId);
	const status: string = overrides.status ?? 'pending';
	const attempts: number = overrides.attempts ?? 0;
	const retryable: number = overrides.retryable ?? 1;
	const availableAt: string = overrides.availableAt ?? AVAILABLE_AT;
	const claimToken: string | null = overrides.claimToken ?? null;
	const lockedAt: string | null = overrides.lockedAt ?? null;
	const payloadJson: string = overrides.payloadJson ?? '{"eventType":"envelope.completed"}';
	sqlite
		.prepare(
			`INSERT INTO webhook_outbox (
				organization_id, endpoint_id, audit_event_id, envelope_id, event_type, payload_json,
				status, attempts, available_at, claim_token, locked_at, last_error, updated_at, retryable
			) VALUES (?, ?, ?, ?, 'envelope.completed', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
		)
		.run(
			ORGANIZATION_ID,
			ENDPOINT_ID,
			auditEventId,
			ENVELOPE_ID,
			payloadJson,
			status,
			attempts,
			availableAt,
			claimToken,
			lockedAt,
			AVAILABLE_AT,
			retryable
		);
}

function outboxState(
	sqlite: DatabaseSync,
	auditEventId: string
): { status: string; attempts: number; retryable: number } {
	return sqlite
		.prepare(
			`SELECT status, attempts, retryable FROM webhook_outbox
			 WHERE organization_id = ? AND endpoint_id = ? AND audit_event_id = ?`
		)
		.get(ORGANIZATION_ID, ENDPOINT_ID, auditEventId) as {
		status: string;
		attempts: number;
		retryable: number;
	};
}

const claimCommand = {
	claimToken: 'claim-token-reclaim-0001',
	claimedAt: CLAIMED_AT,
	staleBefore: STALE_BEFORE,
	limit: 10
};

describe('D1WebhookStore webhook retry terminalization', () => {
	it('does not reclaim HTTP 4xx, SSRF, or payload-too-large terminal failures', async () => {
		const { store, sqlite, sealer } = await createFixture();
		const oversizedPayload: string = `{"pad":"${'ä'.repeat(WEBHOOK_MAX_PAYLOAD_BYTES / 2)}"}`;
		expect(new TextEncoder().encode(oversizedPayload).byteLength).toBeGreaterThan(
			WEBHOOK_MAX_PAYLOAD_BYTES
		);

		const cases: readonly {
			auditEventId: string;
			payloadJson?: string;
			dispatch: () => Promise<
				| { ok: true; status: number }
				| { ok: false; retryable: boolean; status: number | null; errorCode: string }
			>;
			errorCode: string;
		}[] = [
			{
				auditEventId: '01900000-0000-7000-8000-000000000501',
				dispatch: async () => ({
					ok: false,
					retryable: false,
					status: 400,
					errorCode: 'http_400'
				}),
				errorCode: 'http_400'
			},
			{
				auditEventId: '01900000-0000-7000-8000-000000000502',
				dispatch: async () => {
					throw new WebhookTargetRejectedError('Webhook URL hostname is not a public DNS name');
				},
				errorCode: 'ssrf_rejected'
			},
			{
				auditEventId: '01900000-0000-7000-8000-000000000503',
				payloadJson: oversizedPayload,
				dispatch: async () => ({ ok: true, status: 200 }),
				errorCode: 'payload_too_large'
			}
		];

		for (const testCase of cases) {
			insertOutbox(sqlite, testCase.auditEventId, { payloadJson: testCase.payloadJson });
			const app = new WebhookApplication(store, sealer, {
				now: () => new Date(CLAIMED_AT),
				dispatch: testCase.dispatch
			});
			await expect(app.drainPendingDeliveries(10)).resolves.toMatchObject({
				claimed: 1,
				delivered: 0,
				retried: 0,
				failed: 1
			});
			expect(outboxState(sqlite, testCase.auditEventId)).toMatchObject({
				status: 'failed',
				retryable: 0
			});
			await expect(store.claimPendingDeliveries(claimCommand)).resolves.toEqual([]);
			expect(outboxState(sqlite, testCase.auditEventId)).toMatchObject({
				status: 'failed',
				retryable: 0
			});
			const log = sqlite
				.prepare(
					`SELECT status, error_code FROM webhook_delivery_log
					 WHERE organization_id = ? AND endpoint_id = ? AND audit_event_id = ?`
				)
				.get(ORGANIZATION_ID, ENDPOINT_ID, testCase.auditEventId) as {
				status: string;
				error_code: string;
			};
			expect(log).toEqual({ status: 'failed', error_code: testCase.errorCode });
		}
	});

	it('reclaims retryable failures until the shared attempt ceiling', async () => {
		const { store, sqlite } = await createFixture();
		const auditEventId: string = '01900000-0000-7000-8000-000000000511';
		insertOutbox(sqlite, auditEventId, {
			status: 'processing',
			attempts: 1,
			claimToken: 'claim-old',
			lockedAt: CLAIMED_AT
		});
		const command: FailWebhookDeliveryCommand = {
			organizationId: ORGANIZATION_ID,
			endpointId: ENDPOINT_ID,
			auditEventId,
			claimToken: 'claim-old',
			failedAt: CLAIMED_AT,
			retryable: true,
			nextAvailableAt: AVAILABLE_AT,
			errorCode: 'http_500',
			httpStatus: 500
		};
		await expect(store.failDelivery(command)).resolves.toEqual({ outcome: 'failed' });
		expect(outboxState(sqlite, auditEventId)).toEqual({
			status: 'failed',
			attempts: 1,
			retryable: 1
		});

		const claimed = await store.claimPendingDeliveries(claimCommand);
		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.auditEventId).toBe(auditEventId);
		expect(claimed[0]?.attempts).toBe(2);
		expect(outboxState(sqlite, auditEventId)).toEqual({
			status: 'processing',
			attempts: 2,
			retryable: 1
		});
	});

	it('does not reclaim a stale processing lease at the attempt ceiling', async () => {
		const { store, sqlite } = await createFixture();
		const auditEventId: string = '01900000-0000-7000-8000-000000000521';
		insertOutbox(sqlite, auditEventId, {
			status: 'processing',
			attempts: WEBHOOK_MAX_ATTEMPTS,
			claimToken: 'claim-stale',
			lockedAt: AVAILABLE_AT
		});
		await expect(store.claimPendingDeliveries(claimCommand)).resolves.toEqual([]);
		expect(outboxState(sqlite, auditEventId)).toEqual({
			status: 'processing',
			attempts: WEBHOOK_MAX_ATTEMPTS,
			retryable: 1
		});
	});

	it('reclaims a stale processing lease only while it is below the attempt ceiling', async () => {
		const { store, sqlite } = await createFixture();
		const auditEventId: string = '01900000-0000-7000-8000-000000000522';
		insertOutbox(sqlite, auditEventId, {
			status: 'processing',
			attempts: WEBHOOK_MAX_ATTEMPTS - 1,
			claimToken: 'claim-stale',
			lockedAt: AVAILABLE_AT
		});
		const claimed = await store.claimPendingDeliveries(claimCommand);
		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
		expect(outboxState(sqlite, auditEventId)).toEqual({
			status: 'processing',
			attempts: WEBHOOK_MAX_ATTEMPTS,
			retryable: 1
		});
		await expect(
			store.claimPendingDeliveries({ ...claimCommand, claimToken: 'claim-token-reclaim-0002' })
		).resolves.toEqual([]);
		expect(outboxState(sqlite, auditEventId).attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
	});
});
