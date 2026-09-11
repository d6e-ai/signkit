import type { EnvelopeStatus, RecipientRole, RecipientStatus } from '$lib/domain/envelope';

export interface RecipientSigningContext {
	organizationId: string;
	envelopeId: string;
	recipientId: string;
	recipientName: string;
	recipientLocale: 'en' | 'ja';
	recipientRole: RecipientRole;
	recipientStatus: RecipientStatus;
	envelopeTitle: string;
	envelopeStatus: EnvelopeStatus;
	expiresAt: string;
}

export interface RecipientAccessStore {
	findActiveByTokenHash(tokenHash: string, at: string): Promise<RecipientSigningContext | null>;
}
