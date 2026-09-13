import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhookApplication } from '$lib/application/webhooks/webhook-service';
import type { FailWebhookDeliveryCommand } from '$lib/ports/webhook-store';
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_MAX_PAYLOAD_BYTES } from '$lib/security/webhook';
import { AesGcmWebhookSigningSecretSealer } from '$lib/security/webhook-signing-secret';
import { WebhookTargetRejectedError } from '$lib/security/webhook-url';
import { PostgresWebhookStore } from './postgres-webhook-store';

const TEST_DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const postgresDescribe = TEST_DATABASE_URL === undefined ? describe.skip : describe;
const ORGANIZATION_ID: string = 'org-1';
const ENVELOPE_ID: string = '01920000-0000-7000-8000-000000000001';
const ENDPOINT_ID: string = '01900000-0000-7000-8000-000000000401';
const ACTOR_ID: string = 'user-1';
const PLAINTEXT_SECRET: string = 'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const TEST_KEY: string = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const CLAIMED_AT: string = '2026-09-13T00:10:00.000Z';
const STALE_BEFORE: string = '2026-09-13T00:05:00.000Z';
const AVAILABLE_AT: string = '2026-09-13T00:00:00.000Z';
const MIGRATION_PATHS: readonly string[] = readdirSync('migrations/postgres')
	.filter((name: string): boolean => /^\d{4}_.+\.sql$/.test(name))
	.sort()
	.map((name: string): string => `migrations/postgres/${name}`);

let sql: ReturnType<typeof postgres> | null = null;
const schemaName: string = `signkit_wh_${process.pid}_${randomUUID().replaceAll('-', '')}`;

function database(): ReturnType<typeof postgres> {
	if (sql === null) throw new Error('PostgreSQL test client is not connected');
	return sql;
}

postgresDescribe('PostgresWebhookStore webhook retry terminalization', () => {
	beforeAll(async () => {
		sql = postgres(TEST_DATABASE_URL as string, { max: 1, onnotice: (): void => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
		await sql.unsafe(`SET search_path TO "${schemaName}"`);
		await sql.unsafe(`SET TIME ZONE 'UTC'`);
		for (const path of MIGRATION_PATHS) await sql.unsafe(readFileSync(path, 'utf8'));
		const sealer = new AesGcmWebhookSigningSecretSealer(TEST_KEY);
		const sealed = await sealer.seal(PLAINTEXT_SECRET, {
			organizationId: ORGANIZATION_ID,
			endpointId: ENDPOINT_ID
		});
		await sql.unsafe(`
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
	});

	afterAll(async () => {
		if (sql === null) return;
		await sql.unsafe('SET search_path TO public');
		await sql.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
		await sql.end({ timeout: 5 });
		sql = null;
	});

	it('does not reclaim HTTP 4xx, SSRF, or payload-too-large terminal failures', async () => {
		const store = new PostgresWebhookStore(database());
		const sealer = new AesGcmWebhookSigningSecretSealer(TEST_KEY);
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
			await insertOutbox(testCase.auditEventId, { payloadJson: testCase.payloadJson });
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
			expect(await outboxState(testCase.auditEventId)).toMatchObject({
				status: 'failed',
				retryable: false
			});
			await expect(store.claimPendingDeliveries(claimCommand())).resolves.toEqual([]);
			expect(await outboxState(testCase.auditEventId)).toMatchObject({
				status: 'failed',
				retryable: false
			});
		}
	});

	it('reclaims retryable failures until the shared attempt ceiling', async () => {
		const store = new PostgresWebhookStore(database());
		const auditEventId: string = '01900000-0000-7000-8000-000000000511';
		await insertOutbox(auditEventId, {
			status: 'processing',
			attempts: 1,
			claimToken: 'claim-old-token-0001',
			lockedAt: CLAIMED_AT
		});
		const command: FailWebhookDeliveryCommand = {
			organizationId: ORGANIZATION_ID,
			endpointId: ENDPOINT_ID,
			auditEventId,
			claimToken: 'claim-old-token-0001',
			failedAt: CLAIMED_AT,
			retryable: true,
			nextAvailableAt: AVAILABLE_AT,
			errorCode: 'http_500',
			httpStatus: 500
		};
		await expect(store.failDelivery(command)).resolves.toEqual({ outcome: 'failed' });
		expect(await outboxState(auditEventId)).toEqual({
			status: 'failed',
			attempts: 1,
			retryable: true
		});
		const claimed = await store.claimPendingDeliveries(claimCommand());
		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.auditEventId).toBe(auditEventId);
		expect(claimed[0]?.attempts).toBe(2);
	});

	it('does not reclaim a stale processing lease at the attempt ceiling', async () => {
		const store = new PostgresWebhookStore(database());
		const auditEventId: string = '01900000-0000-7000-8000-000000000521';
		await insertOutbox(auditEventId, {
			status: 'processing',
			attempts: WEBHOOK_MAX_ATTEMPTS,
			claimToken: 'claim-stale-token-0001',
			lockedAt: AVAILABLE_AT
		});
		await expect(store.claimPendingDeliveries(claimCommand())).resolves.toEqual([]);
		expect(await outboxState(auditEventId)).toEqual({
			status: 'processing',
			attempts: WEBHOOK_MAX_ATTEMPTS,
			retryable: true
		});
	});

	it('reclaims a stale processing lease only while it is below the attempt ceiling', async () => {
		const store = new PostgresWebhookStore(database());
		const auditEventId: string = '01900000-0000-7000-8000-000000000522';
		await insertOutbox(auditEventId, {
			status: 'processing',
			attempts: WEBHOOK_MAX_ATTEMPTS - 1,
			claimToken: 'claim-stale-token-0002',
			lockedAt: AVAILABLE_AT
		});
		const claimed = await store.claimPendingDeliveries(claimCommand());
		expect(claimed).toHaveLength(1);
		expect(claimed[0]?.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
		await expect(
			store.claimPendingDeliveries(claimCommand('claim-token-reclaim-0002'))
		).resolves.toEqual([]);
		expect((await outboxState(auditEventId)).attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
	});
});

function claimCommand(claimToken: string = 'claim-token-reclaim-0001'): {
	claimToken: string;
	claimedAt: string;
	staleBefore: string;
	limit: number;
} {
	return { claimToken, claimedAt: CLAIMED_AT, staleBefore: STALE_BEFORE, limit: 10 };
}

async function insertOutbox(
	auditEventId: string,
	overrides: {
		status?: string;
		attempts?: number;
		retryable?: boolean;
		availableAt?: string;
		claimToken?: string | null;
		lockedAt?: string | null;
		payloadJson?: string;
	} = {}
): Promise<void> {
	const [{ n }]: { n: string }[] = await database()`
		SELECT COALESCE(MAX(sequence), 0)::text AS n FROM audit_event
		WHERE organization_id = ${ORGANIZATION_ID} AND envelope_id = ${ENVELOPE_ID}`;
	await database()`
		INSERT INTO audit_event (
			id, organization_id, envelope_id, sequence, event_type, actor_type, actor_id,
			payload_json, previous_hash, event_hash, occurred_at
		) VALUES (
			${auditEventId}, ${ORGANIZATION_ID}, ${ENVELOPE_ID}, ${Number(n) + 1},
			'envelope.completed', 'system', 'system', '{}', ${'0'.repeat(64)}, ${'e'.repeat(64)},
			${AVAILABLE_AT}::timestamptz
		)`;
	await database()`
		INSERT INTO webhook_outbox (
			organization_id, endpoint_id, audit_event_id, envelope_id, event_type, payload_json,
			status, attempts, available_at, claim_token, locked_at, last_error, updated_at, retryable
		) VALUES (
			${ORGANIZATION_ID}, ${ENDPOINT_ID}, ${auditEventId}, ${ENVELOPE_ID}, 'envelope.completed',
			${overrides.payloadJson ?? '{"eventType":"envelope.completed"}'},
			${overrides.status ?? 'pending'}, ${overrides.attempts ?? 0},
			${overrides.availableAt ?? AVAILABLE_AT}::timestamptz,
			${overrides.claimToken ?? null},
			${overrides.lockedAt === undefined || overrides.lockedAt === null ? null : overrides.lockedAt}::timestamptz,
			NULL, ${AVAILABLE_AT}::timestamptz, ${overrides.retryable ?? true}
		)`;
}

async function outboxState(
	auditEventId: string
): Promise<{ status: string; attempts: number; retryable: boolean }> {
	const rows: { status: string; attempts: number; retryable: boolean }[] = await database()`
		SELECT status, attempts, retryable FROM webhook_outbox
		WHERE organization_id = ${ORGANIZATION_ID}
			AND endpoint_id = ${ENDPOINT_ID}
			AND audit_event_id = ${auditEventId}`;
	const row = rows[0];
	if (row === undefined) throw new Error(`missing webhook outbox row ${auditEventId}`);
	return row;
}
