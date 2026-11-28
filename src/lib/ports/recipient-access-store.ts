import type { EnvelopeStatus, RecipientRole, RecipientStatus } from '$lib/domain/envelope';

export interface RecipientSigningContext {
	envelopeId: string;
	recipientId: string;
	recipientName: string;
	/**
	 * Optional sender-entered typed-signature suggestion for signers. Display
	 * text only, never verified identity; omitted when absent.
	 */
	signatureDisplayName?: string;
	recipientLocale: 'en' | 'ja';
	recipientRole: RecipientRole;
	recipientStatus: RecipientStatus;
	envelopeTitle: string;
	envelopeStatus: EnvelopeStatus;
	expiresAt: string;
	sentRevision: RecipientSentRevision;
}

export interface RecipientSentRevision {
	commitSha: string;
	archiveKey: string;
	archiveSha256: string;
}

export interface RecipientAccessStore {
	findActiveByTokenHash(tokenHash: string, at: string): Promise<RecipientSigningContext | null>;
}
