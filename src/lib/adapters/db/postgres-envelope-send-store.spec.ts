import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import type { PublishSentEnvelopeCommand, SendCommandKey } from '$lib/ports/envelope-send-store';
import { PostgresEnvelopeSendStore } from './postgres-envelope-send-store';

interface RecordedQuery {
	text: string;
	values: readonly unknown[];
}

class ScriptedPostgres {
	readonly queries: RecordedQuery[] = [];
	readonly #results: readonly object[][];
	#resultIndex: number = 0;

	constructor(results: readonly (readonly object[])[]) {
		this.#results = results.map((result): object[] => [...result]);
	}

	client(): ReturnType<typeof postgres> {
		const query = async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
			this.queries.push({ text: strings.join('?').replaceAll(/\s+/g, ' ').trim(), values });
			const result: object[] | undefined = this.#results[this.#resultIndex];
			this.#resultIndex += 1;
			if (result === undefined) throw new Error('Unexpected PostgreSQL query');
			return result;
		};
		const client = query as unknown as ReturnType<typeof postgres>;
		client.begin = (async (
			callback: (transaction: postgres.TransactionSql) => Promise<unknown>
		): Promise<unknown> =>
			await callback(client as unknown as postgres.TransactionSql)) as ReturnType<
			typeof postgres
		>['begin'];
		return client;
	}
}

const key: SendCommandKey = {
	organizationId: 'org-1',
	envelopeId: 'env-1',
	actorType: 'user',
	actorId: 'user-1',
	idempotencyKey: 'send-1',
	requestFingerprint: 'request-hash'
};

function envelopeRow(): Record<string, unknown> {
	return {
		id: 'env-1',
		organizationId: 'org-1',
		title: 'Agreement',
		status: 'ready',
		repositoryGeneration: 2,
		repositoryHead: 'commit-2',
		repositoryArchiveKey: 'archive-key',
		repositoryArchiveSha256: 'archive-sha',
		sentCommitSha: null,
		fieldGeneration: 1,
		createdAt: '2026-09-11T00:00:00.000Z',
		updatedAt: '2026-09-11T00:01:30.000Z'
	};
}

function sendCommand(): PublishSentEnvelopeCommand {
	const updatedAt: string = '2026-09-11T00:02:00.000Z';
	const expiresAt: string = '2026-09-25T00:02:00.000Z';
	const delivery = {
		id: 'delivery-signer',
		recipientId: 'recipient-signer',
		capabilityHash: 'capability-hash',
		capabilityExpiresAt: expiresAt,
		sealedCapability: 'sealed-capability',
		sealingKeyId: 'key-1',
		sealedCapabilitySha256: 'c'.repeat(64),
		status: 'pending' as const,
		availableAt: updatedAt
	};
	const deliveryManifestJson: string = JSON.stringify([
		{
			id: delivery.id,
			recipientId: delivery.recipientId,
			capabilityHash: delivery.capabilityHash,
			capabilityExpiresAt: delivery.capabilityExpiresAt,
			sealingKeyId: delivery.sealingKeyId,
			sealedCapabilitySha256: delivery.sealedCapabilitySha256,
			initialStatus: delivery.status,
			initialAvailableAt: delivery.availableAt
		}
	]);
	return {
		...key,
		expectedGeneration: 2,
		expectedReadyAuditEventId: 'ready-audit',
		commitSha: 'commit-2',
		deliveries: [delivery],
		initialRoutingOrder: 2,
		deliveryManifestJson,
		deliveryManifestHash: createHash('sha256').update(deliveryManifestJson).digest('hex'),
		initialCapabilityExpiresAt: expiresAt,
		updatedAt,
		expectedAuditSequence: 3,
		previousAuditHash: 'hash-3',
		auditEventId: 'audit-send',
		auditEventHash: 'e'.repeat(64),
		auditPayloadJson: '{}'
	};
}

describe('PostgresEnvelopeSendStore', () => {
	it('prepares send when field placement advanced the head after the matching ready event', async () => {
		const database = new ScriptedPostgres([
			[],
			[envelopeRow()],
			[
				{
					id: 'fields-audit',
					sequence: 3,
					eventHash: 'hash-3',
					eventType: 'envelope.fields_placed'
				}
			],
			[{ sequence: 2 }],
			[
				{
					id: 'recipient-1',
					organizationId: 'org-1',
					envelopeId: 'env-1',
					email: 'a@example.com',
					name: 'A',
					role: 'signer',
					locale: 'en',
					routingOrder: 1,
					status: 'pending',
					capabilityHash: null,
					capabilityExpiresAt: null,
					capabilityRevokedAt: null
				}
			]
		]);

		await expect(
			new PostgresEnvelopeSendStore(database.client()).prepareSend(key, 2, 'ready-audit')
		).resolves.toMatchObject({
			outcome: 'ready',
			auditHead: { eventId: 'fields-audit', sequence: 3, eventHash: 'hash-3' }
		});
		expect(database.queries[3]).toMatchObject({
			text: expect.stringContaining('FROM envelope_ready_command ready'),
			values: ['org-1', 'env-1', 2, 'commit-2', 'ready-audit']
		});
	});

	it('fails closed when the supplied ready event is not anchored to the current revision', async () => {
		const database = new ScriptedPostgres([
			[],
			[envelopeRow()],
			[
				{
					id: 'fields-audit',
					sequence: 3,
					eventHash: 'hash-3',
					eventType: 'envelope.fields_placed'
				}
			],
			[]
		]);

		await expect(
			new PostgresEnvelopeSendStore(database.client()).prepareSend(key, 2, 'wrong-audit')
		).resolves.toEqual({ outcome: 'audit_conflict' });
	});

	it('publishes only post-send roles and derives the initial order from actionable recipients', async () => {
		const database = new ScriptedPostgres([
			[],
			[
				{
					status: 'ready',
					repositoryGeneration: 2,
					repositoryHead: 'commit-2',
					sentCommitSha: null
				}
			],
			[],
			[{ id: 'ready-audit', sequence: 3, eventHash: 'hash-3', eventType: 'envelope.ready' }],
			[{ sequence: 3 }],
			[
				{
					id: 'recipient-prefill',
					organizationId: 'org-1',
					envelopeId: 'env-1',
					email: 'prefill@example.com',
					name: 'Prefill',
					role: 'prefill',
					locale: 'en',
					routingOrder: 1,
					status: 'pending',
					capabilityHash: null,
					capabilityExpiresAt: null,
					capabilityRevokedAt: null
				},
				{
					id: 'recipient-signer',
					organizationId: 'org-1',
					envelopeId: 'env-1',
					email: 'signer@example.com',
					name: 'Signer',
					role: 'signer',
					locale: 'en',
					routingOrder: 2,
					status: 'pending',
					capabilityHash: null,
					capabilityExpiresAt: null,
					capabilityRevokedAt: null
				}
			],
			[],
			[{ id: 'recipient-signer' }],
			[],
			[{ deliveryCount: 1, queuedCount: 1 }],
			[{ id: 'env-1' }],
			[]
		]);

		await expect(
			new PostgresEnvelopeSendStore(database.client()).publishSend(sendCommand())
		).resolves.toMatchObject({
			outcome: 'published',
			result: { queuedDeliveryCount: 1, reservedCapabilityCount: 1 }
		});
		expect(
			database.queries.some((query): boolean => query.text.includes('INSERT INTO delivery_outbox'))
		).toBe(true);
	});
});
