import { sha256TextHex } from '$lib/domain/audit';
import type { Recipient, RecipientRole } from '$lib/domain/envelope';
import {
	normalizeRecipientEmail,
	normalizeRecipientName,
	normalizeSignatureDisplayName
} from '$lib/domain/recipient-identity';

export interface ReadyCanonicalRecipient {
	email: string;
	name: string;
	role: RecipientRole;
	locale: 'en' | 'ja';
	routingOrder: number;
	/**
	 * Optional signer-only typed-signature suggestion. Never an identity claim;
	 * omitted (not null) when absent so pre-existing fingerprints are unchanged.
	 */
	signatureDisplayName?: string;
}

export interface ReadyCanonicalRequest {
	expectedGeneration: number;
	recipients: readonly ReadyCanonicalRecipient[];
}

export interface ReadyAuditRecipient {
	id: string;
	role: RecipientRole;
	routingOrder: number;
}

export interface ReadyAuditPayload {
	commitSha: string;
	generation: number;
	recipients: readonly ReadyAuditRecipient[];
}

export interface StoredReadyReceiptInput {
	envelopeId: string;
	expectedGeneration: number;
	commitSha: string;
	requestHash: string;
	auditPayloadJson: string;
}

/**
 * Normalize identity and sort by routing order, email, then role. Order is
 * part of the durable fingerprint; callers must not re-sort stored receipts.
 */
export function canonicalizeReadyRecipients(
	recipients: readonly ReadyCanonicalRecipient[]
): readonly ReadyCanonicalRecipient[] {
	const canonical: ReadyCanonicalRecipient[] = recipients.map(
		(recipient: ReadyCanonicalRecipient): ReadyCanonicalRecipient =>
			withSignatureDisplayName(
				{
					email: normalizeRecipientEmail(recipient.email),
					name: normalizeRecipientName(recipient.name),
					role: recipient.role,
					locale: recipient.locale,
					routingOrder: recipient.routingOrder
				},
				recipient.signatureDisplayName === undefined
					? undefined
					: normalizeSignatureDisplayName(recipient.signatureDisplayName)
			)
	);
	canonical.sort(
		(left: ReadyCanonicalRecipient, right: ReadyCanonicalRecipient): number =>
			left.routingOrder - right.routingOrder ||
			left.email.localeCompare(right.email) ||
			left.role.localeCompare(right.role)
	);
	return canonical;
}

export function canonicalReadyRequestJson(request: ReadyCanonicalRequest): string {
	// The key is appended only when present, so requests without a display name
	// keep the exact canonical JSON (and hash) they had before the field existed.
	const recipients: ReadyCanonicalRecipient[] = request.recipients.map(
		(recipient: ReadyCanonicalRecipient): ReadyCanonicalRecipient =>
			withSignatureDisplayName(
				{
					email: recipient.email,
					name: recipient.name,
					role: recipient.role,
					locale: recipient.locale,
					routingOrder: recipient.routingOrder
				},
				recipient.signatureDisplayName
			)
	);
	return JSON.stringify({
		expectedGeneration: request.expectedGeneration,
		recipients
	});
}

export async function fingerprintReadyRequest(request: ReadyCanonicalRequest): Promise<string> {
	return sha256TextHex(canonicalReadyRequestJson(request));
}

export function readyAuditPayloadJson(payload: ReadyAuditPayload): string {
	const recipients: ReadyAuditRecipient[] = payload.recipients.map(
		(recipient: ReadyAuditRecipient): ReadyAuditRecipient => ({
			id: recipient.id,
			role: recipient.role,
			routingOrder: recipient.routingOrder
		})
	);
	return JSON.stringify({
		commitSha: payload.commitSha,
		generation: payload.generation,
		recipients
	});
}

export async function validStoredReadyReceipt(
	row: StoredReadyReceiptInput,
	recipients: readonly Recipient[]
): Promise<boolean> {
	if (
		recipients.some(
			(recipient: Recipient): boolean =>
				recipient.envelopeId !== row.envelopeId || recipient.status !== 'pending'
		)
	) {
		return false;
	}
	const requestFingerprint: string = await fingerprintReadyRequest({
		expectedGeneration: row.expectedGeneration,
		recipients: recipients.map((recipient: Recipient): ReadyCanonicalRecipient =>
			withSignatureDisplayName(
				{
					email: recipient.email,
					name: recipient.name,
					role: recipient.role,
					locale: recipient.locale,
					routingOrder: recipient.routingOrder
				},
				recipient.signatureDisplayName
			)
		)
	});
	const expectedAuditPayload: string = readyAuditPayloadJson({
		commitSha: row.commitSha,
		generation: row.expectedGeneration,
		recipients: recipients.map((recipient: Recipient): ReadyAuditRecipient => ({
			id: recipient.id,
			role: recipient.role,
			routingOrder: recipient.routingOrder
		}))
	});
	return requestFingerprint === row.requestHash && expectedAuditPayload === row.auditPayloadJson;
}

function withSignatureDisplayName(
	recipient: ReadyCanonicalRecipient,
	signatureDisplayName: string | undefined
): ReadyCanonicalRecipient {
	return signatureDisplayName === undefined ? recipient : { ...recipient, signatureDisplayName };
}
