import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type {
	ClaimWebhookDeliveriesCommand,
	FailWebhookDeliveryCommand
} from '$lib/ports/webhook-store';
import { WEBHOOK_MAX_ATTEMPTS } from '$lib/security/webhook';
import { PostgresWebhookStore } from './postgres-webhook-store';

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}
type ScriptedResult = readonly object[] | Error;

class ScriptedPostgres {
	readonly directQueries: RecordedQuery[] = [];
	readonly #results: ScriptedResult[];

	constructor(results: readonly ScriptedResult[]) {
		this.#results = results.map((result) => (result instanceof Error ? result : [...result]));
	}

	client(): ReturnType<typeof postgres> {
		return this.#tag(this.directQueries) as ReturnType<typeof postgres>;
	}

	#tag(target: RecordedQuery[]): ReturnType<typeof postgres> {
		const query = async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
			target.push({ text: strings.join('?').replaceAll(/\s+/g, ' ').trim(), values });
			const result = this.#results.shift();
			if (result === undefined) throw new Error('Unexpected PostgreSQL query');
			if (result instanceof Error) throw result;
			return result;
		};
		return query as ReturnType<typeof postgres>;
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
