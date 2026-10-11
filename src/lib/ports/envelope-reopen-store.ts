import type { Envelope } from '$lib/domain/envelope';

export interface ReopenCommandKey {
	envelopeId: string;
	actorType: 'user' | 'agent' | 'system';
	actorId: string;
	idempotencyKey: string;
	requestFingerprint: string;
}

export interface ReopenAuditHead {
	sequence: number;
	eventHash: string;
}

export interface PublishedReopenedEnvelope {
	envelopeId: string;
	status: 'draft';
	generation: number;
	fieldGeneration: number;
	updatedAt: string;
	auditEventId: string;
}

export type ReopenPreparation =
	| { outcome: 'ready'; envelope: Envelope; auditHead: ReopenAuditHead }
	| { outcome: 'replayed'; result: PublishedReopenedEnvelope }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'not_ready' }
	| { outcome: 'generation_conflict' }
	| { outcome: 'field_generation_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface PublishReopenedEnvelopeCommand extends ReopenCommandKey {
	expectedGeneration: number;
	expectedFieldGeneration: number;
	expectedReadyAuditEventId: string;
	expectedCommitSha: string;
	updatedAt: string;
	expectedAuditSequence: number;
	previousAuditHash: string;
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
}

export type PublishReopenedEnvelopeResult =
	| { outcome: 'published'; result: PublishedReopenedEnvelope }
	| Exclude<ReopenPreparation, { outcome: 'ready' }>;

export interface EnvelopeReopenStore {
	prepareReopen(
		key: ReopenCommandKey,
		expectedGeneration: number,
		expectedFieldGeneration: number,
		expectedReadyAuditEventId: string
	): Promise<ReopenPreparation>;
	publishReopen(command: PublishReopenedEnvelopeCommand): Promise<PublishReopenedEnvelopeResult>;
}
