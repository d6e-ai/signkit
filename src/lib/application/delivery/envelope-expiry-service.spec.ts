import { describe, expect, it } from 'vitest';
import type {
	DiscoverExpirableEnvelopesCommand,
	EnvelopeExpiryPreparation,
	EnvelopeExpiryStore,
	ExpirableEnvelopeId,
	PublishEnvelopeExpiryCommand,
	PublishEnvelopeExpiryResult
} from '$lib/ports/envelope-expiry-store';
import { EnvelopeExpiryDrainService } from './envelope-expiry-service';

const NOW: Date = new Date('2026-09-13T00:00:00.000Z');

class FakeStore implements EnvelopeExpiryStore {
	candidates: ExpirableEnvelopeId[] = [];
	preparations: EnvelopeExpiryPreparation[] = [];
	publishResults: PublishEnvelopeExpiryResult[] = [];
	readonly publishCalls: PublishEnvelopeExpiryCommand[] = [];
	discoverCalls: DiscoverExpirableEnvelopesCommand[] = [];
	#prepareIndex: number = 0;
	#publishIndex: number = 0;

	async discoverExpirableEnvelopes(
		command: DiscoverExpirableEnvelopesCommand
	): Promise<readonly ExpirableEnvelopeId[]> {
		this.discoverCalls.push(command);
		return this.candidates.slice(0, command.limit);
	}

	async prepareEnvelopeExpiry(): Promise<EnvelopeExpiryPreparation> {
		const result: EnvelopeExpiryPreparation = this.preparations[this.#prepareIndex];
		this.#prepareIndex += 1;
		return result;
	}

	async publishEnvelopeExpiry(
		command: PublishEnvelopeExpiryCommand
	): Promise<PublishEnvelopeExpiryResult> {
		this.publishCalls.push(command);
		const result: PublishEnvelopeExpiryResult = this.publishResults[this.#publishIndex];
		this.#publishIndex += 1;
		return result;
	}
}

function readyPreparation(
	overrides: Partial<Extract<EnvelopeExpiryPreparation, { outcome: 'ready' }>> = {}
): Extract<EnvelopeExpiryPreparation, { outcome: 'ready' }> {
	return {
		outcome: 'ready',
		envelopeId: 'envelope-1',
		previousStatus: 'sent',
		generation: 1,
		repositoryHead: 'commit-sha',
		sentCommitSha: 'commit-sha',
		auditHead: { sequence: 3, eventHash: 'hash-3' },
		revokedRecipientIds: ['recipient-2', 'recipient-1'],
		...overrides
	};
}

describe('EnvelopeExpiryDrainService', () => {
	it('discovers, prepares, and publishes an eligible envelope with a chained audit event', async () => {
		const store = new FakeStore();
		store.candidates = [{ envelopeId: 'envelope-1' }];
		store.preparations = [readyPreparation()];
		store.publishResults = [
			{
				outcome: 'published',
				result: {
					envelopeId: 'envelope-1',
					expiredAt: NOW.toISOString(),
					revokedCapabilityCount: 2,
					auditEventId: 'audit-1'
				}
			}
		];

		const service = new EnvelopeExpiryDrainService(
			store,
			(): Date => NOW,
			(): string => 'audit-1'
		);
		const result = await service.drainExpiredEnvelopes();

		expect(result).toEqual({
			discovered: 1,
			expired: 1,
			skipped: 0,
			outcomes: [{ envelopeId: 'envelope-1', outcome: 'expired' }]
		});
		expect(store.discoverCalls[0]).toEqual({ now: NOW.toISOString(), limit: 25 });
		const published = store.publishCalls[0];
		expect(published.expectedStatus).toBe('sent');
		expect(published.revokedRecipientIds).toEqual(['recipient-1', 'recipient-2']);
		expect(published.expectedAuditSequence).toBe(3);
		expect(published.previousAuditHash).toBe('hash-3');
		expect(published.auditEventId).toBe('audit-1');

		const payload = JSON.parse(published.auditPayloadJson);
		expect(payload).toEqual({
			previousStatus: 'sent',
			generation: 1,
			repositoryHead: 'commit-sha',
			sentCommitSha: 'commit-sha',
			expiredAt: NOW.toISOString(),
			revokedCapabilities: {
				reason: 'envelope_expired',
				recipientIds: ['recipient-1', 'recipient-2']
			}
		});
	});

	it('skips a candidate no longer eligible when prepared', async () => {
		const store = new FakeStore();
		store.candidates = [{ envelopeId: 'envelope-1' }];
		store.preparations = [{ outcome: 'not_eligible' }];

		const service = new EnvelopeExpiryDrainService(store, (): Date => NOW);
		const result = await service.drainExpiredEnvelopes();

		expect(result).toEqual({
			discovered: 1,
			expired: 0,
			skipped: 1,
			outcomes: [{ envelopeId: 'envelope-1', outcome: 'skipped' }]
		});
		expect(store.publishCalls).toHaveLength(0);
	});

	it('retries a bounded number of times on audit_conflict before giving up', async () => {
		const store = new FakeStore();
		store.candidates = [{ envelopeId: 'envelope-1' }];
		store.preparations = [readyPreparation(), readyPreparation(), readyPreparation()];
		store.publishResults = [
			{ outcome: 'audit_conflict' },
			{ outcome: 'audit_conflict' },
			{ outcome: 'audit_conflict' }
		];

		const service = new EnvelopeExpiryDrainService(store, (): Date => NOW);
		const result = await service.drainExpiredEnvelopes();

		expect(result.outcomes).toEqual([{ envelopeId: 'envelope-1', outcome: 'skipped' }]);
		expect(store.publishCalls).toHaveLength(3);
	});

	it('recovers from a single audit_conflict by re-preparing and succeeding', async () => {
		const store = new FakeStore();
		store.candidates = [{ envelopeId: 'envelope-1' }];
		store.preparations = [
			readyPreparation({ auditHead: { sequence: 3, eventHash: 'hash-3' } }),
			readyPreparation({ auditHead: { sequence: 4, eventHash: 'hash-4' } })
		];
		store.publishResults = [
			{ outcome: 'audit_conflict' },
			{
				outcome: 'published',
				result: {
					envelopeId: 'envelope-1',
					expiredAt: NOW.toISOString(),
					revokedCapabilityCount: 2,
					auditEventId: 'audit-2'
				}
			}
		];

		const service = new EnvelopeExpiryDrainService(store, (): Date => NOW);
		const result = await service.drainExpiredEnvelopes();

		expect(result.outcomes).toEqual([{ envelopeId: 'envelope-1', outcome: 'expired' }]);
		expect(store.publishCalls).toHaveLength(2);
		expect(store.publishCalls[1].expectedAuditSequence).toBe(4);
	});

	it('returns zero counts when nothing is discovered', async () => {
		const store = new FakeStore();
		const service = new EnvelopeExpiryDrainService(store, (): Date => NOW);
		await expect(service.drainExpiredEnvelopes()).resolves.toEqual({
			discovered: 0,
			expired: 0,
			skipped: 0,
			outcomes: []
		});
	});
});
