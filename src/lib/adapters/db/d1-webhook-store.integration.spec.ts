import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { WebhookApplication } from '$lib/application/webhooks/webhook-service';
import type {
	CompleteWebhookDeliveryCommand,
	CreateWebhookEndpointCommand,
	FailWebhookDeliveryCommand
} from '$lib/ports/webhook-store';
import {
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION,
	WEBHOOK_MAX_PAYLOAD_BYTES
} from '$lib/security/webhook';
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

function deliveryLogRows(
	sqlite: DatabaseSync,
	auditEventId: string
): { status: string; attempt: number; http_status: number | null; error_code: string | null }[] {
	return sqlite
		.prepare(
			`SELECT status, attempt, http_status, error_code FROM webhook_delivery_log
			 WHERE organization_id = ? AND endpoint_id = ? AND audit_event_id = ?
			 ORDER BY occurred_at ASC`
		)
		.all(ORGANIZATION_ID, ENDPOINT_ID, auditEventId) as {
		status: string;
		attempt: number;
		http_status: number | null;
		error_code: string | null;
	}[];
}

const claimCommand = {
	claimToken: 'claim-token-reclaim-0001',
	claimedAt: CLAIMED_AT,
	staleBefore: STALE_BEFORE,
	limit: 10
};

/** Wraps a D1Database so any prepared statement matching `matches` throws when executed, to prove batch() rolls back its other statements. */
function withFailingStatement(database: D1Database, matches: (sql: string) => boolean): D1Database {
	const failure = (sql: string): D1PreparedStatement =>
		({
			sql,
			bind: (): D1PreparedStatement => failure(sql),
			run: async (): Promise<never> => {
				throw new Error('simulated constraint failure');
			},
			all: async (): Promise<never> => {
				throw new Error('simulated constraint failure');
			},
			first: async (): Promise<never> => {
				throw new Error('simulated constraint failure');
			}
		}) as unknown as D1PreparedStatement;
	return {
		prepare: (sql: string): D1PreparedStatement =>
			matches(sql) ? failure(sql) : database.prepare(sql),
		batch: (statements: D1PreparedStatement[]): Promise<D1Result[]> => database.batch(statements)
	} as unknown as D1Database;
}

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

describe('D1WebhookStore.failDelivery', () => {
	function failCommand(
		auditEventId: string,
		overrides: Partial<FailWebhookDeliveryCommand> = {}
	): FailWebhookDeliveryCommand {
		return {
			organizationId: ORGANIZATION_ID,
			endpointId: ENDPOINT_ID,
			auditEventId,
			claimToken: 'claim-current',
			failedAt: CLAIMED_AT,
			retryable: true,
			nextAvailableAt: AVAILABLE_AT,
			errorCode: 'http_500',
			httpStatus: 500,
			...overrides
		};
	}

	it('does not log a delivery when the claim is stale', async () => {
		const { store, sqlite } = await createFixture();
		const auditEventId: string = '01900000-0000-7000-8000-000000000531';
		insertOutbox(sqlite, auditEventId, {
			status: 'processing',
			attempts: 2,
			claimToken: 'claim-current',
			lockedAt: CLAIMED_AT
		});

		await expect(
			store.failDelivery(failCommand(auditEventId, { claimToken: 'claim-wrong' }))
		).resolves.toEqual({ outcome: 'stale' });

		expect(outboxState(sqlite, auditEventId)).toEqual({
			status: 'processing',
			attempts: 2,
			retryable: 1
		});
		expect(deliveryLogRows(sqlite, auditEventId)).toEqual([]);
	});

	it('rolls back the outbox update when the delivery log insert fails', async () => {
		const { sqlite, database } = await createFixture();
		const auditEventId: string = '01900000-0000-7000-8000-000000000534';
		insertOutbox(sqlite, auditEventId, {
			status: 'processing',
			attempts: 4,
			claimToken: 'claim-current',
			lockedAt: CLAIMED_AT
		});
		const failingStore = new D1WebhookStore(
			withFailingStatement(database, (sql: string): boolean =>
				sql.includes('INSERT INTO webhook_delivery_log')
			)
		);

		await expect(failingStore.failDelivery(failCommand(auditEventId))).rejects.toThrow(
			'simulated constraint failure'
		);

		expect(outboxState(sqlite, auditEventId)).toEqual({
			status: 'processing',
			attempts: 4,
			retryable: 1
		});
		expect(deliveryLogRows(sqlite, auditEventId)).toEqual([]);
	});

	it('logs exactly one retrying entry for a valid retryable failure', async () => {
		const { store, sqlite } = await createFixture();
		const auditEventId: string = '01900000-0000-7000-8000-000000000532';
		insertOutbox(sqlite, auditEventId, {
			status: 'processing',
			attempts: 3,
			claimToken: 'claim-current',
			lockedAt: CLAIMED_AT
		});

		await expect(
			store.failDelivery(
				failCommand(auditEventId, { retryable: true, errorCode: 'http_500', httpStatus: 500 })
			)
		).resolves.toEqual({ outcome: 'failed' });

		expect(outboxState(sqlite, auditEventId)).toEqual({
			status: 'failed',
			attempts: 3,
			retryable: 1
		});
		expect(deliveryLogRows(sqlite, auditEventId)).toEqual([
			{ status: 'retrying', attempt: 3, http_status: 500, error_code: 'http_500' }
		]);
	});

	it('logs exactly one failed entry for a valid terminal failure', async () => {
		const { store, sqlite } = await createFixture();
		const auditEventId: string = '01900000-0000-7000-8000-000000000533';
		insertOutbox(sqlite, auditEventId, {
			status: 'processing',
			attempts: 5,
			claimToken: 'claim-current',
			lockedAt: CLAIMED_AT
		});

		await expect(
			store.failDelivery(
				failCommand(auditEventId, { retryable: false, errorCode: 'http_400', httpStatus: 400 })
			)
		).resolves.toEqual({ outcome: 'failed' });

		expect(outboxState(sqlite, auditEventId)).toEqual({
			status: 'failed',
			attempts: 5,
			retryable: 0
		});
		expect(deliveryLogRows(sqlite, auditEventId)).toEqual([
			{ status: 'failed', attempt: 5, http_status: 400, error_code: 'http_400' }
		]);
	});
});

describe('D1WebhookStore.completeDelivery', () => {
	function completeCommand(
		auditEventId: string,
		overrides: Partial<CompleteWebhookDeliveryCommand> = {}
	): CompleteWebhookDeliveryCommand {
		return {
			organizationId: ORGANIZATION_ID,
			endpointId: ENDPOINT_ID,
			auditEventId,
			claimToken: 'claim-current',
			deliveredAt: CLAIMED_AT,
			httpStatus: 200,
			...overrides
		};
	}

	it('does not log a delivery when the claim is stale', async () => {
		const { store, sqlite } = await createFixture();
		const auditEventId: string = '01900000-0000-7000-8000-000000000541';
		insertOutbox(sqlite, auditEventId, {
			status: 'processing',
			attempts: 2,
			claimToken: 'claim-current',
			lockedAt: CLAIMED_AT
		});

		await expect(
			store.completeDelivery(completeCommand(auditEventId, { claimToken: 'claim-wrong' }))
		).resolves.toEqual({ outcome: 'stale' });

		expect(outboxState(sqlite, auditEventId)).toEqual({
			status: 'processing',
			attempts: 2,
			retryable: 1
		});
		expect(deliveryLogRows(sqlite, auditEventId)).toEqual([]);
	});

	it('does not log a phantom completion when the claim is stale but already delivered', async () => {
		const { store, sqlite } = await createFixture();
		const auditEventId: string = '01900000-0000-7000-8000-000000000542';
		insertOutbox(sqlite, auditEventId, {
			status: 'delivered',
			attempts: 1,
			claimToken: null,
			lockedAt: null
		});

		await expect(
			store.completeDelivery(completeCommand(auditEventId, { claimToken: 'claim-current' }))
		).resolves.toEqual({ outcome: 'stale' });

		expect(outboxState(sqlite, auditEventId)).toEqual({
			status: 'delivered',
			attempts: 1,
			retryable: 1
		});
		expect(deliveryLogRows(sqlite, auditEventId)).toEqual([]);
	});

	it('rolls back the outbox update when the delivery log insert fails', async () => {
		const { sqlite, database } = await createFixture();
		const auditEventId: string = '01900000-0000-7000-8000-000000000543';
		insertOutbox(sqlite, auditEventId, {
			status: 'processing',
			attempts: 4,
			claimToken: 'claim-current',
			lockedAt: CLAIMED_AT
		});
		const failingStore = new D1WebhookStore(
			withFailingStatement(database, (sql: string): boolean =>
				sql.includes('INSERT INTO webhook_delivery_log')
			)
		);

		await expect(failingStore.completeDelivery(completeCommand(auditEventId))).rejects.toThrow(
			'simulated constraint failure'
		);

		expect(outboxState(sqlite, auditEventId)).toEqual({
			status: 'processing',
			attempts: 4,
			retryable: 1
		});
		expect(deliveryLogRows(sqlite, auditEventId)).toEqual([]);
	});

	it('logs exactly one delivered entry for a valid completion', async () => {
		const { store, sqlite } = await createFixture();
		const auditEventId: string = '01900000-0000-7000-8000-000000000544';
		insertOutbox(sqlite, auditEventId, {
			status: 'processing',
			attempts: 3,
			claimToken: 'claim-current',
			lockedAt: CLAIMED_AT
		});

		await expect(
			store.completeDelivery(completeCommand(auditEventId, { httpStatus: 200 }))
		).resolves.toEqual({ outcome: 'completed' });

		expect(outboxState(sqlite, auditEventId)).toEqual({
			status: 'delivered',
			attempts: 3,
			retryable: 1
		});
		expect(deliveryLogRows(sqlite, auditEventId)).toEqual([
			{ status: 'delivered', attempt: 3, http_status: 200, error_code: null }
		]);
	});
});

describe('D1WebhookStore.createEndpoint', () => {
	function createCommand(
		overrides: Partial<CreateWebhookEndpointCommand> = {}
	): CreateWebhookEndpointCommand {
		return {
			id: '01900000-0000-7000-8000-000000000701',
			organizationId: ORGANIZATION_ID,
			actorId: ACTOR_ID,
			idempotencyKey: 'idemp-create-001',
			requestFingerprint: 'f'.repeat(64),
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

	it('creates a new webhook endpoint and records create command', async () => {
		const { store, sqlite } = await createFixture();
		const command = createCommand();
		const result = await store.createEndpoint(command);
		expect(result).toMatchObject({
			outcome: 'created',
			endpoint: {
				id: command.id,
				organizationId: ORGANIZATION_ID,
				url: command.url,
				description: command.description,
				status: 'active'
			}
		});

		const endpointRow = sqlite
			.prepare('SELECT id, status, secret_hash, signing_secret FROM webhook_endpoint WHERE id = ?')
			.get(command.id) as {
			id: string;
			status: string;
			secret_hash: string;
			signing_secret: string;
		};
		expect(endpointRow.status).toBe('active');
		expect(endpointRow.secret_hash).toBe(command.secretHash);
		expect(endpointRow.signing_secret).toBe(command.signingSecret);

		const commandRow = sqlite
			.prepare(
				'SELECT command_type, request_hash FROM webhook_endpoint_command WHERE organization_id = ? AND actor_id = ? AND idempotency_key = ?'
			)
			.get(ORGANIZATION_ID, command.actorId, command.idempotencyKey) as {
			command_type: string;
			request_hash: string;
		};
		expect(commandRow.command_type).toBe('create');
		expect(commandRow.request_hash).toBe(command.requestFingerprint);
	});

	it('replays endpoint creation when idempotency key and fingerprint match', async () => {
		const { store } = await createFixture();
		const command = createCommand();
		const first = await store.createEndpoint(command);
		expect(first.outcome).toBe('created');

		const replay = await store.createEndpoint(command);
		expect(replay).toEqual({
			outcome: 'replayed',
			endpoint: (first as { outcome: 'created'; endpoint: unknown }).endpoint
		});
	});

	it('returns conflict when idempotency key is reused with mismatched fingerprint', async () => {
		const { store } = await createFixture();
		const command = createCommand();
		await store.createEndpoint(command);

		const conflict = await store.createEndpoint({
			...command,
			requestFingerprint: 'e'.repeat(64)
		});
		expect(conflict).toEqual({ outcome: 'conflict' });
	});

	it('enforces active endpoint limit when already at capacity', async () => {
		const { store, sqlite } = await createFixture();
		// Fixture already inserted 1 active endpoint (ENDPOINT_ID). Insert 19 more to reach 20.
		for (let i = 1; i < WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION; i++) {
			const hex = i.toString(16).padStart(4, '0');
			const id = `01900000-0000-7000-8000-00000000${hex}`;
			sqlite
				.prepare(
					`INSERT INTO webhook_endpoint (
						id, organization_id, url, description, status, events_json,
						secret_hash, signing_secret, sealing_key_id, secret_prefix, created_at, created_by_user_id
					) VALUES (?, ?, 'https://hooks.example.com/test', NULL, 'active', '["envelope.completed"]',
						?, 'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', NULL, 'skwh1_abcd', ?, ?)`
				)
				.run(id, ORGANIZATION_ID, 'a'.repeat(64), AVAILABLE_AT, ACTOR_ID);
		}

		const result = await store.createEndpoint(
			createCommand({
				id: '01900000-0000-7000-8000-000000000999',
				idempotencyKey: 'idemp-cap-001'
			})
		);
		expect(result).toEqual({ outcome: 'limit_exceeded' });
	});

	it('classifies database trigger abort as limit_exceeded with PostgreSQL parity', async () => {
		const { store, sqlite } = await createFixture();
		// Insert up to 20 endpoints
		for (let i = 1; i < WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION; i++) {
			const hex = i.toString(16).padStart(4, '0');
			const id = `01900000-0000-7000-8000-00000000${hex}`;
			sqlite
				.prepare(
					`INSERT INTO webhook_endpoint (
						id, organization_id, url, description, status, events_json,
						secret_hash, signing_secret, sealing_key_id, secret_prefix, created_at, created_by_user_id
					) VALUES (?, ?, 'https://hooks.example.com/test', NULL, 'active', '["envelope.completed"]',
						?, 'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', NULL, 'skwh1_abcd', ?, ?)`
				)
				.run(id, ORGANIZATION_ID, 'a'.repeat(64), AVAILABLE_AT, ACTOR_ID);
		}

		// When creating endpoint 21, the database trigger webhook_endpoint_active_cap_guard fires
		// and createEndpoint classifies it cleanly as limit_exceeded.
		const result = await store.createEndpoint(
			createCommand({
				id: '01900000-0000-7000-8000-000000000998',
				idempotencyKey: 'idemp-trigger-001'
			})
		);
		expect(result).toEqual({ outcome: 'limit_exceeded' });
	});

	it('resolves concurrent creation race atomically without exceeding cap', async () => {
		const { store, sqlite } = await createFixture();
		// Fixture has 1 active endpoint. Insert 18 more so there are 19 active (1 below cap).
		for (let i = 1; i < WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION - 1; i++) {
			const hex = i.toString(16).padStart(4, '0');
			const id = `01900000-0000-7000-8000-00000000${hex}`;
			sqlite
				.prepare(
					`INSERT INTO webhook_endpoint (
						id, organization_id, url, description, status, events_json,
						secret_hash, signing_secret, sealing_key_id, secret_prefix, created_at, created_by_user_id
					) VALUES (?, ?, 'https://hooks.example.com/test', NULL, 'active', '["envelope.completed"]',
						?, 'skwh1_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', NULL, 'skwh1_abcd', ?, ?)`
				)
				.run(id, ORGANIZATION_ID, 'a'.repeat(64), AVAILABLE_AT, ACTOR_ID);
		}

		// Exactly 1 spot remaining before reaching cap of 20
		const countBefore = sqlite
			.prepare(
				'SELECT COUNT(*) AS n FROM webhook_endpoint WHERE organization_id = ? AND status = ?'
			)
			.get(ORGANIZATION_ID, 'active') as { n: number };
		expect(countBefore.n).toBe(19);

		// Two concurrent requests to create endpoint 20
		const cmdA = createCommand({
			id: '01900000-0000-7000-8000-0000000000aa',
			idempotencyKey: 'idemp-race-a'
		});
		const cmdB = createCommand({
			id: '01900000-0000-7000-8000-0000000000bb',
			idempotencyKey: 'idemp-race-b'
		});

		const [resA, resB] = await Promise.all([
			store.createEndpoint(cmdA),
			store.createEndpoint(cmdB)
		]);
		const outcomes = [resA.outcome, resB.outcome].sort();
		expect(outcomes).toEqual(['created', 'limit_exceeded']);

		// Final active endpoint count must be exactly 20, never 21
		const countAfter = sqlite
			.prepare(
				'SELECT COUNT(*) AS n FROM webhook_endpoint WHERE organization_id = ? AND status = ?'
			)
			.get(ORGANIZATION_ID, 'active') as { n: number };
		expect(countAfter.n).toBe(20);
	});
});
