import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import type { RecipientAccessStore } from '$lib/ports/recipient-access-store';
import { hashRecipientCapability, isRecipientCapability } from '$lib/security/recipient-capability';

const SIGNABLE_ENVELOPE_STATUSES = new Set<RecipientSigningContext['envelopeStatus']>([
	'sent',
	'in_progress'
]);
const ACTIONABLE_RECIPIENT_STATUSES = new Set<RecipientSigningContext['recipientStatus']>([
	'pending',
	'viewed'
]);

export interface RecipientAccessApplicationPort {
	resolve(token: string, at: string): Promise<RecipientSigningContext | null>;
}

export interface PublicRecipientAccessContext {
	envelopeId: string;
	recipientId: string;
	recipientName: string;
	role: RecipientSigningContext['recipientRole'];
	locale: RecipientSigningContext['recipientLocale'];
	recipientStatus: RecipientSigningContext['recipientStatus'];
	envelopeTitle: string;
	envelopeStatus: RecipientSigningContext['envelopeStatus'];
	expiresAt: string;
}

export function toPublicRecipientAccess(
	context: RecipientSigningContext
): PublicRecipientAccessContext {
	return {
		envelopeId: context.envelopeId,
		recipientId: context.recipientId,
		recipientName: context.recipientName,
		role: context.recipientRole,
		locale: context.recipientLocale,
		recipientStatus: context.recipientStatus,
		envelopeTitle: context.envelopeTitle,
		envelopeStatus: context.envelopeStatus,
		expiresAt: context.expiresAt
	};
}

export class RecipientAccessService implements RecipientAccessApplicationPort {
	constructor(private readonly store: RecipientAccessStore) {}

	async resolve(token: string, at: string): Promise<RecipientSigningContext | null> {
		if (!isRecipientCapability(token)) return null;
		const tokenHash: string = await hashRecipientCapability(token);
		const context: RecipientSigningContext | null = await this.store.findActiveByTokenHash(
			tokenHash,
			at
		);
		if (!context) return null;
		if (!SIGNABLE_ENVELOPE_STATUSES.has(context.envelopeStatus)) return null;
		if (!ACTIONABLE_RECIPIENT_STATUSES.has(context.recipientStatus)) return null;
		const expiresAt: number = Date.parse(context.expiresAt);
		const resolvedAt: number = Date.parse(at);
		if (!Number.isFinite(expiresAt) || !Number.isFinite(resolvedAt) || expiresAt <= resolvedAt)
			return null;
		return context;
	}
}
