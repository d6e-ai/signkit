import type { EnvelopeStatus, RecipientRole } from '$lib/domain/envelope';

export type DeliveryStatus = 'blocked' | 'pending' | 'processing' | 'delivered' | 'failed';

export interface StoredDeliveryStatus {
	deliveryId: string;
	recipientId: string;
	recipientRole: RecipientRole;
	routingOrder: number;
	status: DeliveryStatus;
	attempts: number;
	availableAt: string | null;
	deliveredAt: string | null;
	updatedAt: string;
	lastError: string | null;
}

export interface StoredEnvelopeDeliveryStatus {
	envelopeId: string;
	envelopeStatus: EnvelopeStatus;
	deliveries: readonly StoredDeliveryStatus[];
}

export interface DeliveryStatusStore {
	findEnvelopeDeliveryStatus(envelopeId: string): Promise<StoredEnvelopeDeliveryStatus | null>;
}
