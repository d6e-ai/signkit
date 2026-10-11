import { hashStoredAuditEvent, sha256TextHex } from '$lib/domain/audit';
import { validStoredDecisionFollowThrough } from './recipient-decision-routing';

export interface SignFingerprintValue {
	fieldId: string;
	value: string | boolean;
}

export interface StoredSignFingerprintValue {
	fieldId: string;
	valueJson: string;
	valueSha256: string;
}

export interface RecipientSignedAuditField {
	id: string;
	fieldType: string;
	valueSha256: string;
}

export interface RecipientSignedAuditPayload {
	recipientId: string;
	role: 'signer' | string;
	routingOrder: number;
	sentCommitSha: string;
	fields: readonly RecipientSignedAuditField[];
	signedAt: string;
}

export interface RecipientSignFingerprintInput {
	envelopeId: string;
	recipientId: string;
	capabilityHash: string;
	expectedFieldGeneration: number;
	values: readonly SignFingerprintValue[];
}

export interface StoredRecipientSignedReceiptInput {
	envelopeId: string;
	recipientId: string;
	recipientRole: string;
	routingOrder: number;
	sentCommitSha: string;
	requestHash: string;
	reconstructedFingerprint: string;
	auditPayloadJson: string;
	auditEventHash: string;
	previousAuditHash: string;
	auditSequence: number;
	actorType: string;
	occurredAt: string;
	evidenceHashVersion: number | string | null;
	storedValueDigests: readonly { fieldId: string; valueSha256: string }[];
	evidenceFields: readonly RecipientSignedAuditField[];
	fieldCount: number;
	completedAuditEventId: string | null;
	completedAuditEventHash: string | null;
	completedAuditPayloadJson: string | null;
	completedEvidenceHashVersion: number | string | null;
	nextRoutingOrder: number | null;
	nextCapabilityExpiresAt: string | null;
	releasedDeliveryCount: number;
}

/**
 * Canonical JSON for the signing request fingerprint. Value order is sorted
 * by field ID so equivalent submissions hash identically, and the payload
 * uses already-normalized values so durable replay can reconstruct the same
 * digest from stored `field_value.value_json` rows.
 */
export function canonicalRecipientSignFingerprint(input: RecipientSignFingerprintInput): string {
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
	stored: readonly StoredSignFingerprintValue[]
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

export async function fingerprintRecipientSignRequest(
	input: RecipientSignFingerprintInput
): Promise<string> {
	return sha256TextHex(canonicalRecipientSignFingerprint(input));
}

export async function reconstructRecipientSignFingerprint(input: {
	envelopeId: string;
	recipientId: string;
	capabilityHash: string;
	expectedFieldGeneration: number;
	fieldCount: number;
	stored: readonly StoredSignFingerprintValue[];
}): Promise<string | null> {
	if (input.stored.length !== input.fieldCount) return null;
	for (const value of input.stored) {
		const digest: string = await sha256TextHex(value.valueJson);
		if (digest !== value.valueSha256) return null;
	}
	const values: readonly SignFingerprintValue[] | null = fingerprintValuesFromStored(input.stored);
	if (values === null) return null;
	return fingerprintRecipientSignRequest({
		envelopeId: input.envelopeId,
		recipientId: input.recipientId,
		capabilityHash: input.capabilityHash,
		expectedFieldGeneration: input.expectedFieldGeneration,
		values
	});
}

export function recipientSignedAuditPayload(
	payload: RecipientSignedAuditPayload
): RecipientSignedAuditPayload {
	const fields: RecipientSignedAuditField[] = payload.fields.map(
		(field: RecipientSignedAuditField): RecipientSignedAuditField => ({
			id: field.id,
			fieldType: field.fieldType,
			valueSha256: field.valueSha256
		})
	);
	return {
		recipientId: payload.recipientId,
		role: payload.role,
		routingOrder: payload.routingOrder,
		sentCommitSha: payload.sentCommitSha,
		fields,
		signedAt: payload.signedAt
	};
}

export function recipientSignedAuditPayloadJson(payload: RecipientSignedAuditPayload): string {
	return JSON.stringify(recipientSignedAuditPayload(payload));
}

export async function validStoredRecipientSignedReceipt(
	row: StoredRecipientSignedReceiptInput
): Promise<boolean> {
	if (row.reconstructedFingerprint !== row.requestHash) return false;
	if (
		row.evidenceFields.length !== row.fieldCount ||
		row.evidenceFields.length !== row.storedValueDigests.length
	) {
		return false;
	}
	const digestById: Map<string, string> = new Map(
		row.storedValueDigests.map(
			(value: { fieldId: string; valueSha256: string }): [string, string] => [
				value.fieldId,
				value.valueSha256
			]
		)
	);
	for (const field of row.evidenceFields) {
		if (digestById.get(field.id) !== field.valueSha256) return false;
	}

	const auditPayloadValue: RecipientSignedAuditPayload = recipientSignedAuditPayload({
		recipientId: row.recipientId,
		role: row.recipientRole,
		routingOrder: row.routingOrder,
		sentCommitSha: row.sentCommitSha,
		fields: row.evidenceFields,
		signedAt: row.occurredAt
	});
	const auditPayload: string = JSON.stringify(auditPayloadValue);
	const auditEventHash: string = await hashStoredAuditEvent(
		{
			hashVersion: row.evidenceHashVersion,
			sequence: row.auditSequence,
			eventType: 'recipient.signed',
			actorType: row.actorType,
			actorId: row.recipientId,
			occurredAt: row.occurredAt,
			payload: auditPayloadValue,
			previousHash: row.previousAuditHash
		},
		{ envelopeId: row.envelopeId }
	);
	if (auditPayload !== row.auditPayloadJson || auditEventHash !== row.auditEventHash) {
		return false;
	}
	return validStoredDecisionFollowThrough({
		envelopeId: row.envelopeId,
		recipientId: row.recipientId,
		sentCommitSha: row.sentCommitSha,
		occurredAt: row.occurredAt,
		actorType: row.actorType,
		auditEventHash: row.auditEventHash,
		auditSequence: row.auditSequence,
		completedAuditEventId: row.completedAuditEventId,
		completedAuditEventHash: row.completedAuditEventHash,
		completedAuditPayloadJson: row.completedAuditPayloadJson,
		completedEvidenceHashVersion: row.completedEvidenceHashVersion,
		nextRoutingOrder: row.nextRoutingOrder,
		nextCapabilityExpiresAt: row.nextCapabilityExpiresAt,
		releasedDeliveryCount: row.releasedDeliveryCount
	});
}
