import postgres from 'postgres';
import type { EnvelopeStatus, RecipientRole } from '$lib/domain/envelope';
import type {
	DeliveryStatus,
	DeliveryStatusStore,
	StoredDeliveryStatus,
	StoredEnvelopeDeliveryStatus
} from '$lib/ports/delivery-status-store';

interface PostgresDeliveryStatusRow {
	envelopeId: string;
	envelopeStatus: EnvelopeStatus;
	deliveryId: string | null;
	recipientId: string | null;
	recipientRole: RecipientRole | null;
	routingOrder: number | null;
	deliveryStatus: DeliveryStatus | null;
	attempts: number | null;
	availableAt: string | Date | null;
	deliveredAt: string | Date | null;
	deliveryUpdatedAt: string | Date | null;
	lastError: string | null;
}

export class PostgresDeliveryStatusStore implements DeliveryStatusStore {
	constructor(private readonly sql: ReturnType<typeof postgres>) {}

	async findEnvelopeDeliveryStatus(
		envelopeId: string
	): Promise<StoredEnvelopeDeliveryStatus | null> {
		const rows = await this.sql<PostgresDeliveryStatusRow[]>`
			SELECT envelope.id AS "envelopeId",
				envelope.status AS "envelopeStatus",
				delivery.id AS "deliveryId",
				delivery.recipient_id AS "recipientId",
				recipient.role AS "recipientRole",
				recipient.routing_order AS "routingOrder",
				delivery.status AS "deliveryStatus",
				delivery.attempts,
				delivery.available_at AS "availableAt",
				delivery.delivered_at AS "deliveredAt",
				delivery.updated_at AS "deliveryUpdatedAt",
				delivery.last_error AS "lastError"
			FROM envelope
			LEFT JOIN delivery_outbox delivery
				ON delivery.envelope_id = envelope.id
			LEFT JOIN recipient
				ON recipient.envelope_id = delivery.envelope_id
				AND recipient.id = delivery.recipient_id
			WHERE envelope.id = ${envelopeId}
			ORDER BY recipient.routing_order, delivery.created_at, delivery.id
		`;
		const first: PostgresDeliveryStatusRow | undefined = rows[0];
		if (first === undefined) return null;
		const deliveries: StoredDeliveryStatus[] = [];
		for (const row of rows) {
			if (row.deliveryId === null) continue;
			if (
				row.recipientId === null ||
				row.recipientRole === null ||
				row.routingOrder === null ||
				row.deliveryStatus === null ||
				row.attempts === null ||
				row.deliveryUpdatedAt === null
			) {
				throw new Error('Delivery status projection is inconsistent');
			}
			deliveries.push({
				deliveryId: row.deliveryId,
				recipientId: row.recipientId,
				recipientRole: row.recipientRole,
				routingOrder: row.routingOrder,
				status: row.deliveryStatus,
				attempts: row.attempts,
				availableAt: optionalIso(row.availableAt),
				deliveredAt: optionalIso(row.deliveredAt),
				updatedAt: requiredIso(row.deliveryUpdatedAt),
				lastError: row.lastError
			});
		}
		return {
			envelopeId: first.envelopeId,
			envelopeStatus: first.envelopeStatus,
			deliveries
		};
	}
}

function optionalIso(value: string | Date | null): string | null {
	return value === null ? null : requiredIso(value);
}

function requiredIso(value: string | Date): string {
	const date: Date = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.valueOf()))
		throw new Error('Invalid delivery timestamp returned by PostgreSQL');
	return date.toISOString();
}
