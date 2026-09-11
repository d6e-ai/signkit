import type { Envelope, Recipient } from '$lib/domain/envelope';

export interface SendCommandKey {
	organizationId: string;
	envelopeId: string;
	actorType: 'user' | 'agent' | 'system';
	actorId: string;
	idempotencyKey: string;
	requestFingerprint: string;
}

export interface SendAuditHead {
	eventId: string;
	eventType: string;
	sequence: number;
	eventHash: string;
}

export interface PublishedSentEnvelope {
	envelopeId: string;
	status: 'sent';
	generation: number;
	commitSha: string;
	readyAuditEventId: string;
	queuedDeliveryCount: number;
	reservedCapabilityCount: number;
	initialCapabilityExpiresAt: string;
	updatedAt: string;
	auditEventId: string;
}

export interface PendingRecipientDelivery {
	id: string;
	recipientId: string;
	capabilityHash: string;
	capabilityExpiresAt: string | null;
	sealedCapability: string;
	sealingKeyId: string;
	sealedCapabilitySha256: string;
	status: 'blocked' | 'pending';
	availableAt: string | null;
}

export interface DeliveryManifestEntry {
	id: string;
	recipientId: string;
	capabilityHash: string;
	capabilityExpiresAt: string | null;
	sealingKeyId: string;
	sealedCapabilitySha256: string;
	initialStatus: 'blocked' | 'pending';
	initialAvailableAt: string | null;
}

export type SendPreparation =
	| {
			outcome: 'ready';
			envelope: Envelope;
			recipients: readonly Recipient[];
			auditHead: SendAuditHead;
	  }
	| { outcome: 'replayed'; result: PublishedSentEnvelope }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'not_ready' }
	| { outcome: 'generation_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface PublishSentEnvelopeCommand extends SendCommandKey {
	expectedGeneration: number;
	expectedReadyAuditEventId: string;
	commitSha: string;
	deliveries: readonly PendingRecipientDelivery[];
	initialRoutingOrder: number;
	deliveryManifestJson: string;
	deliveryManifestHash: string;
	initialCapabilityExpiresAt: string;
	updatedAt: string;
	expectedAuditSequence: number;
	previousAuditHash: string;
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
}

export type PublishSentEnvelopeResult =
	| { outcome: 'published'; result: PublishedSentEnvelope }
	| Exclude<SendPreparation, { outcome: 'ready' }>;

export interface EnvelopeSendStore {
	prepareSend(
		key: SendCommandKey,
		expectedGeneration: number,
		expectedReadyAuditEventId: string
	): Promise<SendPreparation>;
	publishSend(command: PublishSentEnvelopeCommand): Promise<PublishSentEnvelopeResult>;
}
