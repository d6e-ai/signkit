import type { FieldType } from '$lib/domain/envelope';

export {
	canonicalRecipientSignFingerprint,
	fingerprintValuesFromStored
} from '$lib/domain/commands/recipient-sign';

export interface SignLookupKey {
	capabilityHash: string;
	expectedEnvelopeId: string;
	expectedRecipientId: string;
	idempotencyKey: string;
	expectedFieldGeneration: number;
}

export interface SignCommandKey extends SignLookupKey {
	requestFingerprint: string;
}

export interface SignFingerprintValue {
	fieldId: string;
	value: string | boolean;
}

export interface StoredSignValue {
	fieldId: string;
	fieldType: FieldType;
	valueJson: string;
	valueSha256: string;
}

export interface SignAuditHead {
	sequence: number;
	eventHash: string;
}

export interface SignRoutingSnapshot {
	currentGroupOutstanding: number;
	remainingActionableOutstanding: number;
	nextRoutingOrder: number | null;
	nextGroupCount: number;
}

/**
 * A signer's own field declaration, read for value matching. Labels are
 * intentionally absent here too; this shape only carries what the command
 * boundary needs to validate submitted values.
 */
export interface SignableFieldDeclaration {
	id: string;
	fieldType: FieldType;
	required: boolean;
}

export interface PublishedRecipientSigned {
	envelopeId: string;
	recipientId: string;
	recipientRole: 'signer';
	routingOrder: number;
	sentCommitSha: string;
	envelopeStatus: 'in_progress' | 'completed';
	signedAt: string;
	auditEventId: string;
	completedAuditEventId: string | null;
	nextRoutingOrder: number | null;
}

export type SignPreparation =
	| {
			outcome: 'ready';
			envelopeId: string;
			recipientId: string;
			recipientRole: 'signer';
			routingOrder: number;
			sentCommitSha: string;
			fieldGeneration: number;
			envelopeStatus: 'sent' | 'in_progress';
			auditHead: SignAuditHead;
			routing: SignRoutingSnapshot;
			fields: readonly SignableFieldDeclaration[];
	  }
	| {
			outcome: 'existing';
			reconstructedFingerprint: string;
			result: PublishedRecipientSigned;
			storedFields: readonly SignableFieldDeclaration[];
	  }
	| { outcome: 'replayed'; result: PublishedRecipientSigned }
	| { outcome: 'not_found' }
	| { outcome: 'context_mismatch' }
	| { outcome: 'role_not_actionable' }
	| { outcome: 'idempotency_conflict' }
	| { outcome: 'field_generation_conflict' }
	| { outcome: 'audit_conflict' }
	| { outcome: 'delivery_in_flight' }
	| { outcome: 'integrity_error' };

/**
 * A validated one-shot value ready for durable storage. `valueJson` is the
 * canonical JSON encoding of the typed value (string or boolean); it is
 * written only to the field_value table and never echoed into the command's
 * audit trail, which carries `valueSha256` alone as evidence.
 */
export interface SignedFieldValue {
	fieldId: string;
	fieldType: FieldType;
	valueJson: string;
	valueSha256: string;
}

export interface PublishRecipientSignedCommand extends SignCommandKey {
	recipientRole: 'signer';
	routingOrder: number;
	expectedSentCommitSha: string;
	expectedFieldGeneration: number;
	fieldValues: readonly SignedFieldValue[];
	updatedAt: string;
	nextRoutingOrder: number | null;
	nextCapabilityExpiresAt: string | null;
	releasedDeliveryCount: number;
	expectedAuditSequence: number;
	previousAuditHash: string;
	auditEventId: string;
	auditEventHash: string;
	auditPayloadJson: string;
	completedAuditEventId: string | null;
	completedAuditEventHash: string | null;
	completedAuditPayloadJson: string | null;
}

export type PublishRecipientSignedResult =
	| { outcome: 'published'; result: PublishedRecipientSigned }
	| Exclude<SignPreparation, { outcome: 'ready' | 'existing' }>
	| { outcome: 'invalid_field' }
	/**
	 * A `sig:sha256:` field value names an exact scoped asset the orphan sweep
	 * already retired. Nothing was written; the signer must supply fresh bytes.
	 */
	| { outcome: 'signature_asset_expired' };

/**
 * Durable command boundary for recipient signing completion. Implementations
 * atomically recheck capability/envelope/recipient/field-generation state,
 * insert immutable one-shot field values, complete the actor, optionally
 * release the next routing group or complete the envelope (reusing the
 * recipient.approved behavior), and append recipient.signed plus an optional
 * chained envelope.completed event.
 *
 * Within that same atomic unit, every `sig:sha256:` signature/initials value
 * binds its exact (envelope, recipient, sha256) retention-ledger row, and a
 * retired row aborts the whole publication as `signature_asset_expired`.
 *
 * `prepareSign` does not take a request fingerprint: values are normalized
 * after field declarations are loaded, then the fingerprint is computed from
 * those stored-shape values so replay can reconstruct it from `field_value`.
 */
export interface RecipientSignStore {
	prepareSign(key: SignLookupKey, at: string): Promise<SignPreparation>;
	publishSign(command: PublishRecipientSignedCommand): Promise<PublishRecipientSignedResult>;
}
