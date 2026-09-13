export interface ReissueCommandKey {
	organizationId: string;
	envelopeId: string;
	recipientId: string;
	actorType: 'user' | 'agent' | 'system';
	actorId: string;
	idempotencyKey: string;
	requestHash: string;
}

export interface ReissueAuditHead {
	sequence: number;
	eventHash: string;
}

export interface PublishedReissueResult {
	envelopeId: string;
	recipientId: string;
	newCapabilityHash: string;
	outboxId: string;
	reissuedAt: string;
	auditEventId: string;
}

export type ReissuePreparation =
	| {
			outcome: 'ready';
			previousCapabilityHash: string;
			recipientStatus: 'pending' | 'viewed';
			envelopeStatus: 'sent' | 'in_progress';
			auditHead: ReissueAuditHead;
	  }
	| { outcome: 'replayed'; result: PublishedReissueResult }
	| { outcome: 'not_found' }
	| {
			outcome: 'not_eligible';
			reason: 'envelope_terminal' | 'recipient_terminal' | 'not_released' | 'envelope_not_sent';
	  }
	| { outcome: 'delivery_in_flight' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface PublishReissueCommand extends ReissueCommandKey {
	previousCapabilityHash: string;
	newCapabilityHash: string;
	reservedCapabilityExpiresAt: string;
	sealedCapability: string;
	sealingKeyId: string;
	sealedCapabilitySha256: string;
	outboxId: string;
	reason: string;
	updatedAt: string;
	expectedAuditSequence: number;
	previousAuditHash: string;
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
}

export type PublishReissueResult =
	| { outcome: 'published'; result: PublishedReissueResult }
	| Exclude<ReissuePreparation, { outcome: 'ready' }>;

export interface RecipientCapabilityReissueStore {
	prepareReissue(key: ReissueCommandKey, at: string): Promise<ReissuePreparation>;
	publishReissue(command: PublishReissueCommand): Promise<PublishReissueResult>;
}
