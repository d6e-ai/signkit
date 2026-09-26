export type RecipientCompletedReceiptLocale = 'en' | 'ja';

/**
 * The recipient action a receipt attests to. Each value maps to exactly one
 * durable command table, so a locator can never be resolved against the other
 * action's evidence.
 */
export type RecipientCompletedReceiptAction = 'signed' | 'approved';

/**
 * Whole-envelope progress, kept deliberately distinct from this recipient's own
 * action. `in_progress` means this recipient finished while other action-bearing
 * recipients are still outstanding.
 */
export type RecipientCompletedReceiptEnvelopeStatus = 'in_progress' | 'completed';

export interface RecipientCompletedReceiptLocator {
	envelopeId: string;
	recipientId: string;
	idempotencyKey: string;
	capabilityHash: string;
	action: RecipientCompletedReceiptAction;
	completedAt: string;
	expiresAt: string;
}

export interface ProvenRecipientCompletedReceipt {
	envelopeId: string;
	recipientId: string;
	idempotencyKey: string;
	capabilityHash: string;
	action: RecipientCompletedReceiptAction;
	completedAt: string;
	envelopeStatus: RecipientCompletedReceiptEnvelopeStatus;
	/**
	 * True only when this recipient's own command carried the chained
	 * `envelope.completed` event. A later recipient completing the envelope
	 * leaves this false while `envelopeStatus` already reads `completed`.
	 */
	envelopeCompletedByThisAction: boolean;
	locale: RecipientCompletedReceiptLocale;
}

export type RecipientCompletedReceiptIdentity = Pick<
	RecipientCompletedReceiptLocator,
	'envelopeId' | 'recipientId' | 'idempotencyKey' | 'capabilityHash' | 'action'
>;

export interface RecipientCompletedReceiptStore {
	findByCapabilityHash(capabilityHash: string): Promise<ProvenRecipientCompletedReceipt | null>;
	findByIdentity(
		identity: RecipientCompletedReceiptIdentity
	): Promise<ProvenRecipientCompletedReceipt | null>;
}
