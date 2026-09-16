import type {
	ProvenRecipientDeclinedReceipt,
	RecipientDeclinedReceiptLocale
} from '$lib/ports/recipient-declined-receipt-store';
import { hashStoredAuditEvent } from '$lib/domain/audit';

export interface RecipientDeclinedReceiptEvidenceRow {
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
	auditEventId: string;
	auditSequence: number | string;
	previousAuditHash: string;
	auditEventHash: string;
	auditPayloadJson: string;
	revocationEvidenceVersion: number | string;
	revokedRecipientIdsJson: string;
	revokedRecipientCount: number | string;
	projectionRevokedRecipientIdsJson: string;
	projectionHasRevocableRecipient: boolean | number;
	projectionHasUnsafeDelivery: boolean | number;
	recipientStatus: string;
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
}

export async function proveRecipientDeclinedReceipt(
	row: RecipientDeclinedReceiptEvidenceRow
): Promise<ProvenRecipientDeclinedReceipt | null> {
	const declinedAt: string | null = isoTimestamp(row.updatedAt);
	if (declinedAt === null || !validProjection(row, declinedAt)) return null;
	const auditSequence: number = Number(row.auditSequence);
	if (!Number.isSafeInteger(auditSequence) || auditSequence <= 1) return null;
	if (!validAuditChain(row, auditSequence, declinedAt)) return null;

	const revokedRecipientIds: readonly string[] | null = parseRevocationEvidence(row);
	if (revokedRecipientIds === null) return null;
	if (!validTerminalProjection(row, revokedRecipientIds)) return null;
	const baseAuditPayload = {
		recipientId: row.recipientId,
		role: row.recipientRole,
		routingOrder: Number(row.routingOrder),
		sentCommitSha: row.sentCommitSha,
		declinedAt
	};
	const auditPayloadValue =
		Number(row.revocationEvidenceVersion) === 1
			? baseAuditPayload
			: {
					...baseAuditPayload,
					revokedCapabilities: {
						reason: 'envelope_declined',
						recipientIds: revokedRecipientIds
					}
				};
	const requestHash: string = await sha256(
		JSON.stringify({
			envelopeId: row.envelopeId,
			recipientId: row.recipientId,
			capabilityHash: row.capabilityHash
		})
	);
	const auditPayloadJson: string = JSON.stringify(auditPayloadValue);
	const auditEventHash: string = await hashStoredAuditEvent(
		{
			hashVersion: row.evidenceHashVersion,
			sequence: auditSequence,
			eventType: 'recipient.declined',
			actorType: 'recipient',
			actorId: row.recipientId,
			occurredAt: declinedAt,
			payload: auditPayloadValue,
			previousHash: row.previousAuditHash
		},
		{ envelopeId: row.envelopeId }
	);
	if (
		requestHash !== row.requestHash ||
		auditPayloadJson !== row.auditPayloadJson ||
		auditEventHash !== row.auditEventHash
	) {
		return null;
	}

	return {
		envelopeId: row.envelopeId,
		recipientId: row.recipientId,
		idempotencyKey: row.idempotencyKey,
		capabilityHash: row.capabilityHash,
		declinedAt,
		locale: row.recipientLocale as RecipientDeclinedReceiptLocale
	};
}

function validTerminalProjection(
	row: RecipientDeclinedReceiptEvidenceRow,
	revokedRecipientIds: readonly string[]
): boolean {
	if (Boolean(row.projectionHasRevocableRecipient) || Boolean(row.projectionHasUnsafeDelivery)) {
		return false;
	}
	if (Number(row.revocationEvidenceVersion) === 1) return true;
	try {
		const value: unknown = JSON.parse(row.projectionRevokedRecipientIdsJson);
		if (
			!Array.isArray(value) ||
			!value.every((recipientId: unknown): recipientId is string => typeof recipientId === 'string')
		) {
			return false;
		}
		return sameStringArray(revokedRecipientIds, value);
	} catch {
		return false;
	}
}

function validProjection(row: RecipientDeclinedReceiptEvidenceRow, declinedAt: string): boolean {
	const routingOrder: number = Number(row.routingOrder);
	return (
		(row.recipientRole === 'signer' || row.recipientRole === 'approver') &&
		Number.isSafeInteger(routingOrder) &&
		routingOrder >= 1 &&
		routingOrder <= 1000 &&
		row.actorType === 'recipient' &&
		row.actorId === row.recipientId &&
		row.recipientStatus === 'declined' &&
		(row.recipientLocale === 'en' || row.recipientLocale === 'ja') &&
		row.recipientCapabilityHash === row.capabilityHash &&
		sameTimestamp(row.recipientCapabilityRevokedAt, declinedAt) &&
		row.envelopeStatus === 'declined' &&
		row.sentCommitSha.length > 0 &&
		row.envelopeSentCommitSha === row.sentCommitSha &&
		row.envelopeRepositoryHead === row.sentCommitSha
	);
}

function validAuditChain(
	row: RecipientDeclinedReceiptEvidenceRow,
	auditSequence: number,
	declinedAt: string
): boolean {
	return (
		row.evidenceEventId === row.auditEventId &&
		row.evidenceEnvelopeId === row.envelopeId &&
		Number(row.evidenceSequence) === auditSequence &&
		row.evidenceEventType === 'recipient.declined' &&
		row.evidenceActorType === 'recipient' &&
		row.evidenceActorId === row.recipientId &&
		row.evidencePayloadJson === row.auditPayloadJson &&
		row.evidencePreviousHash === row.previousAuditHash &&
		row.evidenceEventHash === row.auditEventHash &&
		sameTimestamp(row.evidenceOccurredAt, declinedAt) &&
		row.previousEnvelopeId === row.envelopeId &&
		Number(row.previousSequence) === auditSequence - 1 &&
		row.previousEventHash === row.previousAuditHash
	);
}

function parseRevocationEvidence(
	row: RecipientDeclinedReceiptEvidenceRow
): readonly string[] | null {
	const version: number = Number(row.revocationEvidenceVersion);
	const count: number = Number(row.revokedRecipientCount);
	if (version === 1) {
		return row.revokedRecipientIdsJson === '[]' && count === 0 ? [] : null;
	}
	if (version !== 2 || !Number.isSafeInteger(count) || count < 0) return null;
	try {
		const value: unknown = JSON.parse(row.revokedRecipientIdsJson);
		if (
			!Array.isArray(value) ||
			!value.every((recipientId: unknown): recipientId is string => typeof recipientId === 'string')
		) {
			return null;
		}
		const recipientIds: string[] = [...value];
		const sortedRecipientIds: string[] = [...recipientIds].sort();
		return recipientIds.length === count &&
			sameStringArray(recipientIds, sortedRecipientIds) &&
			new Set(recipientIds).size === recipientIds.length
			? recipientIds
			: null;
	} catch {
		return null;
	}
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((value: string, index: number): boolean => value === right[index])
	);
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
