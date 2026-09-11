import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type {
	ClaimInvitationDeliveriesCommand,
	CompleteInvitationDeliveryCommand,
	FailInvitationDeliveryCommand
} from '$lib/ports/delivery-outbox-store';
import { PostgresDeliveryOutboxStore } from './postgres-delivery-outbox-store';

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

const claimCommand: ClaimInvitationDeliveriesCommand = {
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
		capabilityHash: 'capability-hash-1',
		reservedCapabilityExpiresAt: new Date('2026-09-25T00:00:00.000Z'),
		sealedCapability: 'skdc1_ciphertext',
		sealingKeyId: 'key-1',
		sealedCapabilitySha256: 'sealed-sha-1',
		availableAt: new Date('2026-09-11T00:01:00.000Z'),
		attempts: 0,
		lockedAt: null,
		recipientEmail: 'recipient@example.com',
		recipientName: 'Recipient One',
		recipientLocale: 'en',
		recipientStatus: 'pending',
		recipientCapabilityExpiresAt: new Date('2026-09-25T00:00:00.000Z'),
		recipientCapabilityRevokedAt: null,
		envelopeTitle: 'Agreement',
		envelopeStatus: 'sent',
		...overrides
	};
}

describe('PostgresDeliveryOutboxStore.claimPendingInvitations', () => {
	it('opens a transaction, locks candidates with FOR UPDATE SKIP LOCKED, and returns nothing when none are eligible', async () => {
		const scripted = new ScriptedPostgres([[], []]);
		const store = new PostgresDeliveryOutboxStore(scripted.client());
		const claimed = await store.claimPendingInvitations(claimCommand);
		expect(claimed).toEqual([]);
		expect(scripted.beginCalls).toBe(1);
		expect(scripted.transactionQueries).toHaveLength(2);
		expect(scripted.transactionQueries[0].text).toContain("last_error = 'delivery_not_eligible'");
		expect(scripted.transactionQueries[0].text).toContain('sealed_capability = NULL');
		expect(scripted.transactionQueries[1].text).toContain('FOR UPDATE OF delivery SKIP LOCKED');
		expect(scripted.transactionQueries[1].text).toContain("delivery.kind = 'recipient_invitation'");
		expect(scripted.transactionQueries[1].values).toEqual([
			claimCommand.claimedAt,
			claimCommand.staleBefore,
			claimCommand.claimedAt,
			claimCommand.limit
		]);
		expect(scripted.transactionQueries[1].text).toContain(
			'recipient.capability_expires_at > ?::timestamptz'
		);
		expect(scripted.transactionQueries[1].text).toContain("recipient.role <> 'cc'");
	});

	it('claims every row whose guarded update returns a row and converts timestamps to ISO strings', async () => {
		const rows = [
			candidateRow(),
			candidateRow({ deliveryId: 'delivery-2', recipientId: 'recipient-2' })
		];
		const scripted = new ScriptedPostgres([
			[],
			rows,
			[{ id: 'delivery-1' }],
			[{ id: 'delivery-2' }]
		]);
		const store = new PostgresDeliveryOutboxStore(scripted.client());
		const claimed = await store.claimPendingInvitations(claimCommand);

		expect(scripted.transactionQueries).toHaveLength(4);
		expect(scripted.transactionQueries[2].text).toContain("SET status = 'processing'");
		expect(scripted.transactionQueries[2].text).toContain('attempts = attempts + 1');
		expect(scripted.transactionQueries[2].values).toEqual([
			claimCommand.claimToken,
			claimCommand.claimedAt,
			claimCommand.claimedAt,
			'org-1',
			'delivery-1',
			claimCommand.claimedAt,
			claimCommand.staleBefore
		]);

		expect(claimed).toHaveLength(2);
		expect(claimed[0]).toEqual({
			deliveryId: 'delivery-1',
			organizationId: 'org-1',
			envelopeId: 'env-1',
			recipientId: 'recipient-1',
			kind: 'recipient_invitation',
			status: 'processing',
			recipientEmail: 'recipient@example.com',
			recipientName: 'Recipient One',
			recipientLocale: 'en',
			recipientStatus: 'pending',
			envelopeTitle: 'Agreement',
			envelopeStatus: 'sent',
			capabilityHash: 'capability-hash-1',
			capabilityExpiresAt: '2026-09-25T00:00:00.000Z',
			reservedCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
			capabilityRevokedAt: null,
			sealedCapability: 'skdc1_ciphertext',
			sealedCapabilitySha256: 'sealed-sha-1',
			sealingKeyId: 'key-1',
			availableAt: '2026-09-11T00:01:00.000Z',
			attempts: 1,
			lockedAt: claimCommand.claimedAt
		});
	});

	it('drops rows whose guarded update returns no row', async () => {
		const rows = [
			candidateRow(),
			candidateRow({ deliveryId: 'delivery-2', recipientId: 'recipient-2' })
		];
		const scripted = new ScriptedPostgres([[], rows, [{ id: 'delivery-1' }], []]);
		const store = new PostgresDeliveryOutboxStore(scripted.client());
		const claimed = await store.claimPendingInvitations(claimCommand);
		expect(claimed.map((claim) => claim.deliveryId)).toEqual(['delivery-1']);
	});

	it('handles string timestamps and non-zero prior attempts from the driver', async () => {
		const scripted = new ScriptedPostgres([
			[],
			[
				candidateRow({
					availableAt: '2026-09-11T00:01:00.000Z',
					reservedCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
					recipientCapabilityExpiresAt: '2026-09-25T00:00:00.000Z',
					attempts: '3'
				})
			],
			[{ id: 'delivery-1' }]
		]);
		const store = new PostgresDeliveryOutboxStore(scripted.client());
		const [claim] = await store.claimPendingInvitations(claimCommand);
		expect(claim.attempts).toBe(4);
		expect(claim.availableAt).toBe('2026-09-11T00:01:00.000Z');
		expect(claim.lockedAt).toBe(claimCommand.claimedAt);
	});
});

describe('PostgresDeliveryOutboxStore.readClaimedInvitation', () => {
	it('re-reads the current tenant-scoped claim without incrementing attempts', async () => {
		const scripted = new ScriptedPostgres([
			[
				candidateRow({
					attempts: 4,
					lockedAt: new Date(claimCommand.claimedAt)
				})
			]
		]);
		const result = await new PostgresDeliveryOutboxStore(scripted.client()).readClaimedInvitation({
			organizationId: 'org-1',
			deliveryId: 'delivery-1',
			claimToken: claimCommand.claimToken
		});

		expect(result).toMatchObject({ attempts: 4, lockedAt: claimCommand.claimedAt });
		expect(scripted.directQueries[0].values).toEqual([
			'org-1',
			'delivery-1',
			claimCommand.claimToken
		]);
		expect(scripted.directQueries[0].text).toContain("delivery.status = 'processing'");
	});

	it('returns null when the claim token is stale', async () => {
		await expect(
			new PostgresDeliveryOutboxStore(new ScriptedPostgres([[]]).client()).readClaimedInvitation({
				organizationId: 'org-1',
				deliveryId: 'delivery-1',
				claimToken: 'stale-claim-token'
			})
		).resolves.toBeNull();
	});
});

describe('PostgresDeliveryOutboxStore.completeInvitationDelivery', () => {
	const completeCommand: CompleteInvitationDeliveryCommand = {
		organizationId: 'org-1',
		deliveryId: 'delivery-1',
		claimToken: 'claim-token-0001',
		deliveredAt: '2026-09-12T00:01:00.000Z',
		providerMessageId: 'provider-message-1'
	};

	it('scrubs the sealed capability, clears the lease, and marks the delivery non-retryable', async () => {
		const scripted = new ScriptedPostgres([[{ id: 'delivery-1' }]]);
		const store = new PostgresDeliveryOutboxStore(scripted.client());
		const result = await store.completeInvitationDelivery(completeCommand);
		expect(result).toEqual({ outcome: 'completed' });
		expect(scripted.directQueries).toHaveLength(1);
		const query = scripted.directQueries[0];
		expect(query.text).toContain("status = 'delivered'");
		expect(query.text).toContain('sealed_capability = NULL');
		expect(query.text).toContain('last_error = NULL');
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

	it('reports a stale outcome when the organization, delivery, status, or claim no longer match', async () => {
		const scripted = new ScriptedPostgres([[]]);
		const store = new PostgresDeliveryOutboxStore(scripted.client());
		const result = await store.completeInvitationDelivery(completeCommand);
		expect(result).toEqual({ outcome: 'stale' });
	});
});

describe('PostgresDeliveryOutboxStore.failInvitationDelivery', () => {
	const baseFailCommand: FailInvitationDeliveryCommand = {
		organizationId: 'org-1',
		deliveryId: 'delivery-1',
		claimToken: 'claim-token-0001',
		errorCode: 'mail_delivery_failed',
		retryable: true,
		nextAvailableAt: '2026-09-12T00:05:00.000Z',
		failedAt: '2026-09-12T00:01:00.000Z'
	};

	it('retains the sealed capability and marks the delivery retryable on a retryable failure', async () => {
		const scripted = new ScriptedPostgres([[{ id: 'delivery-1' }]]);
		const store = new PostgresDeliveryOutboxStore(scripted.client());
		const result = await store.failInvitationDelivery(baseFailCommand);
		expect(result).toEqual({ outcome: 'failed' });
		const query = scripted.directQueries[0];
		expect(query.text).toContain("status = 'failed'");
		expect(query.text).toContain('retryable = true');
		expect(query.text).not.toContain('sealed_capability = NULL');
		expect(query.values).toEqual([
			baseFailCommand.nextAvailableAt,
			baseFailCommand.errorCode,
			baseFailCommand.failedAt,
			baseFailCommand.organizationId,
			baseFailCommand.deliveryId,
			baseFailCommand.claimToken
		]);
	});

	it('scrubs the sealed capability and marks the delivery non-retryable on a permanent failure', async () => {
		const scripted = new ScriptedPostgres([[{ id: 'delivery-1' }]]);
		const store = new PostgresDeliveryOutboxStore(scripted.client());
		const command: FailInvitationDeliveryCommand = { ...baseFailCommand, retryable: false };
		const result = await store.failInvitationDelivery(command);
		expect(result).toEqual({ outcome: 'failed' });
		const query = scripted.directQueries[0];
		expect(query.text).toContain("status = 'failed'");
		expect(query.text).toContain('retryable = false');
		expect(query.text).toContain('sealed_capability = NULL');
		expect(query.values).toEqual([
			command.nextAvailableAt,
			command.errorCode,
			command.failedAt,
			command.organizationId,
			command.deliveryId,
			command.claimToken
		]);
	});

	it('reports a stale outcome for both retryable and non-retryable failures when the claim CAS misses', async () => {
		const retryableScripted = new ScriptedPostgres([[]]);
		const retryableStore = new PostgresDeliveryOutboxStore(retryableScripted.client());
		expect(await retryableStore.failInvitationDelivery(baseFailCommand)).toEqual({
			outcome: 'stale'
		});

		const permanentScripted = new ScriptedPostgres([[]]);
		const permanentStore = new PostgresDeliveryOutboxStore(permanentScripted.client());
		expect(
			await permanentStore.failInvitationDelivery({ ...baseFailCommand, retryable: false })
		).toEqual({ outcome: 'stale' });
	});
});
