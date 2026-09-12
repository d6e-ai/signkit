import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type {
	ClaimCompletionDeliveriesCommand,
	CompleteCompletionDeliveryCommand,
	EnrollCompletionDeliveryItem,
	FailCompletionDeliveryCommand
} from '$lib/ports/completion-delivery-store';
import { PostgresCompletionDeliveryStore } from './postgres-completion-delivery-store';

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}
type ScriptedResult = readonly object[] | Error;

class ScriptedPostgres {
	readonly directQueries: RecordedQuery[] = [];
	readonly transactionQueries: RecordedQuery[] = [];
	beginCalls: number = 0;
	readonly #results: ScriptedResult[];

	constructor(results: readonly ScriptedResult[]) {
		this.#results = results.map((result) => (result instanceof Error ? result : [...result]));
	}

	client(): ReturnType<typeof postgres> {
		const direct = this.#tag(this.directQueries);
		Object.assign(direct, {
			begin: async <T>(
				callback: (transaction: ReturnType<typeof postgres>) => Promise<T>
			): Promise<T> => {
				this.beginCalls += 1;
				return callback(this.#tag(this.transactionQueries));
			}
		});
		return direct as ReturnType<typeof postgres>;
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

const claimCommand: ClaimCompletionDeliveriesCommand = {
	claimToken: 'claim-token-0001',
	claimedAt: '2026-09-12T00:00:00.000Z',
	staleBefore: '2026-09-11T23:55:00.000Z',
	limit: 5
};

function candidateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		deliveryId: 'delivery-1',
		organizationId: 'org-1',
		envelopeId: 'env-1',
		recipientId: 'recipient-1',
		tokenHash: 'token-hash-1',
		accessExpiresAt: new Date('2026-10-12T00:00:00.000Z'),
		accessRevokedAt: null,
		sealedToken: 'skcd1_sealed_token_ciphertext',
		sealingKeyId: 'key-1',
		sealedTokenSha256: 'sealed-sha-1',
		availableAt: new Date('2026-09-11T00:01:00.000Z'),
		attempts: 0,
		lockedAt: null,
		recipientEmail: 'recipient@example.com',
		recipientName: 'Recipient One',
		recipientLocale: 'en',
		recipientRole: 'signer',
		envelopeTitle: 'Agreement',
		envelopeStatus: 'completed',
		...overrides
	};
}

describe('PostgresCompletionDeliveryStore.discoverEligibleRecipients', () => {
	it('queries completed envelopes with published completion artifacts and bounds by limit', async () => {
		const discoverRows = [
			{
				organizationId: 'org-1',
				envelopeId: 'env-1',
				recipientId: 'rec-1',
				recipientEmail: 'signer@example.com',
				recipientName: 'Signer',
				recipientLocale: 'en',
				recipientRole: 'signer',
				envelopeTitle: 'Completed Agreement'
			}
		];
		const scripted = new ScriptedPostgres([discoverRows]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const discovered = await store.discoverEligibleRecipients(10);

		expect(discovered).toEqual([
			{
				organizationId: 'org-1',
				envelopeId: 'env-1',
				recipientId: 'rec-1',
				recipientEmail: 'signer@example.com',
				recipientName: 'Signer',
				recipientLocale: 'en',
				recipientRole: 'signer',
				envelopeTitle: 'Completed Agreement'
			}
		]);
		expect(scripted.directQueries).toHaveLength(1);
		const query = scripted.directQueries[0];
		expect(query.text).toContain("envelope.status = 'completed'");
		expect(query.text).toContain('INNER JOIN completion_artifact artifact');
		expect(query.text).toContain("recipient.role IN ('signer', 'approver', 'viewer', 'cc')");
		expect(query.text).toContain('NOT EXISTS ( SELECT 1 FROM completion_delivery_outbox outbox');
		expect(query.text).toContain(
			'ORDER BY envelope.updated_at ASC, recipient.routing_order ASC, recipient.id ASC'
		);
		expect(query.values).toEqual([10]);
	});
});

describe('PostgresCompletionDeliveryStore.enrollDeliveries', () => {
	it('returns 0 without database calls when items is empty', async () => {
		const scripted = new ScriptedPostgres([]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const enrolled = await store.enrollDeliveries([]);
		expect(enrolled).toBe(0);
		expect(scripted.beginCalls).toBe(0);
	});

	it('inserts deliveries in a transaction with ON CONFLICT DO NOTHING and counts successful insertions', async () => {
		const scripted = new ScriptedPostgres([
			[{ id: 'del-1' }],
			[] // second conflicted
		]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const items: EnrollCompletionDeliveryItem[] = [
			{
				id: 'del-1',
				organizationId: 'org-1',
				envelopeId: 'env-1',
				recipientId: 'rec-1',
				tokenHash: 'hash-1',
				accessExpiresAt: '2026-10-12T00:00:00.000Z',
				sealedToken: 'skcd1_sealed_1',
				sealingKeyId: 'key-1',
				sealedTokenSha256: 'sha-1',
				availableAt: '2026-09-12T00:00:00.000Z',
				createdAt: '2026-09-12T00:00:00.000Z'
			},
			{
				id: 'del-2',
				organizationId: 'org-1',
				envelopeId: 'env-1',
				recipientId: 'rec-2',
				tokenHash: 'hash-2',
				accessExpiresAt: '2026-10-12T00:00:00.000Z',
				sealedToken: 'skcd1_sealed_2',
				sealingKeyId: 'key-1',
				sealedTokenSha256: 'sha-2',
				availableAt: '2026-09-12T00:00:00.000Z',
				createdAt: '2026-09-12T00:00:00.000Z'
			}
		];
		const count = await store.enrollDeliveries(items);
		expect(count).toBe(1);
		expect(scripted.beginCalls).toBe(1);
		expect(scripted.transactionQueries).toHaveLength(2);
		expect(scripted.transactionQueries[0].text).toContain(
			'ON CONFLICT (organization_id, envelope_id, recipient_id) DO NOTHING'
		);
		expect(scripted.transactionQueries[0].text).toContain("'pending'");
		expect(scripted.transactionQueries[0].text).toContain('true');
	});
});

describe('PostgresCompletionDeliveryStore.claimPendingDeliveries', () => {
	it('runs terminal cleanup and claims eligible candidates with SKIP LOCKED', async () => {
		const rows = [candidateRow()];
		const scripted = new ScriptedPostgres([
			[], // terminal cleanup
			rows, // candidate select
			[{ id: 'delivery-1' }] // update CAS
		]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const claimed = await store.claimPendingDeliveries(claimCommand);

		expect(scripted.beginCalls).toBe(1);
		expect(scripted.transactionQueries).toHaveLength(3);

		// Terminal cleanup query assertions
		const cleanupQuery = scripted.transactionQueries[0];
		expect(cleanupQuery.text).toContain("last_error = 'delivery_not_eligible'");
		expect(cleanupQuery.text).toContain('sealed_token = NULL');
		expect(cleanupQuery.text).toContain('retryable = false');
		expect(cleanupQuery.text).toContain('access_revoked_at = COALESCE(delivery.access_revoked_at,');
		expect(cleanupQuery.text).toContain('FOR UPDATE OF delivery SKIP LOCKED');
		expect(cleanupQuery.values).toEqual([
			claimCommand.staleBefore,
			claimCommand.claimedAt,
			100,
			claimCommand.claimedAt,
			claimCommand.claimedAt,
			claimCommand.claimedAt
		]);

		// Candidate selection assertions
		const selectQuery = scripted.transactionQueries[1];
		expect(selectQuery.text).toContain('FOR UPDATE OF delivery SKIP LOCKED');
		expect(selectQuery.text).toContain("envelope.status = 'completed'");
		expect(selectQuery.text).toContain('INNER JOIN completion_artifact artifact');
		expect(selectQuery.text).toContain("recipient.role IN ('signer', 'approver', 'viewer', 'cc')");
		expect(selectQuery.text).toContain('delivery.access_revoked_at IS NULL');
		expect(selectQuery.text).toContain('delivery.access_expires_at > ?::timestamptz');
		expect(selectQuery.text).toContain('delivery.sealed_token IS NOT NULL');
		expect(selectQuery.text).toContain('delivery.locked_at < ?::timestamptz');
		expect(selectQuery.values).toEqual([
			claimCommand.claimedAt,
			claimCommand.staleBefore,
			claimCommand.claimedAt,
			claimCommand.limit
		]);

		// Guarded update assertions
		const updateQuery = scripted.transactionQueries[2];
		expect(updateQuery.text).toContain("status = 'processing'");
		expect(updateQuery.text).toContain('attempts = attempts + 1');
		expect(updateQuery.values).toEqual([
			claimCommand.claimToken,
			claimCommand.claimedAt,
			claimCommand.claimedAt,
			'org-1',
			'delivery-1',
			claimCommand.claimedAt,
			claimCommand.staleBefore
		]);

		expect(claimed).toEqual([
			{
				deliveryId: 'delivery-1',
				organizationId: 'org-1',
				envelopeId: 'env-1',
				recipientId: 'recipient-1',
				status: 'processing',
				tokenHash: 'token-hash-1',
				accessExpiresAt: '2026-10-12T00:00:00.000Z',
				accessRevokedAt: null,
				sealedToken: 'skcd1_sealed_token_ciphertext',
				sealingKeyId: 'key-1',
				sealedTokenSha256: 'sealed-sha-1',
				availableAt: '2026-09-11T00:01:00.000Z',
				attempts: 1,
				lockedAt: claimCommand.claimedAt,
				recipientEmail: 'recipient@example.com',
				recipientName: 'Recipient One',
				recipientLocale: 'en',
				recipientRole: 'signer',
				envelopeTitle: 'Agreement',
				envelopeStatus: 'completed'
			}
		]);
	});

	it('returns empty array when no candidates are eligible', async () => {
		const scripted = new ScriptedPostgres([[], []]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const claimed = await store.claimPendingDeliveries(claimCommand);
		expect(claimed).toEqual([]);
		expect(scripted.transactionQueries).toHaveLength(2);
	});

	it('drops candidate when guarded CAS update misses', async () => {
		const rows = [candidateRow()];
		const scripted = new ScriptedPostgres([[], rows, []]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const claimed = await store.claimPendingDeliveries(claimCommand);
		expect(claimed).toEqual([]);
	});
});

describe('PostgresCompletionDeliveryStore.readClaimedDelivery', () => {
	it('reads claimed delivery scoped to organization, id, status, and claimToken', async () => {
		const scripted = new ScriptedPostgres([
			[candidateRow({ attempts: 3, lockedAt: new Date(claimCommand.claimedAt) })]
		]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const delivery = await store.readClaimedDelivery({
			organizationId: 'org-1',
			deliveryId: 'delivery-1',
			claimToken: claimCommand.claimToken
		});

		expect(delivery).toMatchObject({
			deliveryId: 'delivery-1',
			attempts: 3,
			lockedAt: claimCommand.claimedAt
		});
		expect(scripted.directQueries).toHaveLength(1);
		const query = scripted.directQueries[0];
		expect(query.text).toContain("delivery.status = 'processing'");
		expect(query.text).toContain('delivery.claim_token = ?');
		expect(query.values).toEqual(['org-1', 'delivery-1', claimCommand.claimToken]);
	});

	it('returns null when delivery does not exist or claim token is invalid', async () => {
		const scripted = new ScriptedPostgres([[]]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const delivery = await store.readClaimedDelivery({
			organizationId: 'org-1',
			deliveryId: 'delivery-1',
			claimToken: 'stale-token'
		});
		expect(delivery).toBeNull();
	});
});

describe('PostgresCompletionDeliveryStore.completeDelivery', () => {
	const completeCommand: CompleteCompletionDeliveryCommand = {
		organizationId: 'org-1',
		deliveryId: 'delivery-1',
		claimToken: 'claim-token-0001',
		deliveredAt: '2026-09-12T00:01:00.000Z',
		providerMessageId: 'provider-msg-001'
	};

	it('marks delivery delivered, scrubs sealed_token, clears claim lease, and sets non-retryable', async () => {
		const scripted = new ScriptedPostgres([[{ id: 'delivery-1' }]]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const result = await store.completeDelivery(completeCommand);

		expect(result).toEqual({ outcome: 'completed' });
		expect(scripted.directQueries).toHaveLength(1);
		const query = scripted.directQueries[0];
		expect(query.text).toContain("status = 'delivered'");
		expect(query.text).toContain('sealed_token = NULL');
		expect(query.text).toContain('retryable = false');
		expect(query.text).toContain('claim_token = NULL, locked_at = NULL');
		expect(query.text).toContain("AND status = 'processing' AND claim_token = ?");
		expect(query.values).toEqual([
			completeCommand.deliveredAt,
			completeCommand.providerMessageId,
			completeCommand.deliveredAt,
			completeCommand.organizationId,
			completeCommand.deliveryId,
			completeCommand.claimToken
		]);
	});

	it('returns stale outcome when CAS update matches 0 rows', async () => {
		const scripted = new ScriptedPostgres([[]]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const result = await store.completeDelivery(completeCommand);
		expect(result).toEqual({ outcome: 'stale' });
	});
});

describe('PostgresCompletionDeliveryStore.failDelivery', () => {
	const baseFailCommand: FailCompletionDeliveryCommand = {
		organizationId: 'org-1',
		deliveryId: 'delivery-1',
		claimToken: 'claim-token-0001',
		errorCode: 'smtp_temporary_failure',
		retryable: true,
		nextAvailableAt: '2026-09-12T00:05:00.000Z',
		failedAt: '2026-09-12T00:01:00.000Z'
	};

	it('retains sealed_token and marks retryable on retryable failure', async () => {
		const scripted = new ScriptedPostgres([[{ id: 'delivery-1' }]]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const result = await store.failDelivery(baseFailCommand);

		expect(result).toEqual({ outcome: 'failed' });
		expect(scripted.directQueries).toHaveLength(1);
		const query = scripted.directQueries[0];
		expect(query.text).toContain("status = 'failed'");
		expect(query.text).toContain('retryable = true');
		expect(query.text).not.toContain('sealed_token = NULL');
		expect(query.values).toEqual([
			baseFailCommand.nextAvailableAt,
			baseFailCommand.errorCode,
			baseFailCommand.failedAt,
			baseFailCommand.organizationId,
			baseFailCommand.deliveryId,
			baseFailCommand.claimToken
		]);
	});

	it('scrubs sealed_token and marks non-retryable on permanent failure', async () => {
		const scripted = new ScriptedPostgres([[{ id: 'delivery-1' }]]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const result = await store.failDelivery({ ...baseFailCommand, retryable: false });

		expect(result).toEqual({ outcome: 'failed' });
		expect(scripted.directQueries).toHaveLength(1);
		const query = scripted.directQueries[0];
		expect(query.text).toContain("status = 'failed'");
		expect(query.text).toContain('retryable = false');
		expect(query.text).toContain('sealed_token = NULL');
		expect(query.text).toContain('access_revoked_at = COALESCE(access_revoked_at,');
		expect(query.values).toEqual([
			baseFailCommand.failedAt,
			baseFailCommand.nextAvailableAt,
			baseFailCommand.errorCode,
			baseFailCommand.failedAt,
			baseFailCommand.organizationId,
			baseFailCommand.deliveryId,
			baseFailCommand.claimToken
		]);
	});

	it('returns stale outcome when CAS update misses', async () => {
		const scripted = new ScriptedPostgres([[]]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		expect(await store.failDelivery(baseFailCommand)).toEqual({ outcome: 'stale' });
	});
});

describe('PostgresCompletionDeliveryStore.resolveArtifactLocatorByTokenHash', () => {
	it('resolves artifact locator for valid unrevoked and unexpired delivery grant with completed envelope', async () => {
		const row = {
			organizationId: 'org-1',
			envelopeId: 'env-1',
			jsonObjectKey: 'completion-artifacts/v1/org-1/env-1/artifact.json.gz',
			jsonSha256: 'j'.repeat(64),
			markdownObjectKey: 'completion-artifacts/v1/org-1/env-1/artifact.md.gz',
			markdownSha256: 'd'.repeat(64)
		};
		const scripted = new ScriptedPostgres([[row]]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const locator = await store.resolveArtifactLocatorByTokenHash(
			'token-hash-1',
			'2026-09-12T00:00:00.000Z'
		);

		expect(locator).toEqual({
			organizationId: 'org-1',
			envelopeId: 'env-1',
			jsonObjectKey: 'completion-artifacts/v1/org-1/env-1/artifact.json.gz',
			jsonSha256: 'j'.repeat(64),
			markdownObjectKey: 'completion-artifacts/v1/org-1/env-1/artifact.md.gz',
			markdownSha256: 'd'.repeat(64)
		});
		expect(scripted.directQueries).toHaveLength(1);
		const query = scripted.directQueries[0];
		expect(query.text).toContain('delivery.token_hash = ?');
		expect(query.text).toContain('delivery.access_revoked_at IS NULL');
		expect(query.text).toContain('delivery.access_expires_at > ?::timestamptz');
		expect(query.text).toContain("envelope.status = 'completed'");
		expect(query.text).toContain('INNER JOIN envelope');
		expect(query.text).toContain('INNER JOIN completion_artifact artifact');
		expect(query.text).toContain('artifact.organization_id = delivery.organization_id');
		expect(query.text).toContain('artifact.envelope_id = delivery.envelope_id');
		expect(query.text).toContain('LIMIT 1');
		expect(query.values).toEqual(['token-hash-1', '2026-09-12T00:00:00.000Z']);
	});

	it('returns null when delivery grant does not match (nonexistent, revoked, expired, or uncompleted envelope)', async () => {
		const scripted = new ScriptedPostgres([[]]);
		const store = new PostgresCompletionDeliveryStore(scripted.client());
		const locator = await store.resolveArtifactLocatorByTokenHash(
			'unknown-token-hash',
			'2026-09-12T00:00:00.000Z'
		);

		expect(locator).toBeNull();
		expect(scripted.directQueries).toHaveLength(1);
		expect(scripted.directQueries[0].values).toEqual([
			'unknown-token-hash',
			'2026-09-12T00:00:00.000Z'
		]);
	});
});
