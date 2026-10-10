import { describe, expect, it } from 'vitest';
import { buildFixturePdf, textPage } from '$lib/adapters/pdf/pdf-fixture-test-support';
import {
	documentSetHash,
	upsertMarkdownDocument,
	type DocumentSetManifest
} from '$lib/domain/document-set';
import { sentPdfObjectKey } from '$lib/application/documents/sent-document-pdf';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import type {
	SentDocumentPointer,
	SentDocumentSetPointer
} from '$lib/ports/envelope-sent-document-store';
import { buildVerifiedAuditChain } from './audit-chain-test-support';
import {
	assembleExecutedAgreementPdf,
	type AssembleExecutedAgreementInput
} from './executed-pdf-assembly';
import { ExecutedPdfBoundExceededError, ExecutedPdfIntegrityError } from './executed-pdf';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const SENT_COMMIT_SHA: string = 'a'.repeat(40);
const MARKDOWN_A_ID: string = '01900000-0000-7000-8000-000000000021';
const MARKDOWN_B_ID: string = '01900000-0000-7000-8000-000000000022';

async function fixture(pageCountPerDocument: number): Promise<{
	input: AssembleExecutedAgreementInput;
	objects: InMemoryObjectStore;
}> {
	let manifest: DocumentSetManifest | null = null;
	manifest = upsertMarkdownDocument(
		manifest,
		'documents/a.md',
		'a'.repeat(64),
		() => MARKDOWN_A_ID
	);
	manifest = upsertMarkdownDocument(
		manifest,
		'documents/b.md',
		'b'.repeat(64),
		() => MARKDOWN_B_ID
	);
	const setHash: string = await documentSetHash(manifest);
	const documentDeclarations = [
		{ id: MARKDOWN_A_ID, sha256: 'c'.repeat(64), byteSize: 1000, pageCount: pageCountPerDocument },
		{ id: MARKDOWN_B_ID, sha256: 'd'.repeat(64), byteSize: 1000, pageCount: pageCountPerDocument }
	];
	const sentPayload = {
		commitSha: SENT_COMMIT_SHA,
		documentSetHash: setHash,
		documentCount: documentDeclarations.length,
		documents: documentDeclarations
	};
	const auditEvents = await buildVerifiedAuditChain({ envelopeId: ENVELOPE_ID }, [
		{
			id: 'event-created',
			eventType: 'envelope.created',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: '2026-09-10T00:00:00.000Z',
			payload: { title: 'Agreement' }
		},
		{
			id: 'event-ready',
			eventType: 'envelope.ready',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: '2026-09-10T00:00:10.000Z',
			payload: {
				commitSha: SENT_COMMIT_SHA,
				generation: 1,
				recipients: [{ id: 'recipient-1', role: 'signer', routingOrder: 1 }]
			}
		},
		{
			id: 'event-sent',
			eventType: 'envelope.sent',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: '2026-09-10T00:00:20.000Z',
			payload: sentPayload
		},
		{
			id: 'event-completed',
			eventType: 'envelope.completed',
			actorType: 'recipient',
			actorId: 'recipient-1',
			occurredAt: '2026-09-10T00:00:30.000Z',
			payload: { sentCommitSha: SENT_COMMIT_SHA, completedAt: '2026-09-10T00:00:30.000Z' }
		}
	]);
	const documents: SentDocumentPointer[] = documentDeclarations.map((declaration, index) => ({
		envelopeId: ENVELOPE_ID,
		commitSha: SENT_COMMIT_SHA,
		documentId: declaration.id,
		position: index,
		kind: 'markdown' as const,
		title: manifest.documents[index].title,
		objectKey: sentPdfObjectKey(ENVELOPE_ID, declaration.sha256),
		sha256: declaration.sha256,
		byteSize: declaration.byteSize,
		pageCount: declaration.pageCount,
		pageWidth: 612,
		pageHeight: 792,
		createdAt: '2026-09-10T00:00:20.000Z'
	}));
	const sentDocumentSet: SentDocumentSetPointer = {
		envelopeId: ENVELOPE_ID,
		commitSha: SENT_COMMIT_SHA,
		documentSetHash: setHash,
		documentCount: documents.length,
		documents,
		createdAt: '2026-09-10T00:00:20.000Z'
	};
	const objects: InMemoryObjectStore = new InMemoryObjectStore();
	return {
		objects,
		input: {
			objects,
			envelopeId: ENVELOPE_ID,
			sentCommitSha: SENT_COMMIT_SHA,
			documentSet: manifest,
			sentDocumentSet,
			auditEvents,
			fieldGeneration: 0,
			fields: [],
			fieldGeometry: [],
			appendixPdfBytes: buildFixturePdf([textPage('evidence appendix')])
		}
	};
}

describe('assembleExecutedAgreementPdf aggregate budget', () => {
	it(
		'rejects an oversized attested document set before reading a single document or ' +
			'the signature store',
		async () => {
			// 450 + 450 pages, plus the one-page appendix, exceeds the composer's
			// shared 800-page ceiling.
			const { input, objects } = await fixture(450);

			await expect(assembleExecutedAgreementPdf(input)).rejects.toBeInstanceOf(
				ExecutedPdfBoundExceededError
			);
			expect(objects.getCallsByKey.size).toBe(0);
		}
	);

	it('does not block a small, legitimate attested document set', async () => {
		const { input } = await fixture(1);

		// The aggregate check passes; the rejection below comes from the next
		// stage (no object was seeded for the sent documents), proving the
		// budget check itself did not fire.
		await expect(assembleExecutedAgreementPdf(input)).rejects.toSatisfy((error: unknown) => {
			return (
				error instanceof ExecutedPdfIntegrityError &&
				!(error instanceof ExecutedPdfBoundExceededError)
			);
		});
	});
});
