export type RecipientDeclinedReceiptLocale = 'en' | 'ja';

export interface RecipientDeclinedReceiptLocator {
	envelopeId: string;
	recipientId: string;
	idempotencyKey: string;
	capabilityHash: string;
	declinedAt: string;
	expiresAt: string;
}

export interface ProvenRecipientDeclinedReceipt {
	envelopeId: string;
	recipientId: string;
	idempotencyKey: string;
	capabilityHash: string;
	declinedAt: string;
	locale: RecipientDeclinedReceiptLocale;
}

export type RecipientDeclinedReceiptIdentity = Pick<
	RecipientDeclinedReceiptLocator,
	'envelopeId' | 'recipientId' | 'idempotencyKey' | 'capabilityHash'
>;

export interface RecipientDeclinedReceiptStore {
	findByCapabilityHash(capabilityHash: string): Promise<ProvenRecipientDeclinedReceipt | null>;
	findByIdentity(
		identity: RecipientDeclinedReceiptIdentity
	): Promise<ProvenRecipientDeclinedReceipt | null>;
}
