import type { FieldType } from '$lib/domain/envelope';

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

/**
 * Canonical JSON for the signing request fingerprint. Value order is sorted
 * by field ID so equivalent submissions hash identically, and the payload
 * uses already-normalized values so durable replay can reconstruct the same
 * digest from stored `field_value.value_json` rows.
 */
export function canonicalRecipientSignFingerprint(input: {
	envelopeId: string;
	recipientId: string;
	capabilityHash: string;
	expectedFieldGeneration: number;
	values: readonly SignFingerprintValue[];
}): string {
	const values: SignFingerprintValue[] = [...input.values]
		.map((entry: SignFingerprintValue): SignFingerprintValue => ({
			fieldId: entry.fieldId,
			value: entry.value
		}))
		.sort((left: SignFingerprintValue, right: SignFingerprintValue): number =>
			left.fieldId < right.fieldId ? -1 : left.fieldId > right.fieldId ? 1 : 0
		);
	return JSON.stringify({
		envelopeId: input.envelopeId,
		recipientId: input.recipientId,
		capabilityHash: input.capabilityHash,
		expectedFieldGeneration: input.expectedFieldGeneration,
		values
	});
}

export function fingerprintValuesFromStored(
	stored: readonly StoredSignValue[]
): readonly SignFingerprintValue[] | null {
	const values: SignFingerprintValue[] = [];
	for (const row of stored) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.valueJson) as unknown;
		} catch {
			return null;
		}
		if (typeof parsed !== 'string' && typeof parsed !== 'boolean') return null;
		values.push({ fieldId: row.fieldId, value: parsed });
	}
	return values;
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
	| { outcome: 'invalid_field' };

/**
 * Durable command boundary for recipient signing completion. Implementations
 * atomically recheck capability/envelope/recipient/field-generation state,
 * insert immutable one-shot field values, complete the actor, optionally
 * release the next routing group or complete the envelope (reusing the
 * recipient.approved behavior), and append recipient.signed plus an optional
 * chained envelope.completed event.
 *
 * `prepareSign` does not take a request fingerprint: values are normalized
 * after field declarations are loaded, then the fingerprint is computed from
 * those stored-shape values so replay can reconstruct it from `field_value`.
 */
export interface RecipientSignStore {
	prepareSign(key: SignLookupKey, at: string): Promise<SignPreparation>;
	publishSign(command: PublishRecipientSignedCommand): Promise<PublishRecipientSignedResult>;
}
