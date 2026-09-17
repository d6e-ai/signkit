import { describe, expect, it, vi } from 'vitest';
import { D1DeliveryStatusStore } from './d1-delivery-status-store';

interface StatementRecord {
	sql: string;
	bindings: readonly unknown[];
}

function fakeD1(rows: readonly object[]): { database: D1Database; record: StatementRecord } {
	const record: StatementRecord = { sql: '', bindings: [] };
	const prepare = vi.fn((sql: string): D1PreparedStatement => {
		record.sql = sql;
		const statement = {
			bind: (...bindings: unknown[]): D1PreparedStatement => {
				record.bindings = bindings;
				return statement as unknown as D1PreparedStatement;
			},
			all: async (): Promise<object> => ({ success: true, results: rows })
		};
		return statement as unknown as D1PreparedStatement;
	});
	return { database: { prepare } as unknown as D1Database, record };
}

describe('D1DeliveryStatusStore', () => {
	it('maps ordered delivery metadata without identity fields', async () => {
		const fake = fakeD1([
			{
				envelope_id: 'envelope-1',
				envelope_status: 'sent',
				delivery_id: 'delivery-1',
				recipient_id: 'recipient-1',
				recipient_role: 'signer',
				routing_order: 1,
				delivery_status: 'pending',
				attempts: 0,
				available_at: '2026-09-12T00:00:00.000Z',
				delivered_at: null,
				delivery_updated_at: '2026-09-12T00:00:00.000Z',
				last_error: null
			}
		]);
		const result = await new D1DeliveryStatusStore(fake.database).findEnvelopeDeliveryStatus(
			'envelope-1'
		);

		expect(result).toMatchObject({
			envelopeId: 'envelope-1',
			deliveries: [{ recipientId: 'recipient-1', status: 'pending' }]
		});
		expect(fake.record.bindings).toEqual(['envelope-1']);
		expect(fake.record.sql).toContain('delivery.envelope_id = envelope.id');
		expect(fake.record.sql).toContain('recipient.envelope_id = delivery.envelope_id');
		expect(fake.record.sql).toContain('WHERE envelope.id = ?');
		expect(fake.record.sql).not.toMatch(/recipient\.email|recipient\.name/);
	});

	it('distinguishes a missing envelope from an envelope with no delivery rows', async () => {
		const missing = fakeD1([]);
		const empty = fakeD1([
			{
				envelope_id: 'envelope-1',
				envelope_status: 'draft',
				delivery_id: null,
				recipient_id: null,
				recipient_role: null,
				routing_order: null,
				delivery_status: null,
				attempts: null,
				available_at: null,
				delivered_at: null,
				delivery_updated_at: null,
				last_error: null
			}
		]);

		await expect(
			new D1DeliveryStatusStore(missing.database).findEnvelopeDeliveryStatus('missing')
		).resolves.toBeNull();
		await expect(
			new D1DeliveryStatusStore(empty.database).findEnvelopeDeliveryStatus('envelope-1')
		).resolves.toMatchObject({ deliveries: [] });
	});
});
