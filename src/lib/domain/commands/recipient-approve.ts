import { hashStoredAuditEvent, sha256TextHex } from '$lib/domain/audit';
import { validStoredDecisionFollowThrough } from './recipient-decision-routing';

export interface RecipientApproveFingerprintInput {
	envelopeId: string;
	recipientId: string;
	capabilityHash: string;
}

export interface RecipientApprovedAuditPayload {
	recipientId: string;
	role: string;
	routingOrder: number;
	sentCommitSha: string;
	approvedAt: string;
}

export interface StoredRecipientApprovedReceiptInput {
	envelopeId: string;
	recipientId: string;
	recipientRole: string;
	routingOrder: number;
	sentCommitSha: string;
	capabilityHash: string;
	requestHash: string;
	auditPayloadJson: string;
	auditEventHash: string;
	previousAuditHash: string;
	auditSequence: number;
	actorType: string;
	occurredAt: string;
	evidenceHashVersion: number | string | null;
	completedAuditEventId: string | null;
	completedAuditEventHash: string | null;
	completedAuditPayloadJson: string | null;
	completedEvidenceHashVersion: number | string | null;
	nextRoutingOrder: number | null;
	nextCapabilityExpiresAt: string | null;
	releasedDeliveryCount: number;
}

export function canonicalRecipientApproveRequestJson(
	input: RecipientApproveFingerprintInput
): string {
	return JSON.stringify({
		envelopeId: input.envelopeId,
		recipientId: input.recipientId,
		capabilityHash: input.capabilityHash
	});
}

export async function fingerprintRecipientApproveRequest(
	input: RecipientApproveFingerprintInput
): Promise<string> {
	return sha256TextHex(canonicalRecipientApproveRequestJson(input));
}

export function recipientApprovedAuditPayload(
	payload: RecipientApprovedAuditPayload
): RecipientApprovedAuditPayload {
	return {
		recipientId: payload.recipientId,
		role: payload.role,
		routingOrder: payload.routingOrder,
		sentCommitSha: payload.sentCommitSha,
		approvedAt: payload.approvedAt
	};
}

export function recipientApprovedAuditPayloadJson(payload: RecipientApprovedAuditPayload): string {
	return JSON.stringify(recipientApprovedAuditPayload(payload));
}

export async function validStoredRecipientApprovedReceipt(
	row: StoredRecipientApprovedReceiptInput
): Promise<boolean> {
	const requestHash: string = await fingerprintRecipientApproveRequest({
		envelopeId: row.envelopeId,
		recipientId: row.recipientId,
		capabilityHash: row.capabilityHash
	});
	const auditPayloadValue: RecipientApprovedAuditPayload = recipientApprovedAuditPayload({
		recipientId: row.recipientId,
		role: row.recipientRole,
		routingOrder: row.routingOrder,
		sentCommitSha: row.sentCommitSha,
		approvedAt: row.occurredAt
	});
	const auditPayload: string = JSON.stringify(auditPayloadValue);
	const auditEventHash: string = await hashStoredAuditEvent(
		{
			hashVersion: row.evidenceHashVersion,
			sequence: row.auditSequence,
			eventType: 'recipient.approved',
			actorType: row.actorType,
			actorId: row.recipientId,
			occurredAt: row.occurredAt,
			payload: auditPayloadValue,
			previousHash: row.previousAuditHash
		},
		{ envelopeId: row.envelopeId }
	);
	if (
		requestHash !== row.requestHash ||
		auditPayload !== row.auditPayloadJson ||
		auditEventHash !== row.auditEventHash
	) {
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
