import { fakeSentDocumentSetArtifact } from '$lib/application/documents/sent-document-pdf-test-support';
import { sentAuditDocuments } from '$lib/application/documents/sent-document-pdf';
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
	const sealedCapability: string = 'sealed-capability';
	const sealedCapabilitySha256: string = createHash('sha256')
		.update(sealedCapability)
		.digest('hex');
	const delivery = {
		id: 'delivery-signer',
		recipientId: 'recipient-signer',
		capabilityHash: 'capability-hash',
		capabilityExpiresAt: expiresAt,
		sealedCapability,
		sealingKeyId: 'key-1',
		sealedCapabilitySha256,
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
		sentDocumentSet: fakeSentDocumentSetArtifact(key.organizationId, key.envelopeId),
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
			[],
			[],
			[{ count: 1 }],
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
		expect(
			database.queries.some((query): boolean =>
				query.text.includes('INSERT INTO envelope_sent_document')
			)
		).toBe(true);
	});

	it('replays only a byte-exact canonical envelope.sent payload and preserves legacy sent-pdf receipts', async () => {
		const command = sendCommand();
		command.auditPayloadJson = JSON.stringify({
			commitSha: command.commitSha,
			generation: command.expectedGeneration,
			readyAuditEventId: command.expectedReadyAuditEventId,
			initialRoutingOrder: command.initialRoutingOrder,
			queuedDeliveryCount: 1,
			reservedCapabilityCount: 1,
			deliveryManifestHash: command.deliveryManifestHash,
			initialCapabilityExpiresAt: command.initialCapabilityExpiresAt,
			documentSetHash: command.sentDocumentSet.documentSetHash,
			documentCount: command.sentDocumentSet.documentCount,
			documents: sentAuditDocuments(command.sentDocumentSet.documents)
		});
		command.requestFingerprint = createHash('sha256')
			.update(
				JSON.stringify({
					expectedGeneration: command.expectedGeneration,
					expectedReadyAuditEventId: command.expectedReadyAuditEventId
				})
			)
			.digest('hex');
		const evidence = [
			{
				id: 'delivery-signer',
				status: 'pending',
				retryable: true,
				recipientId: 'recipient-signer',
				capabilityHash: 'capability-hash',
				reservedCapabilityExpiresAt: command.initialCapabilityExpiresAt,
				sealedCapability: command.deliveries[0].sealedCapability,
				sealingKeyId: 'key-1',
				sealedCapabilitySha256: command.deliveries[0].sealedCapabilitySha256,
				recipientCapabilityHash: 'capability-hash',
				recipientCapabilityExpiresAt: command.initialCapabilityExpiresAt
			}
		];
		function commandRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
			return {
				organizationId: command.organizationId,
				envelopeId: command.envelopeId,
				actorType: command.actorType,
				actorId: command.actorId,
				requestHash: command.requestFingerprint,
				expectedGeneration: command.expectedGeneration,
				readyAuditEventId: command.expectedReadyAuditEventId,
				commitSha: command.commitSha,
				initialRoutingOrder: command.initialRoutingOrder,
				deliveryCount: 1,
				queuedDeliveryCount: 1,
				deliveryManifestHash: command.deliveryManifestHash,
				deliveryManifestJson: command.deliveryManifestJson,
				initialCapabilityExpiresAt: command.initialCapabilityExpiresAt,
				updatedAt: command.updatedAt,
				auditEventId: command.auditEventId,
				auditSequence: 4,
				previousAuditHash: command.previousAuditHash,
				auditEventHash: command.auditEventHash,
				auditPayloadJson: command.auditPayloadJson,
				sentPdfObjectKey: null,
				sentPdfSha256: null,
				sentPdfBytes: null,
				sentPdfPageCount: null,
				sentPdfPageWidth: null,
				sentPdfPageHeight: null,
				sentPdfDocumentPagesJson: null,
				documentSetHash: command.sentDocumentSet.documentSetHash,
				documentCount: command.sentDocumentSet.documentCount,
				sentDocumentsJson: JSON.stringify(sentAuditDocuments(command.sentDocumentSet.documents)),
				evidenceEventId: command.auditEventId,
				evidenceOrganizationId: command.organizationId,
				evidenceEnvelopeId: command.envelopeId,
				evidenceSequence: 4,
				evidenceEventType: 'envelope.sent',
				evidenceActorType: command.actorType,
				evidenceActorId: command.actorId,
				evidencePayloadJson: command.auditPayloadJson,
				evidencePreviousHash: command.previousAuditHash,
				evidenceEventHash: command.auditEventHash,
				evidenceOccurredAt: command.updatedAt,
				...overrides
			};
		}

		await expect(
			new PostgresEnvelopeSendStore(
				new ScriptedPostgres([[commandRow()], evidence]).client()
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toMatchObject({ outcome: 'replayed', result: { status: 'sent' } });

		const extraFieldPayload: string = `${command.auditPayloadJson.slice(0, -1)},"extra":true}`;
		await expect(
			new PostgresEnvelopeSendStore(
				new ScriptedPostgres([
					[
						commandRow({
							auditPayloadJson: extraFieldPayload,
							evidencePayloadJson: extraFieldPayload
						})
					],
					evidence
				]).client()
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toEqual({ outcome: 'integrity_error' });

		const legacyPayload: string = JSON.stringify({
			commitSha: command.commitSha,
			generation: command.expectedGeneration,
			readyAuditEventId: command.expectedReadyAuditEventId,
			initialRoutingOrder: command.initialRoutingOrder,
			queuedDeliveryCount: 1,
			reservedCapabilityCount: 1,
			deliveryManifestHash: command.deliveryManifestHash,
			initialCapabilityExpiresAt: command.initialCapabilityExpiresAt,
			sentPdfSha256: 'f'.repeat(64),
			sentPdfBytes: 4096,
			sentPdfPageCount: 2
		});
		await expect(
			new PostgresEnvelopeSendStore(
				new ScriptedPostgres([
					[
						commandRow({
							documentSetHash: null,
							documentCount: null,
							sentDocumentsJson: null,
							sentPdfObjectKey: 'sent-documents/v1/legacy.pdf',
							sentPdfSha256: 'f'.repeat(64),
							sentPdfBytes: 4096,
							sentPdfPageCount: 2,
							sentPdfPageWidth: 595.28,
							sentPdfPageHeight: 841.89,
							sentPdfDocumentPagesJson: '[]',
							auditPayloadJson: legacyPayload,
							evidencePayloadJson: legacyPayload
						})
					],
					evidence
				]).client()
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toMatchObject({ outcome: 'replayed', result: { status: 'sent' } });
	});
});
