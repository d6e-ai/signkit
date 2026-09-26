import type {
	ProvenRecipientCompletedReceipt,
	RecipientCompletedReceiptAction,
	RecipientCompletedReceiptEnvelopeStatus,
	RecipientCompletedReceiptLocale
} from '$lib/ports/recipient-completed-receipt-store';
import { hashStoredAuditEvent } from '$lib/domain/audit';

/**
 * One durable completed-action command row joined to the projection and audit
 * evidence that has to corroborate it. Every field here is read from the
 * database; nothing is supplied by a client. The signer variant deliberately
 * carries only SHA-256 digests of field values — `field_value.value_json` is
 * never selected, so no signature content can reach a receipt.
 */
export interface RecipientCompletedReceiptEvidenceRow {
	envelopeId: string;
	recipientId: string;
	recipientRole: string;
	routingOrder: number | string;
	actorType: string;
	actorId: string;
	idempotencyKey: string;
	requestHash: string;
	capabilityHash: string;
	sentCommitSha: string;
	updatedAt: Date | string;
	nextRoutingOrder: number | string | null;
	nextCapabilityExpiresAt: Date | string | null;
	releasedDeliveryCount: number | string;
	auditEventId: string;
	auditSequence: number | string;
	previousAuditHash: string;
	auditEventHash: string;
	auditPayloadJson: string;
	completedAuditEventId: string | null;
	completedAuditEventHash: string | null;
	completedAuditPayloadJson: string | null;
	/** Signer commands only: the `{id, fieldType, valueSha256}` receipt digests. */
	fieldValuesJson: string | null;
	fieldCount: number | string | null;
	/** Signer commands only: the same digests re-read from the immutable rows. */
	durableFieldDigestsJson: string | null;
	recipientStatus: string;
	recipientProjectedRole: string;
	recipientLocale: string;
	recipientCapabilityHash: string | null;
	recipientCapabilityRevokedAt: Date | string | null;
	envelopeStatus: string;
	envelopeSentCommitSha: string | null;
	envelopeRepositoryHead: string | null;
	evidenceEventId: string | null;
	evidenceEnvelopeId: string | null;
	evidenceSequence: number | string | null;
	evidenceEventType: string | null;
	evidenceActorType: string | null;
	evidenceActorId: string | null;
	evidencePayloadJson: string | null;
	evidencePreviousHash: string | null;
	evidenceEventHash: string | null;
	evidenceOccurredAt: Date | string | null;
	evidenceHashVersion: number | string | null;
	previousEnvelopeId: string | null;
	previousSequence: number | string | null;
	previousEventHash: string | null;
	completionEventId: string | null;
	completionEnvelopeId: string | null;
	completionSequence: number | string | null;
	completionEventType: string | null;
	completionActorType: string | null;
	completionActorId: string | null;
	completionPayloadJson: string | null;
	completionPreviousHash: string | null;
	completionEventHash: string | null;
	completionOccurredAt: Date | string | null;
	completionHashVersion: number | string | null;
}

interface FieldDigest {
	id: string;
	fieldType: string;
	valueSha256: string;
}

const FIELD_TYPES: readonly string[] = ['signature', 'initials', 'text', 'date', 'checkbox'];
const SHA256_HEX_PATTERN: RegExp = /^[0-9a-f]{64}$/;
const MAX_FIELD_COUNT: number = 50;
const ACTION_ROLE: Readonly<Record<RecipientCompletedReceiptAction, string>> = {
	signed: 'signer',
	approved: 'approver'
};
const ACTION_EVENT_TYPE: Readonly<Record<RecipientCompletedReceiptAction, string>> = {
	signed: 'recipient.signed',
	approved: 'recipient.approved'
};
const COMPLETION_EVENT_TYPE: string = 'envelope.completed';

/**
 * Authorizes a read-only completed-action receipt from durable evidence alone.
 * Returns `null` — never a partial receipt — as soon as any projection,
 * command, field-digest, or audit-chain fact fails to corroborate the others.
 */
export async function proveRecipientCompletedReceipt(
	row: RecipientCompletedReceiptEvidenceRow,
	action: RecipientCompletedReceiptAction
): Promise<ProvenRecipientCompletedReceipt | null> {
	const completedAt: string | null = isoTimestamp(row.updatedAt);
	if (completedAt === null || !validProjection(row, action, completedAt)) return null;
	const auditSequence: number = Number(row.auditSequence);
	if (!Number.isSafeInteger(auditSequence) || auditSequence <= 1) return null;
	if (!validRoutingProjection(row)) return null;
	if (!validAuditChain(row, action, auditSequence, completedAt)) return null;

	const envelopeCompletedByThisAction: boolean = row.completedAuditEventId !== null;
	const envelopeStatus: RecipientCompletedReceiptEnvelopeStatus =
		row.envelopeStatus === 'completed' ? 'completed' : 'in_progress';
	if (envelopeCompletedByThisAction && envelopeStatus !== 'completed') return null;

	const payload: unknown = await provenAuditPayload(row, action, completedAt);
	if (payload === null) return null;
	const auditEventHash: string = await hashStoredAuditEvent(
		{
			hashVersion: row.evidenceHashVersion,
			sequence: auditSequence,
			eventType: ACTION_EVENT_TYPE[action],
			actorType: 'recipient',
			actorId: row.recipientId,
			occurredAt: completedAt,
			payload,
			previousHash: row.previousAuditHash
		},
		{ envelopeId: row.envelopeId }
	);
	if (JSON.stringify(payload) !== row.auditPayloadJson) return null;
	if (auditEventHash !== row.auditEventHash) return null;
	// The approve command's request hash is a pure function of durable columns,
	// so it is re-derived. A sign command's request hash covers the submitted
	// plaintext values, which this path must never read; the field digests plus
	// the audit chain carry that binding instead. See the completed-action
	// receipt ADR.
	if (action === 'approved') {
		const requestHash: string = await sha256(
			JSON.stringify({
				envelopeId: row.envelopeId,
				recipientId: row.recipientId,
				capabilityHash: row.capabilityHash
			})
		);
		if (requestHash !== row.requestHash) return null;
	}
	if (!(await validCompletionEvidence(row, auditSequence, completedAt, auditEventHash))) {
		return null;
	}

	return {
		envelopeId: row.envelopeId,
		recipientId: row.recipientId,
		idempotencyKey: row.idempotencyKey,
		capabilityHash: row.capabilityHash,
		action,
		completedAt,
		envelopeStatus,
		envelopeCompletedByThisAction,
		locale: row.recipientLocale as RecipientCompletedReceiptLocale
	};
}

function validProjection(
	row: RecipientCompletedReceiptEvidenceRow,
	action: RecipientCompletedReceiptAction,
	completedAt: string
): boolean {
	const routingOrder: number = Number(row.routingOrder);
	return (
		row.recipientRole === ACTION_ROLE[action] &&
		row.recipientProjectedRole === ACTION_ROLE[action] &&
		Number.isSafeInteger(routingOrder) &&
		routingOrder >= 1 &&
		routingOrder <= 1000 &&
		row.actorType === 'recipient' &&
		row.actorId === row.recipientId &&
		row.recipientStatus === 'completed' &&
		(row.recipientLocale === 'en' || row.recipientLocale === 'ja') &&
		row.recipientCapabilityHash === row.capabilityHash &&
		sameTimestamp(row.recipientCapabilityRevokedAt, completedAt) &&
		// Voided and expired envelopes deliberately fall through to the generic
		// invalid response rather than surfacing a receipt.
		(row.envelopeStatus === 'in_progress' || row.envelopeStatus === 'completed') &&
		row.sentCommitSha.length > 0 &&
		row.envelopeSentCommitSha === row.sentCommitSha &&
		row.envelopeRepositoryHead === row.sentCommitSha
	);
}

/**
 * Re-checks the command table's own routing/completion pairings. A row that no
 * longer satisfies them has been rewritten outside the publish trigger.
 */
function validRoutingProjection(row: RecipientCompletedReceiptEvidenceRow): boolean {
	const releasedDeliveryCount: number = Number(row.releasedDeliveryCount);
	if (!Number.isSafeInteger(releasedDeliveryCount) || releasedDeliveryCount < 0) return false;
	const completionColumns: readonly (string | null)[] = [
		row.completedAuditEventId,
		row.completedAuditEventHash,
		row.completedAuditPayloadJson
	];
	const completionPresent: boolean = completionColumns.every(
		(value: string | null): boolean => value !== null
	);
	if (
		!completionPresent &&
		completionColumns.some((value: string | null): boolean => value !== null)
	)
		return false;
	const releasedNextGroup: boolean = row.nextRoutingOrder !== null;
	if (releasedNextGroup) {
		const nextRoutingOrder: number = Number(row.nextRoutingOrder);
		if (
			completionPresent ||
			row.nextCapabilityExpiresAt === null ||
			releasedDeliveryCount <= 0 ||
			!Number.isSafeInteger(nextRoutingOrder) ||
			nextRoutingOrder <= Number(row.routingOrder) ||
			nextRoutingOrder > 1000
		) {
			return false;
		}
		return true;
	}
	return row.nextCapabilityExpiresAt === null && releasedDeliveryCount === 0;
}

function validAuditChain(
	row: RecipientCompletedReceiptEvidenceRow,
	action: RecipientCompletedReceiptAction,
	auditSequence: number,
	completedAt: string
): boolean {
	return (
		row.evidenceEventId === row.auditEventId &&
		row.evidenceEnvelopeId === row.envelopeId &&
		Number(row.evidenceSequence) === auditSequence &&
		row.evidenceEventType === ACTION_EVENT_TYPE[action] &&
		row.evidenceActorType === 'recipient' &&
		row.evidenceActorId === row.recipientId &&
		row.evidencePayloadJson === row.auditPayloadJson &&
		row.evidencePreviousHash === row.previousAuditHash &&
		row.evidenceEventHash === row.auditEventHash &&
		sameTimestamp(row.evidenceOccurredAt, completedAt) &&
		row.previousEnvelopeId === row.envelopeId &&
		Number(row.previousSequence) === auditSequence - 1 &&
		row.previousEventHash === row.previousAuditHash
	);
}

/**
 * When — and only when — this command carried the chained `envelope.completed`
 * event, that event must exist at `sequence + 1`, chain from this action's
 * hash, and re-hash to the stored value.
 */
async function validCompletionEvidence(
	row: RecipientCompletedReceiptEvidenceRow,
	auditSequence: number,
	completedAt: string,
	auditEventHash: string
): Promise<boolean> {
	if (row.completedAuditEventId === null) return row.completionEventId === null;
	const payload = { sentCommitSha: row.sentCommitSha, completedAt };
	if (JSON.stringify(payload) !== row.completedAuditPayloadJson) return false;
	const completionEventHash: string = await hashStoredAuditEvent(
		{
			hashVersion: row.completionHashVersion,
			sequence: auditSequence + 1,
			eventType: COMPLETION_EVENT_TYPE,
			actorType: 'recipient',
			actorId: row.recipientId,
			occurredAt: completedAt,
			payload,
			previousHash: auditEventHash
		},
		{ envelopeId: row.envelopeId }
	);
	return (
		completionEventHash === row.completedAuditEventHash &&
		row.completionEventId === row.completedAuditEventId &&
		row.completionEnvelopeId === row.envelopeId &&
		Number(row.completionSequence) === auditSequence + 1 &&
		row.completionEventType === COMPLETION_EVENT_TYPE &&
		row.completionActorType === 'recipient' &&
		row.completionActorId === row.recipientId &&
		row.completionPayloadJson === row.completedAuditPayloadJson &&
		row.completionPreviousHash === row.auditEventHash &&
		row.completionEventHash === row.completedAuditEventHash &&
		sameTimestamp(row.completionOccurredAt, completedAt)
	);
}

/**
 * Rebuilds the action's audit payload from durable columns so the stored JSON
 * and hash are compared against a value derived from evidence, never parsed
 * from the stored payload itself.
 */
async function provenAuditPayload(
	row: RecipientCompletedReceiptEvidenceRow,
	action: RecipientCompletedReceiptAction,
	completedAt: string
): Promise<unknown> {
	const base = {
		recipientId: row.recipientId,
		role: ACTION_ROLE[action],
		routingOrder: Number(row.routingOrder),
		sentCommitSha: row.sentCommitSha
	};
	if (action === 'approved') {
		if (row.fieldValuesJson !== null || row.durableFieldDigestsJson !== null) return null;
		return { ...base, approvedAt: completedAt };
	}
	const fields: readonly FieldDigest[] | null = provenFieldDigests(row);
	if (fields === null) return null;
	return { ...base, fields, signedAt: completedAt };
}

/**
 * Accepts the signer command's declared digests only when they are canonical
 * and exactly reproduce the immutable `field_value` rows for this recipient,
 * each owned by an `envelope_field` of the same type in the same envelope.
 */
function provenFieldDigests(
	row: RecipientCompletedReceiptEvidenceRow
): readonly FieldDigest[] | null {
	const declared: readonly FieldDigest[] | null = parseFieldDigests(row.fieldValuesJson);
	const durable: readonly FieldDigest[] | null = parseFieldDigests(row.durableFieldDigestsJson);
	if (declared === null || durable === null) return null;
	const fieldCount: number = Number(row.fieldCount);
	if (!Number.isSafeInteger(fieldCount) || fieldCount < 0 || fieldCount > MAX_FIELD_COUNT) {
		return null;
	}
	if (declared.length !== fieldCount || durable.length !== fieldCount) return null;
	for (let index: number = 0; index < declared.length; index += 1) {
		if (
			declared[index].id !== durable[index].id ||
			declared[index].fieldType !== durable[index].fieldType ||
			declared[index].valueSha256 !== durable[index].valueSha256
		) {
			return null;
		}
	}
	return declared;
}

function parseFieldDigests(value: string | null): readonly FieldDigest[] | null {
	if (value === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length > MAX_FIELD_COUNT) return null;
	const digests: FieldDigest[] = [];
	for (const entry of parsed) {
		if (!isRecord(entry)) return null;
		const keys: string[] = Object.keys(entry).sort();
		if (
			keys.length !== 3 ||
			keys[0] !== 'fieldType' ||
			keys[1] !== 'id' ||
			keys[2] !== 'valueSha256'
		)
			return null;
		if (typeof entry.id !== 'string' || entry.id.length === 0) return null;
		if (typeof entry.fieldType !== 'string' || !FIELD_TYPES.includes(entry.fieldType)) return null;
		if (typeof entry.valueSha256 !== 'string' || !SHA256_HEX_PATTERN.test(entry.valueSha256))
			return null;
		digests.push({ id: entry.id, fieldType: entry.fieldType, valueSha256: entry.valueSha256 });
	}
	// The publishing command sorts by field ID; a row that is unsorted or holds a
	// duplicate ID was not written by it.
	for (let index: number = 1; index < digests.length; index += 1) {
		if (digests[index - 1].id >= digests[index].id) return null;
	}
	return digests;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameTimestamp(left: Date | string | null, right: Date | string): boolean {
	const leftTimestamp: string | null = isoTimestamp(left);
	const rightTimestamp: string | null = isoTimestamp(right);
	return leftTimestamp !== null && rightTimestamp !== null && leftTimestamp === rightTimestamp;
}

function isoTimestamp(value: Date | string | null): string | null {
	if (value === null) return null;
	const milliseconds: number = value instanceof Date ? value.valueOf() : Date.parse(value);
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

async function sha256(value: string): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
