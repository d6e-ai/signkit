import type { EnvelopeStatus, RecipientRole } from '$lib/domain/envelope';
import type {
	DeliveryStatus,
	DeliveryStatusStore,
	StoredDeliveryStatus,
	StoredEnvelopeDeliveryStatus
} from '$lib/ports/delivery-status-store';

interface D1DeliveryStatusRow {
	envelope_id: string;
	envelope_status: EnvelopeStatus;
	delivery_id: string | null;
	recipient_id: string | null;
	recipient_role: RecipientRole | null;
	routing_order: number | null;
	delivery_status: DeliveryStatus | null;
	attempts: number | null;
	available_at: string | null;
	delivered_at: string | null;
	delivery_updated_at: string | null;
	last_error: string | null;
}

export class D1DeliveryStatusStore implements DeliveryStatusStore {
	constructor(private readonly database: D1Database) {}

	async findEnvelopeDeliveryStatus(
		organizationId: string,
		envelopeId: string
	): Promise<StoredEnvelopeDeliveryStatus | null> {
		const result: D1Result<D1DeliveryStatusRow> = await this.database
			.prepare(D1_DELIVERY_STATUS_QUERY)
			.bind(organizationId, envelopeId)
			.all<D1DeliveryStatusRow>();
		const first: D1DeliveryStatusRow | undefined = result.results[0];
		if (first === undefined) return null;
		const deliveries: StoredDeliveryStatus[] = [];
		for (const row of result.results) {
			if (row.delivery_id === null) continue;
			if (
				row.recipient_id === null ||
				row.recipient_role === null ||
				row.routing_order === null ||
				row.delivery_status === null ||
				row.attempts === null ||
				row.delivery_updated_at === null
			) {
				throw new Error('Delivery status projection is inconsistent');
			}
			deliveries.push({
				deliveryId: row.delivery_id,
				recipientId: row.recipient_id,
				recipientRole: row.recipient_role,
				routingOrder: row.routing_order,
				status: row.delivery_status,
				attempts: row.attempts,
				availableAt: row.available_at,
				deliveredAt: row.delivered_at,
				updatedAt: row.delivery_updated_at,
				lastError: row.last_error
			});
		}
		return {
			envelopeId: first.envelope_id,
			envelopeStatus: first.envelope_status,
			deliveries
		};
	}
}

export const D1_DELIVERY_STATUS_QUERY: string = `SELECT envelope.id AS envelope_id,
		envelope.status AS envelope_status,
		delivery.id AS delivery_id,
		delivery.recipient_id,
		recipient.role AS recipient_role,
		recipient.routing_order,
		delivery.status AS delivery_status,
		delivery.attempts,
		delivery.available_at,
		delivery.delivered_at,
		delivery.updated_at AS delivery_updated_at,
		delivery.last_error
	FROM envelope
	LEFT JOIN delivery_outbox delivery
		ON delivery.organization_id = envelope.organization_id
		AND delivery.envelope_id = envelope.id
	LEFT JOIN recipient
		ON recipient.organization_id = delivery.organization_id
		AND recipient.envelope_id = delivery.envelope_id
		AND recipient.id = delivery.recipient_id
	WHERE envelope.organization_id = ?
		AND envelope.id = ?
	ORDER BY recipient.routing_order, delivery.created_at, delivery.id`;
