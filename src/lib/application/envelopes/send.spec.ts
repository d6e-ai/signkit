import { describe, expect, it, vi } from 'vitest';
import type { Envelope, Recipient } from '$lib/domain/envelope';
import type {
	EnvelopeSendStore,
	PublishSentEnvelopeCommand,
	SendCommandKey,
	SendPreparation
} from '$lib/ports/envelope-send-store';
import type {
	CapabilitySealContext,
	RecipientCapabilitySealer
} from '$lib/security/delivery-capability';
import {
	FakeSentDocumentPdf,
	fakeSentDocumentSetArtifact
} from '$lib/application/documents/sent-document-pdf-test-support';
import { EnvelopeSendApplication } from './send';

const envelope: Envelope = {
	id: '01900000-0000-7000-8000-000000000001',
	createdByUserId: 'user-1',
	title: 'Agreement',
	status: 'ready',
	repositoryGeneration: 2,
	repositoryHead: '0123456789abcdef0123456789abcdef01234567',
	repositoryArchiveKey: 'internal',
	repositoryArchiveSha256: 'a'.repeat(64),
	sentCommitSha: null,
	fieldGeneration: 0,
	createdAt: '2026-09-11T00:00:00.000Z',
	updatedAt: '2026-09-11T00:01:00.000Z'
};
const recipients: readonly Recipient[] = [
	{
		id: 'r1',
		envelopeId: envelope.id,
		email: 'a@example.com',
		name: 'A',
		role: 'signer',
		locale: 'en',
		routingOrder: 1,
		status: 'pending'
	},
	{
		id: 'r2',
		envelopeId: envelope.id,
		email: 'viewer@example.com',
		name: 'Viewer',
		role: 'viewer',
		locale: 'ja',
		routingOrder: 1,
		status: 'pending'
	},
	{
		id: 'r3',
		envelopeId: envelope.id,
		email: 'b@example.com',
		name: 'B',
		role: 'approver',
		locale: 'en',
		routingOrder: 2,
		status: 'pending'
	},
	{
		id: 'r4',
		envelopeId: envelope.id,
		email: 'cc@example.com',
		name: 'CC',
		role: 'cc',
		locale: 'en',
		routingOrder: 3,
		status: 'pending'
	}
];
const actor = {
	id: 'user-1',
	createdByUserId: 'user-1'
} as const;
const readyEventId: string = '01900000-0000-7000-8000-000000000099';

class CapturingStore implements EnvelopeSendStore {
	readonly keys: SendCommandKey[] = [];
	readonly commands: PublishSentEnvelopeCommand[] = [];
	readonly #recipients: readonly Recipient[];

	constructor(preparedRecipients: readonly Recipient[] = recipients) {
		this.#recipients = preparedRecipients;
	}

	async prepareSend(key: SendCommandKey): Promise<SendPreparation> {
		this.keys.push(key);
		return {
			outcome: 'ready',
			envelope,
			recipients: this.#recipients,
			auditHead: {
				eventId: readyEventId,
				eventType: 'envelope.ready',
				sequence: 4,
				eventHash: 'b'.repeat(64)
			}
		};
	}
	async publishSend(command: PublishSentEnvelopeCommand) {
		this.commands.push(command);
		return {
			outcome: 'published' as const,
			result: {
				envelopeId: command.envelopeId,
				status: 'sent' as const,
				generation: command.expectedGeneration,
				commitSha: command.commitSha,
				readyAuditEventId: command.expectedReadyAuditEventId,
				queuedDeliveryCount: command.deliveries.filter(
					(delivery): boolean => delivery.status === 'pending'
				).length,
				reservedCapabilityCount: command.deliveries.length,
				initialCapabilityExpiresAt: command.initialCapabilityExpiresAt,
				updatedAt: command.updatedAt,
				auditEventId: command.auditEventId
			}
		};
	}
}

const sealer: RecipientCapabilitySealer = {
	seal: vi.fn(async (token: string, context: CapabilitySealContext) => ({
		sealedCapability: `sealed:${context.recipientId}:${token.slice(0, 8)}`,
		sealingKeyId: 'key-1',
		sealedCapabilitySha256: 'c'.repeat(64)
	}))
};

describe('EnvelopeSendApplication', () => {
	it('reserves signer, approver, and viewer capabilities but queues only the first routing group', async () => {
		const store: CapturingStore = new CapturingStore();
		const result = await new EnvelopeSendApplication(store, sealer, new FakeSentDocumentPdf()).send(
			actor,
			envelope.id,
			{
				idempotencyKey: 'send-1',
				expectedGeneration: 2,
				expectedReadyAuditEventId: readyEventId
			}
		);
		expect(result.outcome).toBe('published');
		expect(store.commands[0].deliveries).toHaveLength(3);
		expect(
			store.commands[0].deliveries.map((delivery) => ({
				recipientId: delivery.recipientId,
				status: delivery.status,
				expires: delivery.capabilityExpiresAt !== null,
				available: delivery.availableAt !== null
			}))
		).toEqual([
			{ recipientId: 'r1', status: 'pending', expires: true, available: true },
			{ recipientId: 'r2', status: 'pending', expires: true, available: true },
			{ recipientId: 'r3', status: 'blocked', expires: false, available: false }
		]);
		expect(store.commands[0].expectedReadyAuditEventId).toBe(readyEventId);
		expect(JSON.parse(store.commands[0].auditPayloadJson)).toMatchObject({
			readyAuditEventId: readyEventId,
			initialRoutingOrder: 1,
			queuedDeliveryCount: 2,
			reservedCapabilityCount: 3
		});
		expect(store.commands[0].auditPayloadJson).not.toContain('@example.com');
		expect(store.commands[0].auditPayloadJson).not.toContain('skr1_');
	});

	it('does not issue a post-send invitation for a legacy prefill recipient', async () => {
		const prefill: Recipient = {
			...recipients[0],
			id: 'prefill-1',
			email: 'prefill@example.com',
			role: 'prefill'
		};
		const store: CapturingStore = new CapturingStore([recipients[0], prefill]);
		const localSealer: RecipientCapabilitySealer = {
			seal: vi.fn(async (token: string, context: CapabilitySealContext) => ({
				sealedCapability: `sealed:${context.recipientId}:${token.slice(0, 8)}`,
				sealingKeyId: 'key-1',
				sealedCapabilitySha256: 'c'.repeat(64)
			}))
		};

		const result = await new EnvelopeSendApplication(
			store,
			localSealer,
			new FakeSentDocumentPdf()
		).send(actor, envelope.id, {
			idempotencyKey: 'send-prefill',
			expectedGeneration: 2,
			expectedReadyAuditEventId: readyEventId
		});

		expect(result.outcome).toBe('published');
		expect(store.commands[0].deliveries.map((delivery) => delivery.recipientId)).toEqual(['r1']);
		expect(localSealer.seal).toHaveBeenCalledTimes(1);
	});

	it('fails closed when a viewer has no actionable recipient at its routing order', async () => {
		const detachedViewer: Recipient = { ...recipients[1], routingOrder: 2 };
		const store: CapturingStore = new CapturingStore([recipients[0], detachedViewer]);
		const localSealer: RecipientCapabilitySealer = { seal: vi.fn() };

		const result = await new EnvelopeSendApplication(
			store,
			localSealer,
			new FakeSentDocumentPdf()
		).send(actor, envelope.id, {
			idempotencyKey: 'send-detached-viewer',
			expectedGeneration: 2,
			expectedReadyAuditEventId: readyEventId
		});

		expect(result).toEqual({ outcome: 'integrity_error' });
		expect(localSealer.seal).not.toHaveBeenCalled();
		expect(store.commands).toHaveLength(0);
	});

	it('renders and pins the agreement PDF, and binds its digest into the audit chain', async () => {
		const store: CapturingStore = new CapturingStore();
		const documentPdf: FakeSentDocumentPdf = new FakeSentDocumentPdf();
		const result = await new EnvelopeSendApplication(store, sealer, documentPdf).send(
			actor,
			envelope.id,
			{
				idempotencyKey: 'send-pdf',
				expectedGeneration: 2,
				expectedReadyAuditEventId: readyEventId
			}
		);

		expect(result.outcome).toBe('published');
		// The rendering is read from the envelope's own durable pointer, not
		// from anything the caller supplied.
		expect(documentPdf.published).toEqual([
			{
				envelopeId: envelope.id,
				commitSha: envelope.repositoryHead,
				archiveKey: envelope.repositoryArchiveKey,
				archiveSha256: envelope.repositoryArchiveSha256
			}
		]);
		const expected = fakeSentDocumentSetArtifact(envelope.id);
		expect(store.commands[0].sentDocumentSet).toEqual(expected);
		expect(JSON.parse(store.commands[0].auditPayloadJson)).toMatchObject({
			documentSetHash: expected.documentSetHash,
			documentCount: expected.documentCount,
			documents: expected.documents.map((document) => ({
				id: document.documentId,
				sha256: document.sha256,
				byteSize: document.byteSize,
				pageCount: document.pageCount
			}))
		});
		// The storage key stays out of the evidence record; the digest pins it.
		expect(store.commands[0].auditPayloadJson).not.toContain('sent-documents/');
	});

	it('does not publish a send it cannot render an agreement for', async () => {
		const store: CapturingStore = new CapturingStore();
		const localSealer: RecipientCapabilitySealer = {
			seal: vi.fn(async () => ({
				sealedCapability: 'sealed',
				sealingKeyId: 'key-1',
				sealedCapabilitySha256: 'c'.repeat(64)
			}))
		};
		const failing: FakeSentDocumentPdf = new FakeSentDocumentPdf(
			new Error('object storage unavailable')
		);

		const result = await new EnvelopeSendApplication(store, localSealer, failing).send(
			actor,
			envelope.id,
			{
				idempotencyKey: 'send-render-failure',
				expectedGeneration: 2,
				expectedReadyAuditEventId: readyEventId
			}
		);

		expect(result).toEqual({ outcome: 'document_render_failed' });
		expect(store.commands).toHaveLength(0);
		// No capability is minted for an envelope that will not be sent.
		expect(localSealer.seal).not.toHaveBeenCalled();
	});

	it('refuses to send an envelope with an incomplete repository pointer', async () => {
		class PointerlessStore extends CapturingStore {
			override async prepareSend(key: SendCommandKey): Promise<SendPreparation> {
				const preparation = await super.prepareSend(key);
				if (preparation.outcome !== 'ready') return preparation;
				return {
					...preparation,
					envelope: { ...preparation.envelope, repositoryArchiveSha256: null }
				};
			}
		}
		const store: PointerlessStore = new PointerlessStore();
		const documentPdf: FakeSentDocumentPdf = new FakeSentDocumentPdf();

		await expect(
			new EnvelopeSendApplication(store, sealer, documentPdf).send(actor, envelope.id, {
				idempotencyKey: 'send-no-pointer',
				expectedGeneration: 2,
				expectedReadyAuditEventId: readyEventId
			})
		).resolves.toEqual({ outcome: 'integrity_error' });
		expect(documentPdf.published).toHaveLength(0);
		expect(store.commands).toHaveLength(0);
	});

	it('returns preparation failures without creating secrets', async () => {
		const blocked: EnvelopeSendStore = {
			prepareSend: vi.fn(async (): Promise<SendPreparation> => ({ outcome: 'audit_conflict' })),
			publishSend: vi.fn()
		};
		const localSealer: RecipientCapabilitySealer = { seal: vi.fn() };
		const result = await new EnvelopeSendApplication(
			blocked,
			localSealer,
			new FakeSentDocumentPdf()
		).send(actor, envelope.id, {
			idempotencyKey: 'send-1',
			expectedGeneration: 2,
			expectedReadyAuditEventId: readyEventId
		});
		expect(result).toEqual({ outcome: 'audit_conflict' });
		expect(localSealer.seal).not.toHaveBeenCalled();
		expect(blocked.publishSend).not.toHaveBeenCalled();
	});
});
