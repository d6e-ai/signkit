import { fakeSentDocumentSetArtifact } from '$lib/application/documents/sent-document-pdf-test-support';
import { sentAuditDocuments } from '$lib/application/documents/sent-document-pdf';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PublishSentEnvelopeCommand } from '$lib/ports/envelope-send-store';
import { D1EnvelopeSendStore } from './d1-envelope-send-store';

interface RecordedStatement {
	sql: string;
	bindings: readonly unknown[];
	statement: D1PreparedStatement;
}
function fakeD1(firstResults: readonly unknown[], allResults: readonly unknown[] = []) {
	const first: unknown[] = [...firstResults];
	const all: unknown[] = [...allResults];
	const prepared: RecordedStatement[] = [];
	const batches: RecordedStatement[][] = [];
	const prepare = vi.fn((sql: string): D1PreparedStatement => {
		const record: RecordedStatement = { sql, bindings: [], statement: undefined as never };
		const statement = {
			bind: (...bindings: unknown[]): D1PreparedStatement => {
				record.bindings = bindings;
				return statement;
			},
			first: async (): Promise<unknown | null> => first.shift() ?? null,
			all: async (): Promise<{ results: unknown[] }> => ({
				results: (all.shift() as unknown[] | undefined) ?? []
			})
		} as unknown as D1PreparedStatement;
		record.statement = statement;
		prepared.push(record);
		return statement;
	});
	const batch = vi.fn(async (statements: D1PreparedStatement[]): Promise<unknown[]> => {
		batches.push(
			statements.map((statement) => prepared.find((item) => item.statement === statement)!)
		);
		return [];
	});
	return { database: { prepare, batch } as unknown as D1Database, prepared, batches };
}

const sealedDigest: string = createHash('sha256').update('sealed').digest('hex');

const command: PublishSentEnvelopeCommand = {
	sentDocumentSet: fakeSentDocumentSetArtifact('env-1'),
	envelopeId: 'env-1',
	actorType: 'user',
	actorId: 'user-1',
	idempotencyKey: 'send-1',
	requestFingerprint: '',
	expectedGeneration: 2,
	expectedReadyAuditEventId: 'ready-audit',
	commitSha: 'commit-2',
	initialRoutingOrder: 1,
	deliveries: [
		{
			id: 'delivery-1',
			recipientId: 'recipient-1',
			capabilityHash: 'cap-hash',
			capabilityExpiresAt: '2026-09-25T00:02:00.000Z',
			sealedCapability: 'sealed',
			sealingKeyId: 'key-1',
			sealedCapabilitySha256: sealedDigest,
			status: 'pending',
			availableAt: '2026-09-11T00:02:00.000Z'
		}
	],
	deliveryManifestJson: '',
	deliveryManifestHash: '',
	initialCapabilityExpiresAt: '2026-09-25T00:02:00.000Z',
	updatedAt: '2026-09-11T00:02:00.000Z',
	expectedAuditSequence: 3,
	previousAuditHash: 'hash-3',
	auditEventId: 'sent-audit',
	auditEventHash: 'hash-4',
	auditPayloadJson: ''
};
command.deliveryManifestJson = JSON.stringify([
	{
		id: 'delivery-1',
		recipientId: 'recipient-1',
		capabilityHash: 'cap-hash',
		capabilityExpiresAt: '2026-09-25T00:02:00.000Z',
		sealingKeyId: 'key-1',
		sealedCapabilitySha256: sealedDigest,
		initialStatus: 'pending',
		initialAvailableAt: '2026-09-11T00:02:00.000Z'
	}
]);
command.deliveryManifestHash = createHash('sha256')
	.update(command.deliveryManifestJson)
	.digest('hex');
command.requestFingerprint = createHash('sha256')
	.update(JSON.stringify({ expectedGeneration: 2, expectedReadyAuditEventId: 'ready-audit' }))
	.digest('hex');
command.auditPayloadJson = JSON.stringify({
	commitSha: 'commit-2',
	generation: 2,
	readyAuditEventId: 'ready-audit',
	initialRoutingOrder: 1,
	queuedDeliveryCount: 1,
	reservedCapabilityCount: 1,
	deliveryManifestHash: command.deliveryManifestHash,
	initialCapabilityExpiresAt: '2026-09-25T00:02:00.000Z',
	documentSetHash: command.sentDocumentSet.documentSetHash,
	documentCount: command.sentDocumentSet.documentCount,
	documents: sentAuditDocuments(command.sentDocumentSet.documents)
});

function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		envelope_id: 'env-1',
		actor_type: 'user',
		actor_id: 'user-1',
		request_hash: command.requestFingerprint,
		expected_generation: 2,
		ready_audit_event_id: 'ready-audit',
		commit_sha: 'commit-2',
		initial_routing_order: 1,
		delivery_count: 1,
		queued_delivery_count: 1,
		delivery_manifest_hash: command.deliveryManifestHash,
		delivery_manifest_json: command.deliveryManifestJson,
		initial_capability_expires_at: command.initialCapabilityExpiresAt,
		updated_at: command.updatedAt,
		audit_event_id: 'sent-audit',
		audit_sequence: 4,
		previous_audit_hash: 'hash-3',
		audit_event_hash: 'hash-4',
		audit_payload_json: command.auditPayloadJson,
		sent_pdf_object_key: null,
		sent_pdf_sha256: null,
		sent_pdf_bytes: null,
		sent_pdf_page_count: null,
		sent_pdf_page_width: null,
		sent_pdf_page_height: null,
		sent_pdf_document_pages_json: null,
		document_set_hash: command.sentDocumentSet.documentSetHash,
		document_count: command.sentDocumentSet.documentCount,
		sent_documents_json: JSON.stringify(sentAuditDocuments(command.sentDocumentSet.documents)),
		evidence_event_id: 'sent-audit',
		evidence_envelope_id: 'env-1',
		evidence_sequence: 4,
		evidence_event_type: 'envelope.sent',
		evidence_actor_type: 'user',
		evidence_actor_id: 'user-1',
		evidence_payload_json: command.auditPayloadJson,
		evidence_previous_hash: 'hash-3',
		evidence_event_hash: 'hash-4',
		evidence_occurred_at: command.updatedAt,
		...overrides
	};
}

describe('D1EnvelopeSendStore', () => {
	it('publishes command, capability, outbox, then final guard in one ordered batch', async () => {
		const fake = fakeD1([null]);
		await expect(
			new D1EnvelopeSendStore(fake.database).publishSend(command)
		).resolves.toMatchObject({ outcome: 'published' });
		expect(fake.batches[0].map((item) => item.sql)).toEqual([
			expect.stringContaining('INSERT INTO envelope_send_command'),
			expect.stringContaining('UPDATE recipient'),
			expect.stringContaining('INSERT INTO delivery_outbox'),
			expect.stringContaining('INSERT INTO envelope_sent_document'),
			expect.stringContaining('INSERT INTO envelope_send_publish')
		]);
		expect(fake.batches[0][2].bindings).toContain('sealed');
	});

	it('prepares send when field placement advanced the head after the matching ready event', async () => {
		const fake = fakeD1(
			[
				null,
				{
					id: 'env-1',
					created_by_user_id: 'user-1',
					title: 'Agreement',
					status: 'ready',
					repository_generation: 2,
					repository_head: 'commit-2',
					repository_archive_key: 'archive-key',
					repository_archive_sha256: 'archive-sha',
					sent_commit_sha: null,
					field_generation: 1,
					created_at: '2026-09-11T00:00:00.000Z',
					updated_at: '2026-09-11T00:01:30.000Z'
				},
				{
					id: 'fields-audit',
					sequence: 3,
					event_hash: 'hash-3',
					event_type: 'envelope.fields_placed'
				},
				{ sequence: 2 }
			],
			[
				[
					{
						id: 'recipient-1',
						envelope_id: 'env-1',
						email: 'a@example.com',
						name: 'A',
						role: 'signer',
						locale: 'en',
						routing_order: 1,
						status: 'pending',
						capability_hash: null,
						capability_expires_at: null,
						capability_revoked_at: null
					}
				]
			]
		);

		await expect(
			new D1EnvelopeSendStore(fake.database).prepareSend(command, 2, 'ready-audit')
		).resolves.toMatchObject({
			outcome: 'ready',
			auditHead: { eventId: 'fields-audit', sequence: 3, eventHash: 'hash-3' }
		});
	});
	it('replays only audit-linked evidence with the same request', async () => {
		const evidence = [
			{
				id: 'delivery-1',
				recipient_id: 'recipient-1',
				status: 'pending',
				retryable: 1,
				capability_hash: 'cap-hash',
				reserved_capability_expires_at: '2026-09-25T00:02:00.000Z',
				sealed_capability: 'sealed',
				sealing_key_id: 'key-1',
				sealed_capability_sha256: sealedDigest,
				recipient_capability_hash: 'cap-hash',
				recipient_capability_expires_at: '2026-09-25T00:02:00.000Z'
			}
		];
		await expect(
			new D1EnvelopeSendStore(fakeD1([storedRow()], [evidence]).database).prepareSend(
				command,
				2,
				'ready-audit'
			)
		).resolves.toMatchObject({
			outcome: 'replayed',
			result: { status: 'sent', queuedDeliveryCount: 1 }
		});
		await expect(
			new D1EnvelopeSendStore(
				fakeD1([storedRow({ evidence_event_type: 'wrong' })], [evidence]).database
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toEqual({ outcome: 'integrity_error' });
		await expect(
			new D1EnvelopeSendStore(
				fakeD1([storedRow()], [[{ ...evidence[0], sealed_capability: null }]]).database
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toEqual({ outcome: 'integrity_error' });
		await expect(
			new D1EnvelopeSendStore(
				fakeD1(
					[storedRow()],
					[[{ ...evidence[0], status: 'failed', retryable: 0, sealed_capability: null }]]
				).database
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toMatchObject({ outcome: 'replayed' });
		await expect(
			new D1EnvelopeSendStore(
				fakeD1([storedRow()], [[{ ...evidence[0], status: 'failed', sealed_capability: null }]])
					.database
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toEqual({ outcome: 'integrity_error' });
		await expect(
			new D1EnvelopeSendStore(
				fakeD1(
					[storedRow()],
					[[{ ...evidence[0], recipient_capability_expires_at: '2026-09-25T00:02:01.000Z' }]]
				).database
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toEqual({ outcome: 'integrity_error' });
	});

	it('replays only a byte-exact canonical envelope.sent payload, including no unknown fields', async () => {
		const evidence = [
			{
				id: 'delivery-1',
				recipient_id: 'recipient-1',
				status: 'pending',
				retryable: 1,
				capability_hash: 'cap-hash',
				reserved_capability_expires_at: '2026-09-25T00:02:00.000Z',
				sealed_capability: 'sealed',
				sealing_key_id: 'key-1',
				sealed_capability_sha256: sealedDigest,
				recipient_capability_hash: 'cap-hash',
				recipient_capability_expires_at: '2026-09-25T00:02:00.000Z'
			}
		];
		const extraFieldPayload: string = `${command.auditPayloadJson.slice(0, -1)},"extra":true}`;
		await expect(
			new D1EnvelopeSendStore(
				fakeD1(
					[
						storedRow({
							audit_payload_json: extraFieldPayload,
							evidence_payload_json: extraFieldPayload
						})
					],
					[evidence]
				).database
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toEqual({ outcome: 'integrity_error' });
		const extraDocumentField: string = JSON.stringify([
			{ ...sentAuditDocuments(command.sentDocumentSet.documents)[0], extra: true }
		]);
		await expect(
			new D1EnvelopeSendStore(
				fakeD1([storedRow({ sent_documents_json: extraDocumentField })], [evidence]).database
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toEqual({ outcome: 'integrity_error' });
	});

	it('replays a pre-migration sent-pdf receipt whose document_set_hash is null', async () => {
		const evidence = [
			{
				id: 'delivery-1',
				recipient_id: 'recipient-1',
				status: 'pending',
				retryable: 1,
				capability_hash: 'cap-hash',
				reserved_capability_expires_at: '2026-09-25T00:02:00.000Z',
				sealed_capability: 'sealed',
				sealing_key_id: 'key-1',
				sealed_capability_sha256: sealedDigest,
				recipient_capability_hash: 'cap-hash',
				recipient_capability_expires_at: '2026-09-25T00:02:00.000Z'
			}
		];
		const legacyPayload: string = JSON.stringify({
			commitSha: 'commit-2',
			generation: 2,
			readyAuditEventId: 'ready-audit',
			initialRoutingOrder: 1,
			queuedDeliveryCount: 1,
			reservedCapabilityCount: 1,
			deliveryManifestHash: command.deliveryManifestHash,
			initialCapabilityExpiresAt: '2026-09-25T00:02:00.000Z',
			sentPdfSha256: 'f'.repeat(64),
			sentPdfBytes: 4096,
			sentPdfPageCount: 2
		});
		await expect(
			new D1EnvelopeSendStore(
				fakeD1(
					[
						storedRow({
							document_set_hash: null,
							document_count: null,
							sent_documents_json: null,
							sent_pdf_object_key: 'sent-documents/v1/legacy.pdf',
							sent_pdf_sha256: 'f'.repeat(64),
							sent_pdf_bytes: 4096,
							sent_pdf_page_count: 2,
							sent_pdf_page_width: 595.28,
							sent_pdf_page_height: 841.89,
							sent_pdf_document_pages_json: '[]',
							audit_payload_json: legacyPayload,
							evidence_payload_json: legacyPayload
						})
					],
					[evidence]
				).database
			).prepareSend(command, 2, 'ready-audit')
		).resolves.toMatchObject({ outcome: 'replayed', result: { status: 'sent' } });
	});
});
