import type { EnvelopeStatus, RecipientRole, RecipientStatus } from '$lib/domain/envelope';

export interface RecipientSigningContext {
	envelopeId: string;
	recipientId: string;
	recipientName: string;
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
