import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type {
	ClaimWebhookDeliveriesCommand,
	CreateWebhookEndpointCommand,
	CreateWebhookEndpointResult,
	FailWebhookDeliveryCommand,
	RevokeWebhookEndpointCommand,
	RevokeWebhookEndpointResult,
	WebhookEndpointMetadata
} from '$lib/ports/webhook-store';
import {
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION
} from '$lib/security/webhook';
import { PostgresWebhookStore } from './postgres-webhook-store';

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}
type ScriptedResult = readonly object[] | Error;

class SqlFragment {
	constructor(readonly text: string) {}
}

class ScriptedPostgres {
	readonly directQueries: RecordedQuery[] = [];
	beginCalls: number = 0;
	rollbacks: number = 0;
	readonly #results: ScriptedResult[];

	constructor(results: readonly ScriptedResult[]) {
		this.#results = results.map((result) => (result instanceof Error ? result : [...result]));
	}

	client(): ReturnType<typeof postgres> {
		const client: ReturnType<typeof postgres> = this.#tag(this.directQueries);
		Object.assign(client, {
			begin: async <T>(
				callback: (transaction: ReturnType<typeof postgres>) => Promise<T>
			): Promise<T> => {
				this.beginCalls += 1;
				try {
					return await callback(this.#tag(this.directQueries));
				} catch (error: unknown) {
					this.rollbacks += 1;
					throw error;
				}
			}
		});
		return client;
	}

	texts(): readonly string[] {
		return this.directQueries.map((query: RecordedQuery): string => query.text);
	}

	#tag(target: RecordedQuery[]): ReturnType<typeof postgres> {
		const query = async (
			strings: TemplateStringsArray,
			...values: readonly unknown[]
		): Promise<readonly object[]> => {
			let text: string = '';
			const bound: unknown[] = [];
			strings.forEach((chunk: string, index: number): void => {
				text += chunk;
				if (index >= values.length) return;
				const value: unknown = values[index];
				if (value instanceof SqlFragment) {
					text += value.text;
					return;
				}
				text += '?';
				bound.push(value);
			});
			target.push({ text: text.replaceAll(/\s+/g, ' ').trim(), values: bound });
			const result: ScriptedResult | undefined = this.#results.shift();
			if (result === undefined) throw new Error('Unexpected PostgreSQL query');
			if (result instanceof Error) throw result;
			return result;
		};
		Object.assign(query, {
			unsafe: (text: string): SqlFragment => new SqlFragment(text)
		});
		return query as unknown as ReturnType<typeof postgres>;
	}
}

const claimCommand: ClaimWebhookDeliveriesCommand = {
	claimToken: 'claim-token-0001',
	claimedAt: '2026-09-13T00:10:00.000Z',
	staleBefore: '2026-09-13T00:05:00.000Z',
	limit: 5
};

const failCommand: FailWebhookDeliveryCommand = {
	organizationId: 'org-1',
	endpointId: '01900000-0000-7000-8000-000000000401',
	auditEventId: '01900000-0000-7000-8000-000000000501',
	claimToken: 'claim-token-0001',
	failedAt: '2026-09-13T00:10:00.000Z',
	retryable: true,
	nextAvailableAt: '2026-09-13T00:10:30.000Z',
	errorCode: 'http_500',
	httpStatus: 500
};

describe('PostgresWebhookStore.claimPendingDeliveries', () => {
	it('requires retryable due work and bounds stale processing by the shared attempt ceiling', async () => {
		const scripted = new ScriptedPostgres([[]]);
		const store = new PostgresWebhookStore(scripted.client());
		await expect(store.claimPendingDeliveries(claimCommand)).resolves.toEqual([]);
		expect(scripted.directQueries).toHaveLength(1);
		const query = scripted.directQueries[0];
		expect(query.text).toContain("status IN ('pending', 'failed')");
		expect(query.text).toContain('AND retryable');
		expect(query.text).toContain("status = 'processing'");
		expect(query.text).toContain('locked_at < ?::timestamptz');
		expect(query.text).toContain('AND attempts < ?');
		expect(query.text).toContain('FOR UPDATE SKIP LOCKED');
		expect(query.values).toEqual([
			claimCommand.claimedAt,
			claimCommand.staleBefore,
			WEBHOOK_MAX_ATTEMPTS,
			claimCommand.limit,
			claimCommand.claimToken,
			claimCommand.claimedAt,
			claimCommand.claimedAt
		]);
	});
});

describe('PostgresWebhookStore.failDelivery', () => {
	it('persists retryable failures so bounded reclaim remains possible', async () => {
		const scripted = new ScriptedPostgres([[{ auditEventId: failCommand.auditEventId }], []]);
		const store = new PostgresWebhookStore(scripted.client());
		await expect(store.failDelivery(failCommand)).resolves.toEqual({ outcome: 'failed' });
		expect(scripted.directQueries[0]?.text).toContain("status = 'failed'");
		expect(scripted.directQueries[0]?.text).toContain('retryable = ?');
		expect(scripted.directQueries[0]?.values).toEqual([
			failCommand.nextAvailableAt,
			failCommand.errorCode,
			failCommand.failedAt,
			true,
			failCommand.organizationId,
			failCommand.endpointId,
			failCommand.auditEventId,
			failCommand.claimToken
		]);
		expect(scripted.directQueries[1]?.values).toContain('retrying');
	});

	it('persists HTTP 4xx, SSRF, and payload-too-large as non-retryable terminal failures', async () => {
		for (const errorCode of ['http_400', 'ssrf_rejected', 'payload_too_large'] as const) {
			const scripted = new ScriptedPostgres([[{ auditEventId: failCommand.auditEventId }], []]);
			const store = new PostgresWebhookStore(scripted.client());
			const command: FailWebhookDeliveryCommand = {
				...failCommand,
				retryable: false,
				errorCode,
				httpStatus: errorCode === 'http_400' ? 400 : null
			};
			await expect(store.failDelivery(command)).resolves.toEqual({ outcome: 'failed' });
			expect(scripted.directQueries[0]?.text).toContain('retryable = ?');
			expect(scripted.directQueries[0]?.values[3]).toBe(false);
			expect(scripted.directQueries[1]?.values).toContain('failed');
			expect(scripted.directQueries[1]?.values).toContain(errorCode);
		}
	});
});

const ORGANIZATION_ID: string = 'org-1';
const ACTOR_ID: string = 'user-1';
const ENDPOINT_ID: string = '01900000-0000-7000-8000-000000000701';
const CREATED_AT: string = '2026-09-13T00:00:00.000Z';
const REQUEST_HASH: string = 'f'.repeat(64);
const OTHER_REQUEST_HASH: string = 'e'.repeat(64);

function createCommand(
	overrides: Partial<CreateWebhookEndpointCommand> = {}
): CreateWebhookEndpointCommand {
	return {
		id: ENDPOINT_ID,
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
		createdAt: CREATED_AT,
		...overrides
	};
}

function revokeCommand(
	overrides: Partial<RevokeWebhookEndpointCommand> = {}
): RevokeWebhookEndpointCommand {
	return {
		organizationId: ORGANIZATION_ID,
		webhookId: ENDPOINT_ID,
		actorId: ACTOR_ID,
		idempotencyKey: 'idemp-revoke-001',
		requestFingerprint: REQUEST_HASH,
		revokedAt: CREATED_AT,
		...overrides
	};
}

function endpointRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: ENDPOINT_ID,
		organizationId: ORGANIZATION_ID,
		url: 'https://hooks.example.com/target',
		description: 'Webhook Endpoint',
		status: 'active',
		eventsJson: '["envelope.completed"]',
		secretPrefix: 'skwh1_abcd',
		createdAt: CREATED_AT,
		createdByUserId: ACTOR_ID,
		revokedAt: null,
		revokedByUserId: null,
		...overrides
	};
}

const EXPECTED_ENDPOINT: WebhookEndpointMetadata = {
	id: ENDPOINT_ID,
	organizationId: ORGANIZATION_ID,
	url: 'https://hooks.example.com/target',
	description: 'Webhook Endpoint',
	status: 'active',
	events: ['envelope.completed'],
	secretPrefix: 'skwh1_abcd',
	createdAt: CREATED_AT,
	createdByUserId: ACTOR_ID,
	revokedAt: null,
	revokedByUserId: null
};

describe('PostgresWebhookStore.createEndpoint', () => {
	it('locks the organization row before counting and inserts with ON CONFLICT absorption', async () => {
		const command: CreateWebhookEndpointCommand = createCommand();
		const scripted = new ScriptedPostgres([
			[{ id: ORGANIZATION_ID }],
			[],
			[{ n: '0' }],
			[{ id: command.id }],
			[{ webhookId: command.id }],
			[endpointRow()]
		]);
		const result: CreateWebhookEndpointResult = await new PostgresWebhookStore(
			scripted.client()
		).createEndpoint(command);

		expect(result).toEqual({ outcome: 'created', endpoint: EXPECTED_ENDPOINT });
		expect(scripted.beginCalls).toBe(1);
		expect(scripted.rollbacks).toBe(0);
		expect(scripted.texts()[0]).toContain('FROM organization WHERE id = ? FOR NO KEY UPDATE');
		expect(scripted.texts()[1]).toContain('FROM webhook_endpoint_command');
		expect(scripted.texts()[1]).toContain('FOR UPDATE');
		expect(scripted.texts()[2]).toContain("status = 'active'");
		expect(scripted.texts()[3]).toContain('INSERT INTO webhook_endpoint');
		expect(scripted.texts()[3]).toContain('ON CONFLICT DO NOTHING');
		expect(scripted.texts()[4]).toContain('INSERT INTO webhook_endpoint_command');
		expect(scripted.texts()[4]).toContain('ON CONFLICT DO NOTHING');
	});

	it('classifies a concurrent command-row collision as replay when the fingerprint matches', async () => {
		const command: CreateWebhookEndpointCommand = createCommand();
		const scripted = new ScriptedPostgres([
			[{ id: ORGANIZATION_ID }],
			[],
			[{ n: '0' }],
			[{ id: command.id }],
			[],
			[{ requestHash: REQUEST_HASH, webhookId: command.id }],
			[endpointRow()]
		]);
		const result: CreateWebhookEndpointResult = await new PostgresWebhookStore(
			scripted.client()
		).createEndpoint(command);

		expect(result).toEqual({ outcome: 'replayed', endpoint: EXPECTED_ENDPOINT });
		expect(scripted.rollbacks).toBe(1);
		expect(scripted.texts()[5]).toContain('FROM webhook_endpoint_command');
	});

	it('classifies a concurrent command-row collision as conflict when the fingerprint differs', async () => {
		const command: CreateWebhookEndpointCommand = createCommand();
		const scripted = new ScriptedPostgres([
			[{ id: ORGANIZATION_ID }],
			[],
			[{ n: '0' }],
			[{ id: command.id }],
			[],
			[{ requestHash: OTHER_REQUEST_HASH, webhookId: command.id }]
		]);
		const result: CreateWebhookEndpointResult = await new PostgresWebhookStore(
			scripted.client()
		).createEndpoint(command);

		expect(result).toEqual({ outcome: 'conflict' });
		expect(scripted.rollbacks).toBe(1);
	});

	it('rejects creation when the active count is already at the organization cap', async () => {
		const scripted = new ScriptedPostgres([
			[{ id: ORGANIZATION_ID }],
			[],
			[{ n: String(WEBHOOK_MAX_ENDPOINTS_PER_ORGANIZATION) }]
		]);
		const result: CreateWebhookEndpointResult = await new PostgresWebhookStore(
			scripted.client()
		).createEndpoint(createCommand());

		expect(result).toEqual({ outcome: 'limit_exceeded' });
		expect(scripted.rollbacks).toBe(1);
		expect(scripted.texts()[0]).toContain('FOR NO KEY UPDATE');
		expect(scripted.texts()[2]).toContain('COUNT(*)');
	});
});

describe('PostgresWebhookStore.revokeEndpoint', () => {
	it('absorbs a concurrent command insert and classifies matching fingerprints as replay', async () => {
		const command: RevokeWebhookEndpointCommand = revokeCommand();
		const scripted = new ScriptedPostgres([
			[],
			[{ id: command.webhookId }],
			[],
			[{ requestHash: REQUEST_HASH, webhookId: command.webhookId }],
			[
				endpointRow({
					status: 'revoked',
					revokedAt: CREATED_AT,
					revokedByUserId: ACTOR_ID
				})
			]
		]);
		const result: RevokeWebhookEndpointResult = await new PostgresWebhookStore(
			scripted.client()
		).revokeEndpoint(command);

		expect(result).toEqual({
			outcome: 'replayed',
			endpoint: {
				...EXPECTED_ENDPOINT,
				status: 'revoked',
				revokedAt: CREATED_AT,
				revokedByUserId: ACTOR_ID
			}
		});
		expect(scripted.rollbacks).toBe(1);
		expect(scripted.texts()[2]).toContain('INSERT INTO webhook_endpoint_command');
		expect(scripted.texts()[2]).toContain('ON CONFLICT DO NOTHING');
	});

	it('absorbs a concurrent command insert and classifies mismatched fingerprints as conflict', async () => {
		const command: RevokeWebhookEndpointCommand = revokeCommand();
		const scripted = new ScriptedPostgres([
			[],
			[{ id: command.webhookId }],
			[],
			[{ requestHash: OTHER_REQUEST_HASH, webhookId: command.webhookId }]
		]);
		const result: RevokeWebhookEndpointResult = await new PostgresWebhookStore(
			scripted.client()
		).revokeEndpoint(command);

		expect(result).toEqual({ outcome: 'conflict' });
		expect(scripted.rollbacks).toBe(1);
	});
});
