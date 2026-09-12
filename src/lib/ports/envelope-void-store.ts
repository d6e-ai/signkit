export type VoidableEnvelopeStatus = 'draft' | 'ready' | 'sent' | 'in_progress';

export interface VoidCommandKey {
	organizationId: string;
	envelopeId: string;
	actorType: 'user' | 'agent' | 'system';
	actorId: string;
	idempotencyKey: string;
	requestFingerprint: string;
	expectedStatus: VoidableEnvelopeStatus;
	expectedGeneration: number;
}

export interface VoidAuditHead {
	sequence: number;
	eventHash: string;
}

export interface PublishedVoidedEnvelope {
	envelopeId: string;
	status: 'voided';
	previousStatus: VoidableEnvelopeStatus;
	generation: number;
	voidedAt: string;
	revokedCapabilityCount: number;
	auditEventId: string;
}

export type VoidPreparation =
	| {
			outcome: 'ready';
			previousStatus: VoidableEnvelopeStatus;
			generation: number;
			repositoryHead: string | null;
			sentCommitSha: string | null;
			auditHead: VoidAuditHead;
			revokedRecipientIds: readonly string[];
	  }
	| { outcome: 'replayed'; result: PublishedVoidedEnvelope }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'not_voidable' }
	| { outcome: 'status_conflict' }
	| { outcome: 'generation_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'delivery_in_flight' }
	| { outcome: 'integrity_error' };

export interface PublishVoidedEnvelopeCommand extends VoidCommandKey {
	updatedAt: string;
	expectedAuditSequence: number;
	previousAuditHash: string;
	repositoryHead: string | null;
	sentCommitSha: string | null;
	revokedRecipientIds: readonly string[];
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
}

export type PublishVoidedEnvelopeResult =
	| { outcome: 'published'; result: PublishedVoidedEnvelope }
	| Exclude<VoidPreparation, { outcome: 'ready' }>;

export interface EnvelopeVoidStore {
	prepareVoid(key: VoidCommandKey): Promise<VoidPreparation>;
	publishVoid(command: PublishVoidedEnvelopeCommand): Promise<PublishVoidedEnvelopeResult>;
}
