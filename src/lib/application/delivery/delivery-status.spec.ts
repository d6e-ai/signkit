import { describe, expect, it } from 'vitest';
import type {
	DeliveryStatusStore,
	StoredEnvelopeDeliveryStatus
} from '$lib/ports/delivery-status-store';
import { DeliveryStatusService } from './delivery-status';

class FakeStatusStore implements DeliveryStatusStore {
	constructor(private readonly result: StoredEnvelopeDeliveryStatus | null) {}

	async findEnvelopeDeliveryStatus(): Promise<StoredEnvelopeDeliveryStatus | null> {
		return this.result;
	}
}

describe('DeliveryStatusService', () => {
	it('allowlists operator delivery fields and sanitizes stored provider errors', async () => {
		const service = new DeliveryStatusService(
			new FakeStatusStore({
				envelopeId: 'envelope-1',
				envelopeStatus: 'sent',
				deliveries: [
					{
						deliveryId: 'private-outbox-1',
						recipientId: 'recipient-1',
						recipientRole: 'signer',
						routingOrder: 1,
						status: 'failed',
						attempts: 2,
						availableAt: '2026-09-12T00:01:00.000Z',
						deliveredAt: null,
						updatedAt: '2026-09-12T00:00:30.000Z',
						lastError: 'SMTP 550 recipient@example.com skdc1_secret'
					}
				]
			})
		);
		const result = await service.find('org-1', 'envelope-1');

		expect(result).toEqual({
			envelopeId: 'envelope-1',
			envelopeStatus: 'sent',
			deliveries: [
				{
					recipientId: 'recipient-1',
					recipientRole: 'signer',
					routingOrder: 1,
					status: 'failed',
					attempts: 2,
					availableAt: '2026-09-12T00:01:00.000Z',
					deliveredAt: null,
					updatedAt: '2026-09-12T00:00:30.000Z',
					errorCode: 'delivery_failed'
				}
			]
		});
		expect(JSON.stringify(result)).not.toMatch(/private-outbox|recipient@example|skdc1_|lastError/);
	});

	it('preserves not-found without inventing an empty envelope', async () => {
		await expect(
			new DeliveryStatusService(new FakeStatusStore(null)).find('org-1', 'missing')
		).resolves.toBeNull();
	});
});
