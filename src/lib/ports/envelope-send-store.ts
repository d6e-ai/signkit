import type { Envelope, Recipient } from '$lib/domain/envelope';
import type { SentDocumentSetArtifact } from '$lib/application/documents/sent-document-pdf';

export interface SendCommandKey {
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
	/**
	 * The immutable per-document PDF renderings of `commitSha`, already written
	 * to object storage. Implementations publish this set inside the same atomic
	 * boundary as the status flip and the audit event, so a lost CAS, a stale
	 * generation, an audit conflict, or an idempotency conflict can never
	 * leave a sent envelope pointing at a rendering of something else.
	 */
	sentDocumentSet: SentDocumentSetArtifact;
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
