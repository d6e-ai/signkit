import type { Recipient } from '$lib/domain/envelope';
import type {
	DeliveryManifestEntry,
	EnvelopeSendStore,
	PendingRecipientDelivery,
	PublishSentEnvelopeCommand,
	PublishSentEnvelopeResult,
	PublishedSentEnvelope,
	SendPreparation
} from '$lib/ports/envelope-send-store';
import { issueRecipientCapability } from '$lib/security/recipient-capability';
import type { RecipientCapabilitySealer } from '$lib/security/delivery-capability';
import type { EnvelopeRequestActor } from './model';

const INITIAL_CAPABILITY_TTL_MS: number = 14 * 24 * 60 * 60 * 1000;

export interface SendEnvelopeInput {
	idempotencyKey: string;
	expectedGeneration: number;
	expectedReadyAuditEventId: string;
}

export type SendEnvelopeResult =
	| { outcome: 'published' | 'replayed'; result: PublishedSentEnvelope }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'not_ready' }
	| { outcome: 'generation_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface EnvelopeSendApplicationPort {
	send(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: SendEnvelopeInput
	): Promise<SendEnvelopeResult>;
}

export class InvalidSendCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidSendCommandError';
	}
}

export class EnvelopeSendApplication implements EnvelopeSendApplicationPort {
	readonly #store: EnvelopeSendStore;
	readonly #sealer: RecipientCapabilitySealer;

	constructor(store: EnvelopeSendStore, sealer: RecipientCapabilitySealer) {
		this.#store = store;
		this.#sealer = sealer;
	}

	async send(
		actor: EnvelopeRequestActor,
		envelopeId: string,
		input: SendEnvelopeInput
	): Promise<SendEnvelopeResult> {
		assertExpectedGeneration(input.expectedGeneration);
		const requestFingerprint: string = await sha256(
			JSON.stringify({
				expectedGeneration: input.expectedGeneration,
				expectedReadyAuditEventId: input.expectedReadyAuditEventId
			})
		);
		const key = {
			organizationId: actor.organizationId,
			envelopeId,
			actorType: 'user' as const,
			actorId: actor.id,
			idempotencyKey: input.idempotencyKey,
			requestFingerprint
		};
		const preparation: SendPreparation = await this.#store.prepareSend(
			key,
			input.expectedGeneration,
			input.expectedReadyAuditEventId
		);
		if (preparation.outcome !== 'ready') return preparation;

		const actionableRecipients: readonly Recipient[] = preparation.recipients.filter(
			(recipient: Recipient): boolean => recipient.role !== 'cc'
		);
		if (actionableRecipients.length === 0) return { outcome: 'integrity_error' };
		const initialRoutingOrder: number = Math.min(
			...actionableRecipients.map((recipient: Recipient): number => recipient.routingOrder)
		);
		const updatedAt: string = new Date().toISOString();
		const initialCapabilityExpiresAt: string = new Date(
			Date.parse(updatedAt) + INITIAL_CAPABILITY_TTL_MS
		).toISOString();
		const deliveries: readonly PendingRecipientDelivery[] = await Promise.all(
			actionableRecipients.map(async (recipient: Recipient): Promise<PendingRecipientDelivery> => {
				const deliveryId: string = await deterministicUuid(
					[
						'signkit-recipient-invitation-v1',
						actor.organizationId,
						envelopeId,
						actor.id,
						input.idempotencyKey,
						recipient.id
					].join('\u0000')
				);
				const capability = await issueRecipientCapability();
				const sealed = await this.#sealer.seal(capability.token, {
					organizationId: actor.organizationId,
					envelopeId,
					recipientId: recipient.id,
					deliveryId
				});
				const initial: boolean = recipient.routingOrder === initialRoutingOrder;
				return {
					id: deliveryId,
					recipientId: recipient.id,
					capabilityHash: capability.tokenHash,
					capabilityExpiresAt: initial ? initialCapabilityExpiresAt : null,
					sealedCapability: sealed.sealedCapability,
					sealingKeyId: sealed.sealingKeyId,
					sealedCapabilitySha256: sealed.sealedCapabilitySha256,
					status: initial ? 'pending' : 'blocked',
					availableAt: initial ? updatedAt : null
				};
			})
		);
		const deliveryManifestJson: string = JSON.stringify(
			deliveries
				.map((delivery: PendingRecipientDelivery): DeliveryManifestEntry => ({
					id: delivery.id,
					recipientId: delivery.recipientId,
					capabilityHash: delivery.capabilityHash,
					capabilityExpiresAt: delivery.capabilityExpiresAt,
					sealingKeyId: delivery.sealingKeyId,
					sealedCapabilitySha256: delivery.sealedCapabilitySha256,
					initialStatus: delivery.status,
					initialAvailableAt: delivery.availableAt
				}))
				.sort((left: DeliveryManifestEntry, right: DeliveryManifestEntry): number =>
					left.id.localeCompare(right.id)
				)
		);
		const deliveryManifestHash: string = await sha256(deliveryManifestJson);
		const auditEventId: string = await deterministicUuid(
			['signkit-send-event-v1', actor.organizationId, actor.id, input.idempotencyKey].join('\u0000')
		);
		const auditPayloadJson: string = JSON.stringify({
			commitSha: preparation.envelope.repositoryHead,
			generation: preparation.envelope.repositoryGeneration,
			readyAuditEventId: input.expectedReadyAuditEventId,
			initialRoutingOrder,
			queuedDeliveryCount: deliveries.filter(
				(delivery: PendingRecipientDelivery): boolean => delivery.status === 'pending'
			).length,
			reservedCapabilityCount: deliveries.length,
			deliveryManifestHash,
			initialCapabilityExpiresAt
		});
		const auditEventHash: string = await sha256(
			JSON.stringify({
				actorId: actor.id,
				envelopeId,
				eventType: 'envelope.sent',
				occurredAt: updatedAt,
				organizationId: actor.organizationId,
				payload: JSON.parse(auditPayloadJson) as unknown,
				previousHash: preparation.auditHead.eventHash
			})
		);
		const command: PublishSentEnvelopeCommand = {
			...key,
			expectedGeneration: input.expectedGeneration,
			expectedReadyAuditEventId: input.expectedReadyAuditEventId,
			commitSha: requiredHead(preparation.envelope.repositoryHead),
			deliveries,
			initialRoutingOrder,
			deliveryManifestJson,
			deliveryManifestHash,
			initialCapabilityExpiresAt,
			updatedAt,
			expectedAuditSequence: preparation.auditHead.sequence,
			previousAuditHash: preparation.auditHead.eventHash,
			auditEventId,
			auditEventHash,
			auditPayloadJson
		};
		const result: PublishSentEnvelopeResult = await this.#store.publishSend(command);
		return result;
	}
}

function assertExpectedGeneration(expectedGeneration: number): void {
	if (
		!Number.isSafeInteger(expectedGeneration) ||
		expectedGeneration < 1 ||
		expectedGeneration > 2_147_483_647
	) {
		throw new InvalidSendCommandError('Expected generation is outside the supported range');
	}
}

function requiredHead(value: string | null): string {
	if (value === null || value.length === 0) throw new Error('Send preparation returned no commit');
	return value;
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

async function deterministicUuid(value: string): Promise<string> {
	const digest: string = await sha256(value);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(
		17,
		20
	)}-${digest.slice(20, 32)}`;
}
