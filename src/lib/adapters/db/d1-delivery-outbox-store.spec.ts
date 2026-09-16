import { describe, expect, it, vi } from 'vitest';
import type {
	ClaimInvitationDeliveriesCommand,
	CompleteInvitationDeliveryCommand,
	FailInvitationDeliveryCommand
} from '$lib/ports/delivery-outbox-store';
import { D1DeliveryOutboxStore } from './d1-delivery-outbox-store';

interface RecordedStatement {
	sql: string;
	bindings: readonly unknown[];
	statement: D1PreparedStatement;
}

interface FakeD1Options {
	runMeta?: { changes: number };
	batchMeta?: readonly { changes: number }[];
	batchResults?: readonly unknown[][];
	firstResult?: unknown | null;
}

function fakeD1(options: FakeD1Options = {}) {
	const prepared: RecordedStatement[] = [];
	const batches: RecordedStatement[][] = [];
	const prepare = vi.fn((sql: string): D1PreparedStatement => {
		const record: RecordedStatement = { sql, bindings: [], statement: undefined as never };
		const statement = {
			bind: (...bindings: unknown[]): D1PreparedStatement => {
				record.bindings = bindings;
				return statement;
			},
			run: async (): Promise<{ meta: { changes: number } }> => ({
				meta: options.runMeta ?? { changes: 0 }
			}),
			first: async (): Promise<unknown | null> => options.firstResult ?? null
		} as unknown as D1PreparedStatement;
		record.statement = statement;
		prepared.push(record);
		return statement;
	});
	const batch = vi.fn(
		async (statements: D1PreparedStatement[]): Promise<{ meta: { changes: number } }[]> => {
			const records: RecordedStatement[] = statements.map((statement) =>
				prepared.find((item) => item.statement === statement)!
			);
			batches.push(records);
			const metas: readonly { changes: number }[] =
				options.batchMeta ?? statements.map(() => ({ changes: 0 }));
			return metas.map((meta, index: number) => ({
				meta,
				results: options.batchResults?.[index] ?? []
			}));
		}
	);
	return { database: { prepare, batch } as unknown as D1Database, prepared, batches };
}

function candidateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		delivery_id: 'delivery-1',
		envelope_id: 'env-1',
		recipient_id: 'recipient-1',
		capability_hash: 'capability-hash-1',
		reserved_capability_expires_at: '2026-09-25T00:00:00.000Z',
		sealed_capability: 'skdc1_ciphertext',
		sealing_key_id: 'key-1',
		sealed_capability_sha256: 'sealed-sha-1',
		available_at: '2026-09-11T00:01:00.000Z',
		attempts: 1,
		locked_at: claimCommand.claimedAt,
		recipient_email: 'recipient@example.com',
		recipient_name: 'Recipient One',
		recipient_locale: 'en',
		recipient_status: 'pending',
		recipient_capability_expires_at: '2026-09-25T00:00:00.000Z',
		recipient_capability_revoked_at: null,
		envelope_title: 'Agreement',
		envelope_status: 'sent',
		...overrides
	};
}

const claimCommand: ClaimInvitationDeliveriesCommand = {
	claimToken: 'claim-token-0001',
	claimedAt: '2026-09-12T00:00:00.000Z',
	staleBefore: '2026-09-11T23:55:00.000Z',
	limit: 5
};

describe('D1DeliveryOutboxStore.claimPendingInvitations', () => {
	it('returns an empty projection from one atomic claim batch', async () => {
		const { database, batches } = fakeD1({ batchResults: [[], [], []] });
		const store = new D1DeliveryOutboxStore(database);
		const claimed = await store.claimPendingInvitations(claimCommand);
		expect(claimed).toEqual([]);
		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(3);
	});

	it('cleans terminal rows, claims eligible rows, and reads the exact lease in one atomic batch', async () => {
		const { database, prepared } = fakeD1({ batchResults: [[], [], []] });
		const store = new D1DeliveryOutboxStore(database);
		await store.claimPendingInvitations(claimCommand);
		expect(prepared).toHaveLength(3);
		expect(prepared[0].sql).toContain("last_error = 'delivery_not_eligible'");
		expect(prepared[0].sql).toContain('sealed_capability = NULL');
		expect(prepared[0].bindings).toEqual([
			claimCommand.staleBefore,
			claimCommand.claimedAt,
			100,
			claimCommand.claimedAt,
			claimCommand.claimedAt
		]);
		expect(prepared[0].sql).toContain('LIMIT ?');
		expect(prepared[1].sql).toContain("delivery.kind = 'recipient_invitation'");
		expect(prepared[1].bindings).toEqual([
			claimCommand.claimToken,
			claimCommand.claimedAt,
			claimCommand.claimedAt,
			claimCommand.claimedAt,
			claimCommand.staleBefore,
			claimCommand.claimedAt,
			claimCommand.limit
		]);
		expect(prepared[1].sql).toContain('julianday(recipient.capability_expires_at) > julianday(?)');
		expect(prepared[1].sql).toContain("recipient.role IN ('signer', 'approver', 'viewer')");
		expect(prepared[1].sql).toContain('RETURNING id');
		expect(prepared[2].bindings).toEqual([claimCommand.claimToken]);
		expect(prepared[2].sql).toContain("delivery.status = 'processing'");
	});

	it('returns every row published under the new claim token', async () => {
		const rows = [candidateRow(), candidateRow({ delivery_id: 'delivery-2' })];
		const { database, batches } = fakeD1({
			batchMeta: [{ changes: 0 }, { changes: 2 }, { changes: 0 }],
			batchResults: [[], [{ id: 'delivery-1' }, { id: 'delivery-2' }], rows]
		});
		const store = new D1DeliveryOutboxStore(database);
		const claimed = await store.claimPendingInvitations(claimCommand);

		expect(batches).toHaveLength(1);
		expect(batches[0]).toHaveLength(3);
		expect(batches[0][1].sql).toContain("SET status = 'processing'");
		expect(batches[0][1].sql).toContain('attempts = attempts + 1');
		expect(batches[0][1].bindings).toEqual([
			claimCommand.claimToken,
			claimCommand.claimedAt,
			claimCommand.claimedAt,
			claimCommand.claimedAt,
			claimCommand.staleBefore,
			claimCommand.claimedAt,
			claimCommand.limit
		]);

		expect(claimed).toHaveLength(2);
		expect(claimed[0]).toEqual({
			deliveryId: 'delivery-1',
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

	it('returns only rows from the transaction-local claimed projection', async () => {
		const rows = [candidateRow(), candidateRow({ delivery_id: 'delivery-2' })];
		const { database } = fakeD1({
			batchMeta: [{ changes: 0 }, { changes: 1 }, { changes: 0 }],
			batchResults: [[], [{ id: 'delivery-1' }], [rows[0]]]
		});
		const store = new D1DeliveryOutboxStore(database);
		const claimed = await store.claimPendingInvitations(claimCommand);
		expect(claimed.map((claim) => claim.deliveryId)).toEqual(['delivery-1']);
	});

	it('increments attempts from the pre-claim value and stamps lockedAt with claimedAt', async () => {
		const { database } = fakeD1({
			batchMeta: [{ changes: 0 }, { changes: 1 }, { changes: 0 }],
			batchResults: [[], [{ id: 'delivery-1' }], [candidateRow({ attempts: 4 })]]
		});
		const store = new D1DeliveryOutboxStore(database);
		const [claim] = await store.claimPendingInvitations(claimCommand);
		expect(claim.attempts).toBe(4);
		expect(claim.lockedAt).toBe(claimCommand.claimedAt);
	});
});

describe('D1DeliveryOutboxStore.completeInvitationDelivery', () => {
	const completeCommand: CompleteInvitationDeliveryCommand = {
		deliveryId: 'delivery-1',
		claimToken: 'claim-token-0001',
		deliveredAt: '2026-09-12T00:01:00.000Z',
		providerMessageId: 'provider-message-1'
	};

	it('scrubs the sealed capability, clears the lease, and marks the delivery non-retryable', async () => {
		const { database, prepared } = fakeD1({ runMeta: { changes: 1 } });
		const store = new D1DeliveryOutboxStore(database);
		const result = await store.completeInvitationDelivery(completeCommand);
		expect(result).toEqual({ outcome: 'completed' });
		expect(prepared).toHaveLength(1);
		expect(prepared[0].sql).toContain("status = 'delivered'");
		expect(prepared[0].sql).toContain('sealed_capability = NULL');
		expect(prepared[0].sql).toContain('last_error = NULL');
		expect(prepared[0].sql).toContain('retryable = 0');
		expect(prepared[0].sql).toContain('claim_token = NULL, locked_at = NULL');
		expect(prepared[0].sql).toContain("AND status = 'processing' AND claim_token = ?");
		expect(prepared[0].bindings).toEqual([
			completeCommand.deliveredAt,
			completeCommand.providerMessageId,
			completeCommand.deliveredAt,
			completeCommand.deliveryId,
			completeCommand.claimToken
		]);
	});

	it('reports a stale outcome when the delivery, status, or claim no longer match', async () => {
		const { database } = fakeD1({ runMeta: { changes: 0 } });
		const store = new D1DeliveryOutboxStore(database);
		const result = await store.completeInvitationDelivery(completeCommand);
		expect(result).toEqual({ outcome: 'stale' });
	});
});

describe('D1DeliveryOutboxStore.readClaimedInvitation', () => {
	it('re-reads the current lease projection immediately before delivery', async () => {
		const { database, prepared } = fakeD1({ firstResult: candidateRow() });
		const result = await new D1DeliveryOutboxStore(database).readClaimedInvitation({
			deliveryId: 'delivery-1',
			claimToken: claimCommand.claimToken
		});

		expect(result).toMatchObject({ deliveryId: 'delivery-1', lockedAt: claimCommand.claimedAt });
		expect(prepared[0].bindings).toEqual(['delivery-1', claimCommand.claimToken]);
		expect(prepared[0].sql).toContain("delivery.status = 'processing'");
		expect(prepared[0].sql).toContain('delivery.claim_token = ?');
	});

	it('returns null after a lease is reclaimed or terminal', async () => {
		await expect(
			new D1DeliveryOutboxStore(fakeD1({ firstResult: null }).database).readClaimedInvitation({
				deliveryId: 'delivery-1',
				claimToken: 'stale-claim-token'
			})
		).resolves.toBeNull();
	});
});

describe('D1DeliveryOutboxStore.failInvitationDelivery', () => {
	const baseFailCommand: FailInvitationDeliveryCommand = {
		deliveryId: 'delivery-1',
		claimToken: 'claim-token-0001',
		errorCode: 'mail_delivery_failed',
		retryable: true,
		nextAvailableAt: '2026-09-12T00:05:00.000Z',
		failedAt: '2026-09-12T00:01:00.000Z'
	};

	it('retains the sealed capability and marks the delivery retryable on a retryable failure', async () => {
		const { database, prepared } = fakeD1({ runMeta: { changes: 1 } });
		const store = new D1DeliveryOutboxStore(database);
		const result = await store.failInvitationDelivery(baseFailCommand);
		expect(result).toEqual({ outcome: 'failed' });
		expect(prepared[0].sql).toContain("status = 'failed'");
		expect(prepared[0].sql).toContain('retryable = 1');
		expect(prepared[0].sql).not.toContain('sealed_capability = NULL');
		expect(prepared[0].bindings).toEqual([
			baseFailCommand.nextAvailableAt,
			baseFailCommand.errorCode,
			baseFailCommand.failedAt,
			baseFailCommand.deliveryId,
			baseFailCommand.claimToken
		]);
	});

	it('scrubs the sealed capability and marks the delivery non-retryable on a permanent failure', async () => {
		const { database, prepared } = fakeD1({ runMeta: { changes: 1 } });
		const store = new D1DeliveryOutboxStore(database);
		const command: FailInvitationDeliveryCommand = { ...baseFailCommand, retryable: false };
		const result = await store.failInvitationDelivery(command);
		expect(result).toEqual({ outcome: 'failed' });
		expect(prepared[0].sql).toContain("status = 'failed'");
		expect(prepared[0].sql).toContain('retryable = 0');
		expect(prepared[0].sql).toContain('sealed_capability = NULL');
		expect(prepared[0].bindings).toEqual([
			command.nextAvailableAt,
			command.errorCode,
			command.failedAt,
			command.deliveryId,
			command.claimToken
		]);
	});

	it('reports a stale outcome for both retryable and non-retryable failures when the claim CAS misses', async () => {
		const retryableStore = new D1DeliveryOutboxStore(fakeD1({ runMeta: { changes: 0 } }).database);
		expect(await retryableStore.failInvitationDelivery(baseFailCommand)).toEqual({
			outcome: 'stale'
		});
		const permanentStore = new D1DeliveryOutboxStore(fakeD1({ runMeta: { changes: 0 } }).database);
		expect(
			await permanentStore.failInvitationDelivery({ ...baseFailCommand, retryable: false })
		).toEqual({ outcome: 'stale' });
	});
});
