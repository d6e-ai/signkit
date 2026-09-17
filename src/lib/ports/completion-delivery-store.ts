import type { EnvelopeStatus } from '$lib/domain/envelope';

export const MAX_COMPLETION_DELIVERY_CLAIM_BATCH: number = 25;
export const MAX_COMPLETION_DELIVERY_DISCOVERY_BATCH: number = 25;
export const COMPLETION_DELIVERY_ERROR_CODE_PATTERN: RegExp = /^[a-z][a-z0-9_]{1,64}$/;
export const FALLBACK_COMPLETION_DELIVERY_ERROR_CODE: string = 'completion_delivery_failed';

export type ClaimedCompletionDeliveryStatus = 'processing';
export type RecipientLocale = 'en' | 'ja';
export type EligibleRecipientRole = 'signer' | 'approver' | 'viewer' | 'cc';

export interface EligibleCompletionDeliveryRecipient {
	envelopeId: string;
	recipientId: string;
	recipientEmail: string;
	recipientName: string;
	recipientLocale: RecipientLocale;
	recipientRole: EligibleRecipientRole;
	envelopeTitle: string;
}

export interface EnrollCompletionDeliveryItem {
	id: string;
	envelopeId: string;
	recipientId: string;
	tokenHash: string;
	accessExpiresAt: string;
	sealedToken: string;
	sealingKeyId: string;
	sealedTokenSha256: string;
	availableAt: string;
	createdAt: string;
}

export interface ClaimCompletionDeliveriesCommand {
	claimToken: string;
	claimedAt: string;
	staleBefore: string;
	limit: number;
}

export interface ClaimedCompletionDelivery {
	deliveryId: string;
	envelopeId: string;
	recipientId: string;
	status: ClaimedCompletionDeliveryStatus;
	tokenHash: string;
	accessExpiresAt: string;
	accessRevokedAt: string | null;
	sealedToken: string | null;
	sealingKeyId: string;
	sealedTokenSha256: string;
	availableAt: string;
	attempts: number;
	lockedAt: string;
	recipientEmail: string;
	recipientName: string;
	recipientLocale: RecipientLocale;
	recipientRole: EligibleRecipientRole;
	envelopeTitle: string;
	envelopeStatus: EnvelopeStatus;
}

export interface ReadClaimedCompletionDeliveryCommand {
	deliveryId: string;
	claimToken: string;
}

export interface CompleteCompletionDeliveryCommand {
	deliveryId: string;
	claimToken: string;
	deliveredAt: string;
	providerMessageId: string;
}

export type CompleteCompletionDeliveryResult = { outcome: 'completed' } | { outcome: 'stale' };

export interface FailCompletionDeliveryCommand {
	deliveryId: string;
	claimToken: string;
	errorCode: string;
	retryable: boolean;
	nextAvailableAt: string;
	failedAt: string;
}

export type FailCompletionDeliveryResult = { outcome: 'failed' } | { outcome: 'stale' };

export interface CompletionArtifactLocator {
	envelopeId: string;
	jsonObjectKey: string;
	jsonSha256: string;
	markdownObjectKey: string;
	markdownSha256: string;
}

export const MAX_COMPLETION_DELIVERY_RESEAL_SWEEP_BATCH: number = 50;

/**
 * A non-terminal outbox row (`pending` or `failed`, never `processing`)
 * whose ciphertext is still sealed under a key other than the active one,
 * discovered by the bounded reseal sweep — never on the hot delivery-claim
 * path.
 */
export interface StaleSealedCompletionTokenRow {
	deliveryId: string;
	envelopeId: string;
	recipientId: string;
	sealedToken: string;
	sealingKeyId: string;
}

export interface FindStaleSealedCompletionTokensCommand {
	activeSealingKeyId: string;
	limit: number;
}

export interface ResealCompletionTokenCommand {
	deliveryId: string;
	previousSealingKeyId: string;
	sealedToken: string;
	sealingKeyId: string;
	sealedTokenSha256: string;
	updatedAt: string;
}

export type ResealCompletionTokenResult = { outcome: 'resealed' } | { outcome: 'stale' };

export interface CompletionDeliveryStore {
	discoverEligibleRecipients(
		limit: number
	): Promise<readonly EligibleCompletionDeliveryRecipient[]>;
	enrollDeliveries(items: readonly EnrollCompletionDeliveryItem[]): Promise<number>;
	claimPendingDeliveries(
		command: ClaimCompletionDeliveriesCommand
	): Promise<readonly ClaimedCompletionDelivery[]>;
	readClaimedDelivery(
		command: ReadClaimedCompletionDeliveryCommand
	): Promise<ClaimedCompletionDelivery | null>;
	completeDelivery(
		command: CompleteCompletionDeliveryCommand
	): Promise<CompleteCompletionDeliveryResult>;
	failDelivery(command: FailCompletionDeliveryCommand): Promise<FailCompletionDeliveryResult>;
	resolveArtifactLocatorByTokenHash(
		tokenHash: string,
		at: string
	): Promise<CompletionArtifactLocator | null>;
	findStaleSealedCompletionTokens(
		command: FindStaleSealedCompletionTokensCommand
	): Promise<readonly StaleSealedCompletionTokenRow[]>;
	resealCompletionToken(
		command: ResealCompletionTokenCommand
	): Promise<ResealCompletionTokenResult>;
}

export function boundCompletionDeliveryResealSweepLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_COMPLETION_DELIVERY_RESEAL_SWEEP_BATCH);
}

export function sanitizeCompletionDeliveryErrorCode(code: string): string {
	if (COMPLETION_DELIVERY_ERROR_CODE_PATTERN.test(code) && !isSensitiveCode(code)) {
		return code;
	}
	return FALLBACK_COMPLETION_DELIVERY_ERROR_CODE;
}

function isSensitiveCode(code: string): boolean {
	return (
		code.startsWith('skca1_') ||
		code.startsWith('skcd1_') ||
		code.startsWith('skr1_') ||
		code.startsWith('skdc1_') ||
		code.startsWith('ski1_') ||
		code.startsWith('skiod1_')
	);
}

export function boundCompletionDeliveryClaimLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_COMPLETION_DELIVERY_CLAIM_BATCH);
}

export function boundCompletionDeliveryDiscoveryLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_COMPLETION_DELIVERY_DISCOVERY_BATCH);
}
