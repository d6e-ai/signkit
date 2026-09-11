import type { Envelope, Recipient } from '$lib/domain/envelope';

export interface ReadyCommandKey {
	organizationId: string;
	envelopeId: string;
	actorId: string;
	idempotencyKey: string;
	requestFingerprint: string;
}

export interface ReadyAuditHead {
	sequence: number;
	eventHash: string;
}

export interface PublishedReadyEnvelope {
	envelopeId: string;
	status: 'ready';
	generation: number;
	commitSha: string;
	recipients: readonly Recipient[];
	updatedAt: string;
	auditEventId: string;
}

export type ReadyPreparation =
	| { outcome: 'ready'; envelope: Envelope; auditHead: ReadyAuditHead }
	| { outcome: 'replayed'; result: PublishedReadyEnvelope }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'immutable' }
	| { outcome: 'generation_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'empty_draft' }
	| { outcome: 'integrity_error' };

export interface PublishReadyEnvelopeCommand extends ReadyCommandKey {
	expectedGeneration: number;
	expectedCommitSha: string;
	recipients: readonly Recipient[];
	recipientsJson: string;
	updatedAt: string;
	expectedAuditSequence: number;
	previousAuditHash: string;
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
}

export type PublishReadyEnvelopeResult =
	| { outcome: 'published'; result: PublishedReadyEnvelope }
	| Exclude<ReadyPreparation, { outcome: 'ready' }>;

export interface EnvelopeReadyStore {
	prepareReady(key: ReadyCommandKey, expectedGeneration: number): Promise<ReadyPreparation>;
	publishReady(command: PublishReadyEnvelopeCommand): Promise<PublishReadyEnvelopeResult>;
}
