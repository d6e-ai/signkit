import type { Envelope } from '$lib/domain/envelope';
import type { EnvelopeStore } from './envelope-store';
import type { DraftRevisionStore, PersistedDraftRevisionLocator } from './draft-revision-store';

export type { DraftRevisionStore, PersistedDraftRevisionLocator };

export interface DraftRevisionKey {
	envelopeId: string;
	actorType: 'user' | 'agent' | 'system';
	actorId: string;
	idempotencyKey: string;
	requestFingerprint: string;
}

export interface DraftAuditHead {
	sequence: number;
	eventHash: string;
}

export interface PublishedDraftRevision {
	generation: number;
	commitSha: string;
	archiveKey: string;
	archiveSha256: string;
	updatedAt: string;
	auditEventId: string;
}

export type DraftRevisionPreparation =
	| { outcome: 'ready'; envelope: Envelope; auditHead: DraftAuditHead }
	| { outcome: 'replayed'; revision: PublishedDraftRevision }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'immutable' }
	| { outcome: 'generation_conflict' }
	| { outcome: 'integrity_error' };

export interface PublishDraftRevisionCommand extends DraftRevisionKey {
	expectedGeneration: number;
	resultingGeneration: number;
	commitSha: string;
	archiveKey: string;
	archiveSha256: string;
	updatedAt: string;
	expectedAuditSequence: number;
	previousAuditHash: string;
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
}

export type PublishDraftRevisionResult =
	| { outcome: 'published'; revision: PublishedDraftRevision }
	| { outcome: 'replayed'; revision: PublishedDraftRevision }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'immutable' }
	| { outcome: 'generation_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

/**
 * Durable command boundary for draft changes. Implementations atomically
 * publish the envelope pointer, idempotency result, and audit event.
 */
export interface DraftMutationStore extends EnvelopeStore, DraftRevisionStore {
	prepareDraftRevision(
		key: DraftRevisionKey,
		expectedGeneration: number
	): Promise<DraftRevisionPreparation>;
	publishDraftRevision(command: PublishDraftRevisionCommand): Promise<PublishDraftRevisionResult>;
}
