import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { PostgresDeliveryStatusStore } from './postgres-delivery-status-store';

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}

class ScriptedPostgres {
	readonly queries: RecordedQuery[] = [];
	constructor(private readonly rows: readonly object[]) {}

	client(): ReturnType<typeof postgres> {
		const query = async (
			strings: TemplateStringsArray,
			...values: readonly unknown[]
		): Promise<readonly object[]> => {
			this.queries.push({ text: normalizeSql(strings), values });
			return this.rows;
		};
		return query as ReturnType<typeof postgres>;
	}
}

describe('PostgresDeliveryStatusStore', () => {
	it('normalizes timestamps and preserves delivery metadata without identity fields', async () => {
		const database = new ScriptedPostgres([
			{
				envelopeId: 'envelope-1',
				envelopeStatus: 'in_progress',
				deliveryId: 'delivery-1',
				recipientId: 'recipient-1',
				recipientRole: 'approver',
				routingOrder: 2,
				deliveryStatus: 'delivered',
				attempts: 1,
				availableAt: new Date('2026-09-12T00:00:00.000Z'),
				deliveredAt: new Date('2026-09-12T00:01:00.000Z'),
				deliveryUpdatedAt: new Date('2026-09-12T00:01:00.000Z'),
				lastError: null
			}
		]);
		const result = await new PostgresDeliveryStatusStore(
			database.client()
		).findEnvelopeDeliveryStatus('envelope-1');

		expect(result).toMatchObject({
			deliveries: [
				{
					recipientRole: 'approver',
					deliveredAt: '2026-09-12T00:01:00.000Z'
				}
			]
		});
		expect(database.queries[0].values).toEqual(['envelope-1']);
		expect(database.queries[0].text).toContain('delivery.envelope_id = envelope.id');
		expect(database.queries[0].text).toContain('WHERE envelope.id = $1');
		expect(database.queries[0].text).not.toMatch(/recipient\.email|recipient\.name/);
	});

	it('returns null for a missing envelope', async () => {
		await expect(
			new PostgresDeliveryStatusStore(new ScriptedPostgres([]).client()).findEnvelopeDeliveryStatus(
				'envelope-1'
			)
		).resolves.toBeNull();
	});
});

function normalizeSql(strings: TemplateStringsArray): string {
	let text: string = strings[0];
	for (let index: number = 1; index < strings.length; index += 1) {
		text += `$${index}${strings[index]}`;
	}
	return text.replaceAll(/\s+/g, ' ').trim();
}
