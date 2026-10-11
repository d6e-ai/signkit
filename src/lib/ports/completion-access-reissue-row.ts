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
	/**
	 * The real cause of a terminal (non-retryable) failure, preserved
	 * separately from `errorCode` once attempts-exhaustion overwrites that
	 * field with the generic `delivery_attempts_exhausted` code. Null both
	 * while the generation has never terminally failed and for a row written
	 * before this column existed -- the latter is genuinely unrecoverable and
	 * is never inferred from `errorCode` or any other historical field.
	 */
	failureCauseCode: string | null;
	eligibleForReissue: boolean;
}
