import {
	isActionableRecipientRole,
	isPostSendInvitationRecipientRole,
	type Recipient
} from '$lib/domain/envelope';
import { newUuidV7, type UuidV7Generator } from '$lib/ids/uuid-v7';
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
	readonly #newId: UuidV7Generator;

	constructor(
		store: EnvelopeSendStore,
		sealer: RecipientCapabilitySealer,
		newId: UuidV7Generator = newUuidV7
	) {
		this.#store = store;
		this.#sealer = sealer;
		this.#newId = newId;
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
			(recipient: Recipient): boolean => isActionableRecipientRole(recipient.role)
		);
		if (actionableRecipients.length === 0) return { outcome: 'integrity_error' };
		const actionableRoutingOrders: Set<number> = new Set<number>(
			actionableRecipients.map((recipient: Recipient): number => recipient.routingOrder)
		);
		const invitationRecipients: readonly Recipient[] = preparation.recipients.filter(
			(recipient: Recipient): boolean => isPostSendInvitationRecipientRole(recipient.role)
		);
		if (
			invitationRecipients.some(
				(recipient: Recipient): boolean =>
					recipient.role === 'viewer' && !actionableRoutingOrders.has(recipient.routingOrder)
			)
		) {
			return { outcome: 'integrity_error' };
		}
		const initialRoutingOrder: number = Math.min(
			...actionableRecipients.map((recipient: Recipient): number => recipient.routingOrder)
		);
		const updatedAt: string = new Date().toISOString();
		const initialCapabilityExpiresAt: string = new Date(
			Date.parse(updatedAt) + INITIAL_CAPABILITY_TTL_MS
		).toISOString();
		// Delivery intents mint their own identifiers, matching the capability
		// each one seals: both are fresh per attempt, and only a published or
		// replayed command makes either durable.
		const deliveries: readonly PendingRecipientDelivery[] = await Promise.all(
			invitationRecipients.map(async (recipient: Recipient): Promise<PendingRecipientDelivery> => {
				const deliveryId: string = this.#newId();
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
		const auditEventId: string = this.#newId();
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
