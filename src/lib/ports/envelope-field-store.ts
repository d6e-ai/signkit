import type {
	Envelope,
	EnvelopeField,
	FieldGeometry,
	FieldType,
	MarkdownPath,
	Recipient
} from '$lib/domain/envelope';

export interface FieldCommandKey {
	envelopeId: string;
	actorType: 'user' | 'agent' | 'system';
	actorId: string;
	idempotencyKey: string;
	requestFingerprint: string;
}

export interface FieldAuditHead {
	sequence: number;
	eventHash: string;
}

/**
 * The receipt returned to callers. Labels can carry PII and are never
 * echoed back, and no audit hash, archive/storage identifier, or internal
 * command ID is exposed.
 */
export interface PublicEnvelopeField {
	id: string;
	recipientId: string;
	documentId: string | null;
	documentPath: MarkdownPath | null;
	fieldType: FieldType;
	required: boolean;
	position: number;
	geometry: FieldGeometry | null;
}

export interface PublishedFieldPlacement {
	envelopeId: string;
	generation: number;
	fieldGeneration: number;
	commitSha: string;
	fields: readonly PublicEnvelopeField[];
	updatedAt: string;
	auditEventId: string;
}

export type FieldPlacementPreparation =
	| {
			outcome: 'ready';
			envelope: Envelope;
			recipients: readonly Recipient[];
			auditHead: FieldAuditHead;
	  }
	| { outcome: 'replayed'; result: PublishedFieldPlacement }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'not_found' }
	| { outcome: 'not_ready' }
	| { outcome: 'generation_conflict' }
	| { outcome: 'field_generation_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'integrity_error' };

export interface PublishFieldPlacementCommand extends FieldCommandKey {
	expectedGeneration: number;
	expectedFieldGeneration: number;
	expectedCommitSha: string;
	fields: readonly EnvelopeField[];
	updatedAt: string;
	expectedAuditSequence: number;
	previousAuditHash: string;
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
}

export type PublishFieldPlacementResult =
	| { outcome: 'published'; result: PublishedFieldPlacement }
	| Exclude<FieldPlacementPreparation, { outcome: 'ready' }>
	| { outcome: 'invalid_recipient' };

/**
 * Durable command boundary for replace-all field placement. Implementations
 * atomically recheck generation/head/state, replace the complete field
 * projection, bump field_generation, and append the audit event.
 */
export interface EnvelopeFieldStore {
	prepareFieldPlacement(
		key: FieldCommandKey,
		expectedGeneration: number,
		expectedFieldGeneration: number
	): Promise<FieldPlacementPreparation>;
	publishFieldPlacement(
		command: PublishFieldPlacementCommand
	): Promise<PublishFieldPlacementResult>;
}
