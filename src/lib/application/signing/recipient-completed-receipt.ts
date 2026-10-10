import type {
	ProvenRecipientCompletedReceipt,
	RecipientCompletedReceiptAction,
	RecipientCompletedReceiptEnvelopeStatus,
	RecipientCompletedReceiptLocale,
	RecipientCompletedReceiptLocator,
	RecipientCompletedReceiptStore
} from '$lib/ports/recipient-completed-receipt-store';
import { hashRecipientCapability } from '$lib/security/recipient-capability';

/**
 * Deliberately the same retention the declined receipt uses: a recipient who
 * reaches a terminal state for their own action keeps a read-only record of it
 * for the same bounded window, whichever terminal state it was.
 */
const RECEIPT_RETENTION_MILLISECONDS: number = 30 * 24 * 60 * 60 * 1000;

export interface RecipientCompletedReceipt {
	envelopeId: string;
	recipientId: string;
	recipientStatus: 'completed';
	action: RecipientCompletedReceiptAction;
	completedAt: string;
	/** Whole-envelope progress, independent of this recipient's own action. */
	envelopeStatus: RecipientCompletedReceiptEnvelopeStatus;
	envelopeCompletedByThisAction: boolean;
	locale: RecipientCompletedReceiptLocale;
}

export interface AuthorizedRecipientCompletedReceipt {
	receipt: RecipientCompletedReceipt;
	locator: RecipientCompletedReceiptLocator;
}

export interface RecipientCompletedReceiptApplicationPort {
	recoverByToken(token: string, at: Date): Promise<AuthorizedRecipientCompletedReceipt | null>;
	resolveLocator(
		locator: RecipientCompletedReceiptLocator,
		at: Date
	): Promise<AuthorizedRecipientCompletedReceipt | null>;
}

export class RecipientCompletedReceiptApplication implements RecipientCompletedReceiptApplicationPort {
	constructor(private readonly store: RecipientCompletedReceiptStore) {}

	async recoverByToken(
		token: string,
		at: Date
	): Promise<AuthorizedRecipientCompletedReceipt | null> {
		let capabilityHash: string;
		try {
			capabilityHash = await hashRecipientCapability(token);
		} catch {
			return null;
		}
		const evidence: ProvenRecipientCompletedReceipt | null =
			await this.store.findByCapabilityHash(capabilityHash);
		return authorizeEvidence(evidence, at);
	}

	async resolveLocator(
		locator: RecipientCompletedReceiptLocator,
		at: Date
	): Promise<AuthorizedRecipientCompletedReceipt | null> {
		if (!validLocator(locator)) return null;
		const evidence: ProvenRecipientCompletedReceipt | null =
			await this.store.findByIdentity(locator);
		const authorized: AuthorizedRecipientCompletedReceipt | null = authorizeEvidence(evidence, at);
		if (authorized === null) return null;
		return sameLocator(authorized.locator, locator) ? authorized : null;
	}
}

function authorizeEvidence(
	evidence: ProvenRecipientCompletedReceipt | null,
	at: Date
): AuthorizedRecipientCompletedReceipt | null {
	if (evidence === null) return null;
	const nowMilliseconds: number = at.valueOf();
	const completedMilliseconds: number = Date.parse(evidence.completedAt);
	if (!Number.isFinite(nowMilliseconds) || !Number.isFinite(completedMilliseconds)) return null;
	const expiresMilliseconds: number = completedMilliseconds + RECEIPT_RETENTION_MILLISECONDS;
	if (!Number.isSafeInteger(expiresMilliseconds) || nowMilliseconds >= expiresMilliseconds)
		return null;
	const completedAt: string = new Date(completedMilliseconds).toISOString();
	const expiresAt: string = new Date(expiresMilliseconds).toISOString();
	return {
		receipt: {
			envelopeId: evidence.envelopeId,
			recipientId: evidence.recipientId,
			recipientStatus: 'completed',
			action: evidence.action,
			completedAt,
			envelopeStatus: evidence.envelopeStatus,
			envelopeCompletedByThisAction: evidence.envelopeCompletedByThisAction,
			locale: evidence.locale
		},
		locator: {
			envelopeId: evidence.envelopeId,
			recipientId: evidence.recipientId,
			idempotencyKey: evidence.idempotencyKey,
			capabilityHash: evidence.capabilityHash,
			action: evidence.action,
			completedAt,
			expiresAt
		}
	};
}

function validLocator(locator: RecipientCompletedReceiptLocator): boolean {
	return (
		nonEmpty(locator.envelopeId) &&
		nonEmpty(locator.recipientId) &&
		nonEmpty(locator.idempotencyKey) &&
		(locator.action === 'signed' || locator.action === 'approved') &&
		/^[a-f0-9]{64}$/.test(locator.capabilityHash) &&
		Number.isFinite(Date.parse(locator.completedAt)) &&
		Number.isFinite(Date.parse(locator.expiresAt))
	);
}

function nonEmpty(value: string): boolean {
	return typeof value === 'string' && value.length > 0;
}

function sameLocator(
	left: RecipientCompletedReceiptLocator,
	right: RecipientCompletedReceiptLocator
): boolean {
	return (
		left.envelopeId === right.envelopeId &&
		left.recipientId === right.recipientId &&
		left.idempotencyKey === right.idempotencyKey &&
		left.capabilityHash === right.capabilityHash &&
		left.action === right.action &&
		left.completedAt === right.completedAt &&
		left.expiresAt === right.expiresAt
	);
}
