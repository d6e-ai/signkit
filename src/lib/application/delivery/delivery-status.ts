import { sanitizeDeliveryErrorCode } from '$lib/ports/delivery-outbox-store';
import type {
	DeliveryStatusStore,
	StoredEnvelopeDeliveryStatus
} from '$lib/ports/delivery-status-store';

export interface PublicDeliveryStatus {
	recipientId: string;
	recipientRole: StoredEnvelopeDeliveryStatus['deliveries'][number]['recipientRole'];
	routingOrder: number;
	status: StoredEnvelopeDeliveryStatus['deliveries'][number]['status'];
	attempts: number;
	availableAt: string | null;
	deliveredAt: string | null;
	updatedAt: string;
	errorCode: string | null;
}

export interface PublicEnvelopeDeliveryStatus {
	envelopeId: string;
	envelopeStatus: StoredEnvelopeDeliveryStatus['envelopeStatus'];
	deliveries: readonly PublicDeliveryStatus[];
}

export class DeliveryStatusService {
	constructor(private readonly store: DeliveryStatusStore) {}

	async find(
		organizationId: string,
		envelopeId: string
	): Promise<PublicEnvelopeDeliveryStatus | null> {
		const stored: StoredEnvelopeDeliveryStatus | null = await this.store.findEnvelopeDeliveryStatus(
			organizationId,
			envelopeId
		);
		if (stored === null) return null;
		return {
			envelopeId: stored.envelopeId,
			envelopeStatus: stored.envelopeStatus,
			deliveries: stored.deliveries.map((delivery) => ({
				recipientId: delivery.recipientId,
				recipientRole: delivery.recipientRole,
				routingOrder: delivery.routingOrder,
				status: delivery.status,
				attempts: delivery.attempts,
				availableAt: delivery.availableAt,
				deliveredAt: delivery.deliveredAt,
				updatedAt: delivery.updatedAt,
				errorCode:
					delivery.lastError === null ? null : sanitizeDeliveryErrorCode(delivery.lastError)
			}))
		};
	}
}
