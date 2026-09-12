export type RecipientDeclinedReceiptLocale = 'en' | 'ja';

export interface RecipientDeclinedReceiptLocator {
	organizationId: string;
	envelopeId: string;
	recipientId: string;
	idempotencyKey: string;
	capabilityHash: string;
	declinedAt: string;
	expiresAt: string;
}

export interface ProvenRecipientDeclinedReceipt {
	organizationId: string;
	envelopeId: string;
	recipientId: string;
	idempotencyKey: string;
	capabilityHash: string;
	declinedAt: string;
	locale: RecipientDeclinedReceiptLocale;
}

export type RecipientDeclinedReceiptIdentity = Pick<
	RecipientDeclinedReceiptLocator,
	'organizationId' | 'envelopeId' | 'recipientId' | 'idempotencyKey' | 'capabilityHash'
>;

export interface RecipientDeclinedReceiptStore {
	findByCapabilityHash(capabilityHash: string): Promise<ProvenRecipientDeclinedReceipt | null>;
	findByIdentity(
		identity: RecipientDeclinedReceiptIdentity
	): Promise<ProvenRecipientDeclinedReceipt | null>;
}
