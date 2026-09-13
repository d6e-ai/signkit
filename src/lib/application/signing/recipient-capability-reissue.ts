import { hashAuditEventV2 } from '$lib/domain/audit';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
import type {
	PublishReissueCommand,
	PublishReissueResult,
	PublishedReissueResult,
	RecipientCapabilityReissueStore,
	ReissueCommandKey,
	ReissuePreparation
} from '$lib/ports/recipient-capability-reissue-store';
import { issueRecipientCapability } from '$lib/security/recipient-capability';
import type { RecipientCapabilitySealer } from '$lib/security/delivery-capability';
import type { EnvelopeRequestActor } from '$lib/application/envelopes/model';

const INITIAL_CAPABILITY_TTL_MS: number = 14 * 24 * 60 * 60 * 1000;
const MAX_AUDIT_ATTEMPTS: number = 3;

export interface ReissueRecipientCapabilityInput {
	envelopeId: string;
	recipientId: string;
	idempotencyKey: string;
	reason?: string;
}

export type ReissueRecipientCapabilityResult =
	| { outcome: 'published' | 'replayed'; result: PublishedReissueResult }
	| { outcome: 'not_found' }
	| {
			outcome: 'not_eligible';
			reason: 'envelope_terminal' | 'recipient_terminal' | 'not_released' | 'envelope_not_sent';
	  }
	| { outcome: 'delivery_in_flight' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface RecipientCapabilityReissueApplicationPort {
	reissue(
		actor: EnvelopeRequestActor,
		input: ReissueRecipientCapabilityInput
	): Promise<ReissueRecipientCapabilityResult>;
}

export class RecipientCapabilityReissueApplication implements RecipientCapabilityReissueApplicationPort {
	readonly #store: RecipientCapabilityReissueStore;
	readonly #sealer: RecipientCapabilitySealer;
	readonly #now: () => Date;
	readonly #newId: UuidV7Generator;
	readonly #ttlMs: number;

	constructor(
		store: RecipientCapabilityReissueStore,
		sealer: RecipientCapabilitySealer,
		now: () => Date = (): Date => new Date(),
		newId: UuidV7Generator = newUuidV7,
		ttlMs: number = INITIAL_CAPABILITY_TTL_MS
	) {
		this.#store = store;
		this.#sealer = sealer;
		this.#now = now;
		this.#newId = newId;
		this.#ttlMs = ttlMs;
	}

	async reissue(
		actor: EnvelopeRequestActor,
		input: ReissueRecipientCapabilityInput
	): Promise<ReissueRecipientCapabilityResult> {
		const reason: string = input.reason?.trim() || 'reissued_by_operator';
		const requestHash: string = await sha256(
			JSON.stringify({
				envelopeId: input.envelopeId,
				recipientId: input.recipientId,
				reason
			})
		);

		const key: ReissueCommandKey = {
			organizationId: actor.organizationId,
			envelopeId: input.envelopeId,
			recipientId: input.recipientId,
			actorType: 'user',
			actorId: actor.id,
			idempotencyKey: input.idempotencyKey,
			requestHash
		};

		for (let attempt = 0; attempt < MAX_AUDIT_ATTEMPTS; attempt += 1) {
			const preparation: ReissuePreparation = await this.#store.prepareReissue(
				key,
				this.#now().toISOString()
			);
			if (preparation.outcome === 'replayed') return preparation;
			if (preparation.outcome !== 'ready') return preparation;

			const capability = await issueRecipientCapability();
			const outboxId: string = this.#newId();
			const sealed = await this.#sealer.seal(capability.token, {
				organizationId: actor.organizationId,
				envelopeId: input.envelopeId,
				recipientId: input.recipientId,
				deliveryId: outboxId
			});

			const updatedAt: string = this.#now().toISOString();
			const reservedCapabilityExpiresAt: string = new Date(
				Date.parse(updatedAt) + this.#ttlMs
			).toISOString();

			const auditEventId: string = this.#newId();
			const auditPayloadJson: string = JSON.stringify({
				recipientId: input.recipientId,
				reason,
				reissuedAt: updatedAt
			});

			const auditEventHash: string = await hashAuditEventV2(
				{
					sequence: preparation.auditHead.sequence + 1,
					eventType: 'recipient.capability_reissued',
					actorType: 'user',
					actorId: actor.id,
					occurredAt: updatedAt,
					payload: JSON.parse(auditPayloadJson) as unknown,
					previousHash: preparation.auditHead.eventHash
				},
				{ organizationId: actor.organizationId, envelopeId: input.envelopeId }
			);

			const command: PublishReissueCommand = {
				...key,
				previousCapabilityHash: preparation.previousCapabilityHash,
				newCapabilityHash: capability.tokenHash,
				reservedCapabilityExpiresAt,
				sealedCapability: sealed.sealedCapability,
				sealingKeyId: sealed.sealingKeyId,
				sealedCapabilitySha256: sealed.sealedCapabilitySha256,
				outboxId,
				reason,
				updatedAt,
				expectedAuditSequence: preparation.auditHead.sequence,
				previousAuditHash: preparation.auditHead.eventHash,
				auditEventId,
				auditEventHash,
				auditPayloadJson
			};

			const published: PublishReissueResult = await this.#store.publishReissue(command);
			if (published.outcome === 'audit_conflict' && attempt + 1 < MAX_AUDIT_ATTEMPTS) {
				continue;
			}
			return published;
		}

		return { outcome: 'audit_conflict' };
	}
}

async function sha256(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
