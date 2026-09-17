import type { InstanceInvitationDeliveryLocale } from '$lib/security/instance-invitation-delivery-payload';

export const MAX_INSTANCE_INVITATION_DELIVERY_CLAIM_BATCH: number = 25;
export const MAX_INSTANCE_INVITATION_DELIVERY_ATTEMPTS: number = 10;

export interface ClaimedInstanceInvitationDelivery {
	deliveryId: string;
	invitationId: string;
	locale: InstanceInvitationDeliveryLocale;
	role: 'owner' | 'admin' | 'member';
	invitationStatus: 'pending' | 'accepted' | 'revoked';
	expiresAt: string;
	tokenHash: string;
	emailBinding: string;
	sealedPayload: string | null;
	sealedPayloadSha256: string;
	sealingKeyId: string;
	attempts: number;
}

export interface ClaimInstanceInvitationDeliveriesCommand {
	claimToken: string;
	claimedAt: string;
	staleBefore: string;
	limit: number;
}

export interface ReadClaimedInstanceInvitationDeliveryCommand {
	deliveryId: string;
	claimToken: string;
}

export interface CompleteInstanceInvitationDeliveryCommand {
	deliveryId: string;
	claimToken: string;
	deliveredAt: string;
	providerMessageId: string;
}

export interface FailInstanceInvitationDeliveryCommand {
	deliveryId: string;
	claimToken: string;
	errorCode: string;
	retryable: boolean;
	nextAvailableAt: string;
	failedAt: string;
}

export type CompleteInstanceInvitationDeliveryResult =
	{ outcome: 'completed' } | { outcome: 'stale' };
export type FailInstanceInvitationDeliveryResult = { outcome: 'failed' } | { outcome: 'stale' };

export interface InstanceInvitationDeliveryStore {
	claimPending(
		command: ClaimInstanceInvitationDeliveriesCommand
	): Promise<readonly ClaimedInstanceInvitationDelivery[]>;
	readClaimed(
		command: ReadClaimedInstanceInvitationDeliveryCommand
	): Promise<ClaimedInstanceInvitationDelivery | null>;
	complete(
		command: CompleteInstanceInvitationDeliveryCommand
	): Promise<CompleteInstanceInvitationDeliveryResult>;
	fail(
		command: FailInstanceInvitationDeliveryCommand
	): Promise<FailInstanceInvitationDeliveryResult>;
}

export function boundInstanceInvitationDeliveryClaimLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_INSTANCE_INVITATION_DELIVERY_CLAIM_BATCH);
}
