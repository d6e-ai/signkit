import type { EnvelopeStatus, RecipientStatus } from '$lib/domain/envelope';

export const MAX_INVITATION_CLAIM_BATCH: number = 25;
export const DELIVERY_ERROR_CODE_PATTERN: RegExp = /^[a-z][a-z0-9_]{1,64}$/;
export const FALLBACK_DELIVERY_ERROR_CODE: string = 'delivery_failed';

export type DeliveryOutboxKind = 'recipient_invitation';
export type ClaimedDeliveryStatus = 'processing';
export type RecipientLocale = 'en' | 'ja';

export interface ClaimInvitationDeliveriesCommand {
	claimToken: string;
	claimedAt: string;
	staleBefore: string;
	limit: number;
}

export interface ClaimedInvitationDelivery {
	deliveryId: string;
	envelopeId: string;
	recipientId: string;
	kind: DeliveryOutboxKind;
	status: ClaimedDeliveryStatus;
	recipientEmail: string;
	recipientName: string;
	recipientLocale: RecipientLocale;
	recipientStatus: RecipientStatus;
	envelopeTitle: string;
	envelopeStatus: EnvelopeStatus;
	capabilityHash: string;
	capabilityExpiresAt: string | null;
	reservedCapabilityExpiresAt: string | null;
	capabilityRevokedAt: string | null;
	sealedCapability: string | null;
	sealedCapabilitySha256: string;
	sealingKeyId: string;
	availableAt: string;
	attempts: number;
	lockedAt: string;
}

export interface CompleteInvitationDeliveryCommand {
	deliveryId: string;
	claimToken: string;
	deliveredAt: string;
	providerMessageId: string;
}

export interface ReadClaimedInvitationCommand {
	deliveryId: string;
	claimToken: string;
}

export interface FailInvitationDeliveryCommand {
	deliveryId: string;
	claimToken: string;
	errorCode: string;
	retryable: boolean;
	nextAvailableAt: string;
	failedAt: string;
}

export type CompleteInvitationDeliveryResult = { outcome: 'completed' } | { outcome: 'stale' };

export type FailInvitationDeliveryResult = { outcome: 'failed' } | { outcome: 'stale' };

export const MAX_DELIVERY_RESEAL_SWEEP_BATCH: number = 50;

/**
 * A non-terminal outbox row (`blocked`, `pending`, or `failed`, never
 * `processing`) whose ciphertext is still sealed under a key other than the
 * active one, discovered by the bounded reseal sweep — never on the hot
 * delivery-claim path.
 */
export interface StaleSealedCapabilityRow {
	deliveryId: string;
	envelopeId: string;
	recipientId: string;
	sealedCapability: string;
	sealingKeyId: string;
}

export interface FindStaleSealedCapabilitiesCommand {
	activeSealingKeyId: string;
	limit: number;
}

export interface ResealCapabilityCommand {
	deliveryId: string;
	previousSealingKeyId: string;
	sealedCapability: string;
	sealingKeyId: string;
	sealedCapabilitySha256: string;
	updatedAt: string;
}

export type ResealCapabilityResult = { outcome: 'resealed' } | { outcome: 'stale' };

export interface DeliveryOutboxStore {
	claimPendingInvitations(
		command: ClaimInvitationDeliveriesCommand
	): Promise<readonly ClaimedInvitationDelivery[]>;
	readClaimedInvitation(
		command: ReadClaimedInvitationCommand
	): Promise<ClaimedInvitationDelivery | null>;
	completeInvitationDelivery(
		command: CompleteInvitationDeliveryCommand
	): Promise<CompleteInvitationDeliveryResult>;
	failInvitationDelivery(
		command: FailInvitationDeliveryCommand
	): Promise<FailInvitationDeliveryResult>;
	/**
	 * Bounded discovery for the reseal sweep: rows never claimed for delivery
	 * (or claimed only long after a key rotation) can otherwise sit
	 * indefinitely on a retiring key, so this is a maintenance path
	 * independent of `claimPendingInvitations`.
	 */
	findStaleSealedCapabilities(
		command: FindStaleSealedCapabilitiesCommand
	): Promise<readonly StaleSealedCapabilityRow[]>;
	/**
	 * CAS on `previousSealingKeyId` and a non-`processing` status: a
	 * concurrent claim or terminal cleanup that has since scrubbed or
	 * mutated the row makes this a safe no-op `stale` result rather than a
	 * clobber.
	 */
	resealCapability(command: ResealCapabilityCommand): Promise<ResealCapabilityResult>;
}

export function boundDeliveryResealSweepLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_DELIVERY_RESEAL_SWEEP_BATCH);
}

export function sanitizeDeliveryErrorCode(code: string): string {
	if (DELIVERY_ERROR_CODE_PATTERN.test(code) && !isSensitiveCode(code)) return code;
	return FALLBACK_DELIVERY_ERROR_CODE;
}

function isSensitiveCode(code: string): boolean {
	return (
		code.startsWith('skr1_') ||
		code.startsWith('skdc1_') ||
		code.startsWith('ski1_') ||
		code.startsWith('skiod1_')
	);
}

export function boundInvitationClaimLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_INVITATION_CLAIM_BATCH);
}
