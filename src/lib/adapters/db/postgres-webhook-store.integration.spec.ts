import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebhookApplication } from '$lib/application/webhooks/webhook-service';
import type {
	CompleteWebhookDeliveryCommand,
	CreateWebhookEndpointCommand,
	CreateWebhookEndpointResult,
	FailWebhookDeliveryCommand,
	RevokeWebhookEndpointCommand,
	RevokeWebhookEndpointResult
} from '$lib/ports/webhook-store';
import {
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION,
	WEBHOOK_MAX_PAYLOAD_BYTES
} from '$lib/security/webhook';
import { AesGcmWebhookSigningSecretSealer } from '$lib/security/webhook-signing-secret';
import { WebhookTargetRejectedError } from '$lib/security/webhook-url';
import { PostgresWebhookStore } from './postgres-webhook-store';

const TEST_DATABASE_URL: string | undefined = process.env.POSTGRES_TEST_URL?.trim() || undefined;
const CI_ENABLED: boolean =
	process.env.CI !== undefined &&
	process.env.CI.trim() !== '' &&
	!['0', 'false', 'no'].includes(process.env.CI.toLowerCase());
if (CI_ENABLED && TEST_DATABASE_URL === undefined) {
	throw new Error('POSTGRES_TEST_URL is required when PostgreSQL integration tests run in CI');
}
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
		// Forces the delivery-log INSERT half of completeDelivery/failDelivery to fail so
		// tests can prove the paired webhook_outbox UPDATE rolls back with it, rather than
		// leaving a completed/failed outbox row with no matching log entry. Sentinel HTTP
		// status 599 is never used by a real dispatch outcome elsewhere in this file.
		await sql.unsafe(`
			CREATE FUNCTION webhook_delivery_log_test_poison() RETURNS trigger AS $$
			BEGIN
				IF NEW.http_status = 599 THEN
					RAISE EXCEPTION 'signkit_test_forced_delivery_log_failure';
				END IF;
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER webhook_delivery_log_test_poison_trigger
				BEFORE INSERT ON webhook_delivery_log
				FOR EACH ROW EXECUTE FUNCTION webhook_delivery_log_test_poison();
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

	it('rolls back the outbox completion when the paired delivery-log insert fails, leaving no stale log', async () => {
		const store = new PostgresWebhookStore(database());
		const auditEventId: string = '01900000-0000-7000-8000-000000000531';
		const claimToken: string = 'claim-poison-token-0001';
		await insertOutbox(auditEventId, {
			status: 'processing',
			attempts: 1,
			claimToken,
			lockedAt: CLAIMED_AT
		});
		const poisoned: CompleteWebhookDeliveryCommand = {
			organizationId: ORGANIZATION_ID,
			endpointId: ENDPOINT_ID,
			auditEventId,
			claimToken,
			deliveredAt: CLAIMED_AT,
			httpStatus: 599
		};
		await expect(store.completeDelivery(poisoned)).rejects.toThrow(
			/signkit_test_forced_delivery_log_failure/
		);
		expect(await outboxState(auditEventId)).toMatchObject({ status: 'processing' });
		expect(await outboxClaimToken(auditEventId)).toBe(claimToken);
		expect(await deliveryLogCount(auditEventId)).toBe(0);

		const retried: CompleteWebhookDeliveryCommand = { ...poisoned, httpStatus: 200 };
		await expect(store.completeDelivery(retried)).resolves.toEqual({ outcome: 'completed' });
		expect(await outboxState(auditEventId)).toMatchObject({ status: 'delivered' });
		expect(await deliveryLogCount(auditEventId)).toBe(1);
	});

	it('rolls back the outbox failure when the paired delivery-log insert fails, leaving no stale log', async () => {
		const store = new PostgresWebhookStore(database());
		const auditEventId: string = '01900000-0000-7000-8000-000000000532';
		const claimToken: string = 'claim-poison-token-0002';
		await insertOutbox(auditEventId, {
			status: 'processing',
			attempts: 1,
			claimToken,
			lockedAt: CLAIMED_AT
		});
		const poisoned: FailWebhookDeliveryCommand = {
			organizationId: ORGANIZATION_ID,
			endpointId: ENDPOINT_ID,
			auditEventId,
			claimToken,
			failedAt: CLAIMED_AT,
			retryable: true,
			nextAvailableAt: AVAILABLE_AT,
			errorCode: 'http_500',
			httpStatus: 599
		};
		await expect(store.failDelivery(poisoned)).rejects.toThrow(
			/signkit_test_forced_delivery_log_failure/
		);
		expect(await outboxState(auditEventId)).toMatchObject({ status: 'processing' });
		expect(await outboxClaimToken(auditEventId)).toBe(claimToken);
		expect(await deliveryLogCount(auditEventId)).toBe(0);

		const retried: FailWebhookDeliveryCommand = { ...poisoned, httpStatus: 500 };
		await expect(store.failDelivery(retried)).resolves.toEqual({ outcome: 'failed' });
		expect(await outboxState(auditEventId)).toMatchObject({ status: 'failed' });
		expect(await deliveryLogCount(auditEventId)).toBe(1);
	});

	it('leaves no delivery log when completion targets a stale (already-reclaimed) claim', async () => {
		const store = new PostgresWebhookStore(database());
		const auditEventId: string = '01900000-0000-7000-8000-000000000533';
		await insertOutbox(auditEventId, {
			status: 'processing',
			attempts: 1,
			claimToken: 'claim-current-token-0001',
			lockedAt: CLAIMED_AT
		});
		await expect(
			store.completeDelivery({
				organizationId: ORGANIZATION_ID,
				endpointId: ENDPOINT_ID,
				auditEventId,
				claimToken: 'claim-stale-superseded-token',
				deliveredAt: CLAIMED_AT,
				httpStatus: 200
			})
		).resolves.toEqual({ outcome: 'stale' });
		expect(await outboxState(auditEventId)).toMatchObject({ status: 'processing' });
		expect(await deliveryLogCount(auditEventId)).toBe(0);

		await expect(
			store.failDelivery({
				organizationId: ORGANIZATION_ID,
				endpointId: ENDPOINT_ID,
				auditEventId,
				claimToken: 'claim-stale-superseded-token',
				failedAt: CLAIMED_AT,
				retryable: true,
				nextAvailableAt: AVAILABLE_AT,
				errorCode: 'http_500',
				httpStatus: 500
			})
		).resolves.toEqual({ outcome: 'stale' });
		expect(await outboxState(auditEventId)).toMatchObject({ status: 'processing' });
		expect(await deliveryLogCount(auditEventId)).toBe(0);
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

async function outboxClaimToken(auditEventId: string): Promise<string | null> {
	const rows: { claimToken: string | null }[] = await database()`
		SELECT claim_token AS "claimToken" FROM webhook_outbox
		WHERE organization_id = ${ORGANIZATION_ID}
			AND endpoint_id = ${ENDPOINT_ID}
			AND audit_event_id = ${auditEventId}`;
	const row = rows[0];
	if (row === undefined) throw new Error(`missing webhook outbox row ${auditEventId}`);
	return row.claimToken;
}

async function deliveryLogCount(auditEventId: string): Promise<number> {
	const [{ n }]: { n: string }[] = await database()`
		SELECT COUNT(*)::text AS n FROM webhook_delivery_log
		WHERE organization_id = ${ORGANIZATION_ID}
			AND endpoint_id = ${ENDPOINT_ID}
			AND audit_event_id = ${auditEventId}`;
	return Number(n);
}

postgresDescribe('PostgresWebhookStore endpoint create and revoke', () => {
	let endpointSql: ReturnType<typeof postgres> | null = null;
	const endpointSchemaName: string = `signkit_wh_cap_${process.pid}_${randomUUID().replaceAll('-', '')}`;
	const CREATE_ID_A: string = '01900000-0000-7000-8000-000000000a01';
	const CREATE_ID_B: string = '01900000-0000-7000-8000-000000000a02';
	const REVOKE_ID_A: string = '01900000-0000-7000-8000-000000000b01';
	const REVOKE_ID_B: string = '01900000-0000-7000-8000-000000000b02';
	const REQUEST_HASH: string = 'c'.repeat(64);
	const OTHER_REQUEST_HASH: string = 'd'.repeat(64);

	function endpointDatabase(): ReturnType<typeof postgres> {
		if (endpointSql === null) throw new Error('PostgreSQL endpoint test client is not connected');
		return endpointSql;
	}

	function createCommand(
		overrides: Partial<CreateWebhookEndpointCommand> = {}
	): CreateWebhookEndpointCommand {
		return {
			id: CREATE_ID_A,
			organizationId: ORGANIZATION_ID,
			actorId: ACTOR_ID,
			idempotencyKey: 'idemp-create-001',
			requestFingerprint: REQUEST_HASH,
			url: 'https://hooks.example.com/target',
			description: 'Webhook Endpoint',
			eventsJson: '["envelope.completed"]',
			secretHash: 'b'.repeat(64),
			signingSecret: 'skwhs1_v1_' + 'C'.repeat(80),
			sealingKeyId: '0123456789abcdef',
			secretPrefix: 'skwh1_abcd',
			createdAt: AVAILABLE_AT,
			...overrides
		};
	}

	function revokeCommand(
		overrides: Partial<RevokeWebhookEndpointCommand> = {}
	): RevokeWebhookEndpointCommand {
		return {
			organizationId: ORGANIZATION_ID,
			webhookId: REVOKE_ID_A,
			actorId: ACTOR_ID,
			idempotencyKey: 'idemp-revoke-001',
			requestFingerprint: REQUEST_HASH,
			revokedAt: AVAILABLE_AT,
			...overrides
		};
	}

	async function seedActiveEndpoints(count: number): Promise<void> {
		await endpointDatabase()`
			INSERT INTO webhook_endpoint (
				id, organization_id, url, description, status, events_json, secret_hash,
				signing_secret, sealing_key_id, secret_prefix, created_at, created_by_user_id
			)
			SELECT
				'01900000-0000-7000-8000-' || lpad(i::text, 12, '0'),
				${ORGANIZATION_ID},
				'https://hooks.example.com/t' || i::text,
				NULL,
				'active',
				'["envelope.completed"]',
				${'a'.repeat(64)},
				${'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'},
				NULL,
				'skwh1_abcd',
				${AVAILABLE_AT}::timestamptz,
				${ACTOR_ID}
			FROM generate_series(1, ${count}) AS s(i)`;
	}

	async function insertActiveEndpoint(id: string): Promise<void> {
		await endpointDatabase()`
			INSERT INTO webhook_endpoint (
				id, organization_id, url, description, status, events_json, secret_hash,
				signing_secret, sealing_key_id, secret_prefix, created_at, created_by_user_id
			) VALUES (
				${id}, ${ORGANIZATION_ID}, ${'https://hooks.example.com/' + id}, NULL, 'active',
				'["envelope.completed"]', ${'a'.repeat(64)},
				${'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'}, NULL, 'skwh1_abcd',
				${AVAILABLE_AT}::timestamptz, ${ACTOR_ID}
			)`;
	}

	async function activeCount(): Promise<number> {
		const rows: { n: string }[] = await endpointDatabase()`
			SELECT COUNT(*)::text AS n FROM webhook_endpoint
			WHERE organization_id = ${ORGANIZATION_ID} AND status = 'active'`;
		return Number(rows[0]?.n ?? '0');
	}

	function openConcurrentSql(): ReturnType<typeof postgres> {
		return postgres(TEST_DATABASE_URL as string, {
			max: 2,
			onnotice: (): void => undefined,
			connection: { search_path: endpointSchemaName, TimeZone: 'UTC' }
		});
	}

	beforeAll(async () => {
		endpointSql = postgres(TEST_DATABASE_URL as string, {
			max: 1,
			onnotice: (): void => undefined
		});
		await endpointSql.unsafe(`CREATE SCHEMA "${endpointSchemaName}"`);
		await endpointSql.unsafe(`SET search_path TO "${endpointSchemaName}"`);
		await endpointSql.unsafe(`SET TIME ZONE 'UTC'`);
		for (const path of MIGRATION_PATHS) await endpointSql.unsafe(readFileSync(path, 'utf8'));
		await endpointSql.unsafe(`
			INSERT INTO organization (id, d6e_organization_id, name, created_at)
			VALUES ('${ORGANIZATION_ID}', '${ORGANIZATION_ID}', 'Workspace', '${AVAILABLE_AT}');
		`);
	});

	beforeEach(async () => {
		await endpointDatabase().unsafe('TRUNCATE webhook_endpoint CASCADE');
	});

	afterAll(async () => {
		if (endpointSql === null) return;
		await endpointSql.unsafe('SET search_path TO public');
		await endpointSql.unsafe(`DROP SCHEMA "${endpointSchemaName}" CASCADE`);
		await endpointSql.end({ timeout: 5 });
		endpointSql = null;
	});

	it('creates a webhook endpoint and replays an identical idempotency key', async () => {
		const store = new PostgresWebhookStore(endpointDatabase());
		const command = createCommand();
		const created = await store.createEndpoint(command);
		expect(created.outcome).toBe('created');
		const replay = await store.createEndpoint(command);
		expect(replay.outcome).toBe('replayed');
		if (created.outcome === 'created' && replay.outcome === 'replayed') {
			expect(replay.endpoint).toEqual(created.endpoint);
		}
	});

	it('returns conflict when the create idempotency key is reused with a different fingerprint', async () => {
		const store = new PostgresWebhookStore(endpointDatabase());
		await store.createEndpoint(createCommand());
		await expect(
			store.createEndpoint(createCommand({ requestFingerprint: OTHER_REQUEST_HASH }))
		).resolves.toEqual({ outcome: 'conflict' });
	});

	it('enforces the active endpoint cap when already at capacity', async () => {
		await seedActiveEndpoints(WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION);
		const store = new PostgresWebhookStore(endpointDatabase());
		await expect(store.createEndpoint(createCommand())).resolves.toEqual({
			outcome: 'limit_exceeded'
		});
		expect(await activeCount()).toBe(WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION);
	});

	it('lets exactly one of two synchronized creates succeed from 19 active endpoints', async () => {
		await seedActiveEndpoints(WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION - 1);
		expect(await activeCount()).toBe(19);

		const concurrentSql = openConcurrentSql();
		try {
			const [storeA, storeB] = synchronizeCreateEndpoint([
				new PostgresWebhookStore(concurrentSql),
				new PostgresWebhookStore(concurrentSql)
			]);
			const [first, second]: CreateWebhookEndpointResult[] = await Promise.all([
				storeA.createEndpoint(createCommand({ id: CREATE_ID_A, idempotencyKey: 'idemp-race-a' })),
				storeB.createEndpoint(createCommand({ id: CREATE_ID_B, idempotencyKey: 'idemp-race-b' }))
			]);
			expect([first.outcome, second.outcome].sort()).toEqual(['created', 'limit_exceeded']);
			expect(await activeCount()).toBe(WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	it('resolves a concurrent same-key create race to created and replayed', async () => {
		const concurrentSql = openConcurrentSql();
		try {
			const command = createCommand();
			const [storeA, storeB] = synchronizeCreateEndpoint([
				new PostgresWebhookStore(concurrentSql),
				new PostgresWebhookStore(concurrentSql)
			]);
			const [first, second]: CreateWebhookEndpointResult[] = await Promise.all([
				storeA.createEndpoint(command),
				storeB.createEndpoint(command)
			]);
			expect([first.outcome, second.outcome].sort()).toEqual(['created', 'replayed']);
			const created = first.outcome === 'created' ? first : second;
			const replayed = first.outcome === 'replayed' ? first : second;
			if (created.outcome === 'created' && replayed.outcome === 'replayed') {
				expect(replayed.endpoint).toEqual(created.endpoint);
			}
			const rows: { id: string }[] = await endpointDatabase()`
				SELECT id FROM webhook_endpoint WHERE organization_id = ${ORGANIZATION_ID}`;
			expect(rows).toHaveLength(1);
			expect(rows[0]?.id).toBe(command.id);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	it('resolves a concurrent same-key create race with mismatched fingerprints to created and conflict', async () => {
		const concurrentSql = openConcurrentSql();
		try {
			const [storeA, storeB] = synchronizeCreateEndpoint([
				new PostgresWebhookStore(concurrentSql),
				new PostgresWebhookStore(concurrentSql)
			]);
			const [first, second]: CreateWebhookEndpointResult[] = await Promise.all([
				storeA.createEndpoint(createCommand()),
				storeB.createEndpoint(createCommand({ requestFingerprint: OTHER_REQUEST_HASH }))
			]);
			expect([first.outcome, second.outcome].sort()).toEqual(['conflict', 'created']);
			const rows: { id: string }[] = await endpointDatabase()`
				SELECT id FROM webhook_endpoint WHERE organization_id = ${ORGANIZATION_ID}`;
			expect(rows).toHaveLength(1);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	it('resolves a concurrent same-key revoke race to revoked and replayed', async () => {
		await insertActiveEndpoint(REVOKE_ID_A);
		const concurrentSql = openConcurrentSql();
		try {
			const command = revokeCommand();
			const [storeA, storeB] = synchronizeRevokeEndpoint([
				new PostgresWebhookStore(concurrentSql),
				new PostgresWebhookStore(concurrentSql)
			]);
			const [first, second]: RevokeWebhookEndpointResult[] = await Promise.all([
				storeA.revokeEndpoint(command),
				storeB.revokeEndpoint(command)
			]);
			expect([first.outcome, second.outcome].sort()).toEqual(['replayed', 'revoked']);
			expect(await activeCount()).toBe(0);
			const commandRows: { n: string }[] = await endpointDatabase()`
				SELECT COUNT(*)::text AS n FROM webhook_endpoint_command
				WHERE organization_id = ${ORGANIZATION_ID} AND idempotency_key = ${command.idempotencyKey}`;
			expect(Number(commandRows[0]?.n)).toBe(1);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});

	it('classifies a concurrent same-key revoke of different endpoints as conflict rather than 503', async () => {
		await insertActiveEndpoint(REVOKE_ID_A);
		await insertActiveEndpoint(REVOKE_ID_B);
		const concurrentSql = openConcurrentSql();
		try {
			const [storeA, storeB] = synchronizeRevokeEndpoint([
				new PostgresWebhookStore(concurrentSql),
				new PostgresWebhookStore(concurrentSql)
			]);
			const [first, second]: RevokeWebhookEndpointResult[] = await Promise.all([
				storeA.revokeEndpoint(revokeCommand({ webhookId: REVOKE_ID_A })),
				storeB.revokeEndpoint(
					revokeCommand({
						webhookId: REVOKE_ID_B,
						requestFingerprint: OTHER_REQUEST_HASH
					})
				)
			]);
			expect([first.outcome, second.outcome].sort()).toEqual(['conflict', 'revoked']);
			expect(await activeCount()).toBe(1);
		} finally {
			await concurrentSql.end({ timeout: 5 });
		}
	});
});

interface SynchronizedCreateEndpointStore {
	createEndpoint(command: CreateWebhookEndpointCommand): Promise<CreateWebhookEndpointResult>;
}

function synchronizeCreateEndpoint(
	delegates: readonly PostgresWebhookStore[]
): readonly SynchronizedCreateEndpointStore[] {
	let arrivals: number = 0;
	let release: (() => void) | null = null;
	const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
		release = resolve;
	});
	return delegates.map((delegate: PostgresWebhookStore): SynchronizedCreateEndpointStore => ({
		createEndpoint: async (
			command: CreateWebhookEndpointCommand
		): Promise<CreateWebhookEndpointResult> => {
			arrivals += 1;
			if (arrivals === delegates.length) release?.();
			await gate;
			return delegate.createEndpoint(command);
		}
	}));
}

interface SynchronizedRevokeEndpointStore {
	revokeEndpoint(command: RevokeWebhookEndpointCommand): Promise<RevokeWebhookEndpointResult>;
}

function synchronizeRevokeEndpoint(
	delegates: readonly PostgresWebhookStore[]
): readonly SynchronizedRevokeEndpointStore[] {
	let arrivals: number = 0;
	let release: (() => void) | null = null;
	const gate: Promise<void> = new Promise<void>((resolve: () => void): void => {
		release = resolve;
	});
	return delegates.map((delegate: PostgresWebhookStore): SynchronizedRevokeEndpointStore => ({
		revokeEndpoint: async (
			command: RevokeWebhookEndpointCommand
		): Promise<RevokeWebhookEndpointResult> => {
			arrivals += 1;
			if (arrivals === delegates.length) release?.();
			await gate;
			return delegate.revokeEndpoint(command);
		}
	}));
}
