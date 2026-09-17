import { hashAuditEventV3 } from '$lib/domain/audit';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import {
	boundEnvelopeExpiryDiscoveryLimit,
	MAX_ENVELOPE_EXPIRY_DISCOVERY_BATCH,
	type EnvelopeExpiryPreparation,
	type EnvelopeExpiryStore,
	type ExpirableEnvelopeId,
	type PublishEnvelopeExpiryCommand,
	type PublishEnvelopeExpiryResult
} from '$lib/ports/envelope-expiry-store';

const MAX_AUDIT_ATTEMPTS: number = 3;
const EXPIRY_ACTOR_ID: string = 'envelope-expiry-drain';

export type EnvelopeExpiryItemOutcome =
	{ envelopeId: string; outcome: 'expired' } | { envelopeId: string; outcome: 'skipped' };

export interface EnvelopeExpiryBatchResult {
	discovered: number;
	expired: number;
	skipped: number;
	outcomes: readonly EnvelopeExpiryItemOutcome[];
}

/**
 * Durable expiry drain: makes the `expired` envelope terminal state actually
 * reachable. Discovers `sent`/`in_progress` envelopes whose actionable
 * recipients have all lapsed without action, then transitions each one in
 * its own retried, audit-chained publication with the same terminal
 * delivery-outbox/capability cleanup as void.
 */
export class EnvelopeExpiryDrainService {
	readonly #store: EnvelopeExpiryStore;
	readonly #now: () => Date;
	readonly #newId: UuidV7Generator;

	constructor(
		store: EnvelopeExpiryStore,
		now: () => Date = (): Date => new Date(),
		newId: UuidV7Generator = newUuidV7
	) {
		this.#store = store;
		this.#now = now;
		this.#newId = newId;
	}

	async drainExpiredEnvelopes(
		limit: number = MAX_ENVELOPE_EXPIRY_DISCOVERY_BATCH
	): Promise<EnvelopeExpiryBatchResult> {
		const now: Date = this.#now();
		const candidates: readonly ExpirableEnvelopeId[] = await this.#store.discoverExpirableEnvelopes(
			{ now: now.toISOString(), limit: boundEnvelopeExpiryDiscoveryLimit(limit) }
		);

		const outcomes: EnvelopeExpiryItemOutcome[] = [];
		for (const candidate of candidates) {
			outcomes.push(await this.#expireOne(candidate, now));
		}
		return summarize(candidates.length, outcomes);
	}

	async #expireOne(candidate: ExpirableEnvelopeId, now: Date): Promise<EnvelopeExpiryItemOutcome> {
		for (let attempt: number = 0; attempt < MAX_AUDIT_ATTEMPTS; attempt += 1) {
			const preparation: EnvelopeExpiryPreparation = await this.#store.prepareEnvelopeExpiry(
				candidate.envelopeId,
				now.toISOString()
			);
			if (preparation.outcome !== 'ready') {
				return { envelopeId: candidate.envelopeId, outcome: 'skipped' };
			}

			const expiredAt: string = now.toISOString();
			const revokedRecipientIds: readonly string[] = [...preparation.revokedRecipientIds].sort(
				(left: string, right: string): number => left.localeCompare(right)
			);
			const auditEventId: string = this.#newId();
			const auditPayloadJson: string = JSON.stringify({
				previousStatus: preparation.previousStatus,
				generation: preparation.generation,
				repositoryHead: preparation.repositoryHead,
				sentCommitSha: preparation.sentCommitSha,
				expiredAt,
				revokedCapabilities: {
					reason: 'envelope_expired',
					recipientIds: revokedRecipientIds
				}
			});
			const auditEventHash: string = await hashAuditEventV3(
				{
					sequence: preparation.auditHead.sequence + 1,
					eventType: 'envelope.expired',
					actorType: 'system',
					actorId: EXPIRY_ACTOR_ID,
					occurredAt: expiredAt,
					payload: JSON.parse(auditPayloadJson) as unknown,
					previousHash: preparation.auditHead.eventHash
				},
				{ envelopeId: candidate.envelopeId }
			);
			const command: PublishEnvelopeExpiryCommand = {
				envelopeId: candidate.envelopeId,
				expectedStatus: preparation.previousStatus,
				expectedGeneration: preparation.generation,
				repositoryHead: preparation.repositoryHead,
				sentCommitSha: preparation.sentCommitSha,
				expectedAuditSequence: preparation.auditHead.sequence,
				previousAuditHash: preparation.auditHead.eventHash,
				revokedRecipientIds,
				expiredAt,
				auditEventId,
				auditPayloadJson,
				auditEventHash
			};
			const published: PublishEnvelopeExpiryResult =
				await this.#store.publishEnvelopeExpiry(command);
			if (published.outcome === 'audit_conflict' && attempt + 1 < MAX_AUDIT_ATTEMPTS) continue;
			return {
				envelopeId: candidate.envelopeId,
				outcome: published.outcome === 'published' ? 'expired' : 'skipped'
			};
		}
		return { envelopeId: candidate.envelopeId, outcome: 'skipped' };
	}
}

function summarize(
	discovered: number,
	outcomes: readonly EnvelopeExpiryItemOutcome[]
): EnvelopeExpiryBatchResult {
	let expired: number = 0;
	let skipped: number = 0;
	for (const item of outcomes) {
		if (item.outcome === 'expired') expired += 1;
		else skipped += 1;
	}
	return { discovered, expired, skipped, outcomes };
}
