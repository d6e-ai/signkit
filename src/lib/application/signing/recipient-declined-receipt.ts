import type {
	ProvenRecipientDeclinedReceipt,
	RecipientDeclinedReceiptLocale,
	RecipientDeclinedReceiptLocator,
	RecipientDeclinedReceiptStore
} from '$lib/ports/recipient-declined-receipt-store';
import { hashRecipientCapability } from '$lib/security/recipient-capability';

const RECEIPT_RETENTION_MILLISECONDS: number = 30 * 24 * 60 * 60 * 1000;

export interface RecipientDeclinedReceipt {
	envelopeId: string;
	recipientId: string;
	recipientStatus: 'declined';
	envelopeStatus: 'declined';
	declinedAt: string;
	locale: RecipientDeclinedReceiptLocale;
}

export interface AuthorizedRecipientDeclinedReceipt {
	receipt: RecipientDeclinedReceipt;
	locator: RecipientDeclinedReceiptLocator;
}

export interface RecipientDeclinedReceiptApplicationPort {
	recoverByToken(token: string, at: Date): Promise<AuthorizedRecipientDeclinedReceipt | null>;
	resolveLocator(
		locator: RecipientDeclinedReceiptLocator,
		at: Date
	): Promise<AuthorizedRecipientDeclinedReceipt | null>;
}

export class RecipientDeclinedReceiptApplication implements RecipientDeclinedReceiptApplicationPort {
	constructor(private readonly store: RecipientDeclinedReceiptStore) {}

	async recoverByToken(
		token: string,
		at: Date
	): Promise<AuthorizedRecipientDeclinedReceipt | null> {
		let capabilityHash: string;
		try {
			capabilityHash = await hashRecipientCapability(token);
		} catch {
			return null;
		}
		const evidence: ProvenRecipientDeclinedReceipt | null =
			await this.store.findByCapabilityHash(capabilityHash);
		return authorizeEvidence(evidence, at);
	}

	async resolveLocator(
		locator: RecipientDeclinedReceiptLocator,
		at: Date
	): Promise<AuthorizedRecipientDeclinedReceipt | null> {
		if (!validLocator(locator)) return null;
		const evidence: ProvenRecipientDeclinedReceipt | null =
			await this.store.findByIdentity(locator);
		const authorized: AuthorizedRecipientDeclinedReceipt | null = authorizeEvidence(evidence, at);
		if (authorized === null) return null;
		return sameLocator(authorized.locator, locator) ? authorized : null;
	}
}

function authorizeEvidence(
	evidence: ProvenRecipientDeclinedReceipt | null,
	at: Date
): AuthorizedRecipientDeclinedReceipt | null {
	if (evidence === null) return null;
	const nowMilliseconds: number = at.valueOf();
	const declinedMilliseconds: number = Date.parse(evidence.declinedAt);
	if (!Number.isFinite(nowMilliseconds) || !Number.isFinite(declinedMilliseconds)) return null;
	const expiresMilliseconds: number = declinedMilliseconds + RECEIPT_RETENTION_MILLISECONDS;
	if (!Number.isSafeInteger(expiresMilliseconds) || nowMilliseconds >= expiresMilliseconds)
		return null;
	const declinedAt: string = new Date(declinedMilliseconds).toISOString();
	const expiresAt: string = new Date(expiresMilliseconds).toISOString();
	return {
		receipt: {
			envelopeId: evidence.envelopeId,
			recipientId: evidence.recipientId,
			recipientStatus: 'declined',
			envelopeStatus: 'declined',
			declinedAt,
			locale: evidence.locale
		},
		locator: {
			envelopeId: evidence.envelopeId,
			recipientId: evidence.recipientId,
			idempotencyKey: evidence.idempotencyKey,
			capabilityHash: evidence.capabilityHash,
			declinedAt,
			expiresAt
		}
	};
}

function validLocator(locator: RecipientDeclinedReceiptLocator): boolean {
	return (
		nonEmpty(locator.envelopeId) &&
		nonEmpty(locator.recipientId) &&
		nonEmpty(locator.idempotencyKey) &&
		/^[a-f0-9]{64}$/.test(locator.capabilityHash) &&
		Number.isFinite(Date.parse(locator.declinedAt)) &&
		Number.isFinite(Date.parse(locator.expiresAt))
	);
}

function nonEmpty(value: string): boolean {
	return typeof value === 'string' && value.length > 0;
}

function sameLocator(
	left: RecipientDeclinedReceiptLocator,
	right: RecipientDeclinedReceiptLocator
): boolean {
	return (
		left.envelopeId === right.envelopeId &&
		left.recipientId === right.recipientId &&
		left.idempotencyKey === right.idempotencyKey &&
		left.capabilityHash === right.capabilityHash &&
		left.declinedAt === right.declinedAt &&
		left.expiresAt === right.expiresAt
	);
}
