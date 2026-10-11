import type { EligibleRecipientRole } from './completion-delivery-store';

export interface CurrentCompletionDeliveryRow {
	deliveryId: string;
	recipientId: string;
	recipientRole: EligibleRecipientRole;
	generation: number;
	status: 'pending' | 'processing' | 'delivered' | 'failed';
	attempts: number;
	accessExpiresAt: string;
	accessRevokedAt: string | null;
	deliveredAt: string | null;
	failedAt: string | null;
	errorCode: string | null;
	eligibleForReissue: boolean;
}
