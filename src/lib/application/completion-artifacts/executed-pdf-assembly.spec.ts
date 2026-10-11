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
import { buildVerifiedAuditChain, type AuditChainStep } from './audit-chain-test-support';
import {
	assembleExecutedAgreementPdf,
	attestExecutedAgreementSources,
	type AssembleExecutedAgreementInput
} from './executed-pdf-assembly';
import { ExecutedPdfBoundExceededError, ExecutedPdfIntegrityError } from './executed-pdf';

const ENVELOPE_ID: string = '01900000-0000-7000-8000-000000000001';
const SENT_COMMIT_SHA: string = 'a'.repeat(40);
const OLD_COMMIT_SHA: string = 'c'.repeat(40);
const MID_COMMIT_SHA: string = 'b'.repeat(40);
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
		readyAuditEventId: 'event-ready',
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

describe('attestExecutedAgreementSources field placements after reopen', () => {
	it('accepts a legacy empty field set at fieldGeneration 0 without reopen', async () => {
		const { input } = await fixture(1);
		await expect(attestExecutedAgreementSources(input)).resolves.toBeUndefined();
	});

	it('accepts an empty current field set after a verified reopen clear of an older placement', async () => {
		const { input } = await fixture(1);
		input.fieldGeneration = 1;
		input.auditEvents = await reopenThenReadyChain(input, {
			fieldGeneration: 1,
			generation: 1,
			commitSha: SENT_COMMIT_SHA
		});
		await expect(attestExecutedAgreementSources(input)).resolves.toBeUndefined();
	});

	it('accepts an empty current field set after reopen when no fields were ever placed', async () => {
		const { input } = await fixture(1);
		input.fieldGeneration = 1;
		input.auditEvents = await reopenThenReadyChain(
			input,
			{ fieldGeneration: 1, generation: 1, commitSha: SENT_COMMIT_SHA },
			{ includePriorPlacement: false }
		);
		await expect(attestExecutedAgreementSources(input)).resolves.toBeUndefined();
	});

	it('accepts an empty current field set after reopen then a new document revision', async () => {
		const { input } = await fixture(1);
		input.fieldGeneration = 1;
		input.auditEvents = await reopenThenReadyChain(
			input,
			{ fieldGeneration: 1, generation: 1, commitSha: OLD_COMMIT_SHA },
			{
				priorReady: { commitSha: OLD_COMMIT_SHA, generation: 1 },
				finalReady: { commitSha: SENT_COMMIT_SHA, generation: 2 }
			}
		);
		await expect(attestExecutedAgreementSources(input)).resolves.toBeUndefined();
	});

	it('accepts an empty current field set after a second reopen at a later revision', async () => {
		const { input } = await fixture(1);
		input.fieldGeneration = 2;
		input.auditEvents = await reopenThenReadyChain(
			input,
			{ fieldGeneration: 1, generation: 1, commitSha: OLD_COMMIT_SHA },
			{
				priorReady: { commitSha: OLD_COMMIT_SHA, generation: 1 },
				finalReady: { commitSha: SENT_COMMIT_SHA, generation: 3 },
				betweenReopenAndFinalReady: [
					readyStep('event-ready-2', '2026-09-10T00:00:09.500Z', {
						commitSha: MID_COMMIT_SHA,
						generation: 2
					}),
					{
						id: 'event-reopened-2',
						eventType: 'envelope.reopened',
						actorType: 'user',
						actorId: 'user-1',
						occurredAt: '2026-09-10T00:00:09.750Z',
						payload: {
							commitSha: MID_COMMIT_SHA,
							generation: 2,
							fieldGeneration: 2,
							readyAuditEventId: 'event-ready-2'
						}
					}
				]
			}
		);
		await expect(attestExecutedAgreementSources(input)).resolves.toBeUndefined();
	});

	it('rejects an empty current field set when the reopen payload generation is malformed', async () => {
		const { input } = await fixture(1);
		input.fieldGeneration = 1;
		input.auditEvents = await reopenThenReadyChain(input, {
			fieldGeneration: 1,
			generation: '1',
			commitSha: SENT_COMMIT_SHA
		});
		await expect(attestExecutedAgreementSources(input)).rejects.toBeInstanceOf(
			ExecutedPdfIntegrityError
		);
	});

	it('rejects an empty current field set when the reopen fieldGeneration evidence is malformed', async () => {
		const { input } = await fixture(1);
		input.fieldGeneration = 1;
		input.auditEvents = await reopenThenReadyChain(input, {
			fieldGeneration: '1',
			generation: 1,
			commitSha: SENT_COMMIT_SHA
		});
		await expect(attestExecutedAgreementSources(input)).rejects.toMatchObject({
			reason: 'missing_geometry'
		});
	});

	it('rejects an empty current field set when the reopen fieldGeneration does not match the empty projection', async () => {
		const { input } = await fixture(1);
		input.fieldGeneration = 1;
		input.auditEvents = await reopenThenReadyChain(input, {
			fieldGeneration: 2,
			generation: 1,
			commitSha: SENT_COMMIT_SHA
		});
		await expect(attestExecutedAgreementSources(input)).rejects.toMatchObject({
			reason: 'missing_geometry'
		});
	});

	it('rejects an empty current field set when the reopen commit does not match the prior ready', async () => {
		const { input } = await fixture(1);
		input.fieldGeneration = 1;
		input.auditEvents = await reopenThenReadyChain(input, {
			fieldGeneration: 1,
			generation: 1,
			commitSha: OLD_COMMIT_SHA
		});
		await expect(attestExecutedAgreementSources(input)).rejects.toMatchObject({
			reason: 'missing_geometry'
		});
	});

	it('rejects an empty current field set when the reopen generation does not match the prior ready', async () => {
		const { input } = await fixture(1);
		input.fieldGeneration = 1;
		input.auditEvents = await reopenThenReadyChain(input, {
			fieldGeneration: 1,
			generation: 2,
			commitSha: SENT_COMMIT_SHA
		});
		await expect(attestExecutedAgreementSources(input)).rejects.toMatchObject({
			reason: 'missing_geometry'
		});
	});

	it('rejects an empty current field set when the latest reopen names a stale prior ready', async () => {
		const { input } = await fixture(1);
		input.fieldGeneration = 2;
		input.auditEvents = await reopenThenReadyChain(
			input,
			{ fieldGeneration: 1, generation: 1, commitSha: OLD_COMMIT_SHA },
			{
				priorReady: { commitSha: OLD_COMMIT_SHA, generation: 1 },
				finalReady: { commitSha: SENT_COMMIT_SHA, generation: 3 },
				betweenReopenAndFinalReady: [
					readyStep('event-ready-2', '2026-09-10T00:00:09.500Z', {
						commitSha: MID_COMMIT_SHA,
						generation: 2
					}),
					{
						id: 'event-reopened-2',
						eventType: 'envelope.reopened',
						actorType: 'user',
						actorId: 'user-1',
						occurredAt: '2026-09-10T00:00:09.750Z',
						payload: {
							commitSha: MID_COMMIT_SHA,
							generation: 2,
							fieldGeneration: 2,
							readyAuditEventId: 'event-ready-1'
						}
					}
				]
			}
		);
		await expect(attestExecutedAgreementSources(input)).rejects.toMatchObject({
			reason: 'missing_geometry'
		});
	});

	it('rejects an empty current field set when the reopen prior-ready anchor is malformed', async () => {
		const { input } = await fixture(1);
		input.fieldGeneration = 1;
		input.auditEvents = await reopenThenReadyChain(input, {
			fieldGeneration: 1,
			generation: 1,
			commitSha: SENT_COMMIT_SHA,
			readyAuditEventId: 'event-created'
		});
		await expect(attestExecutedAgreementSources(input)).rejects.toMatchObject({
			reason: 'missing_geometry'
		});
	});

	it('rejects an empty current field set at fieldGeneration>0 without a reopen clear', async () => {
		const { input } = await fixture(1);
		input.fieldGeneration = 1;
		await expect(attestExecutedAgreementSources(input)).rejects.toMatchObject({
			reason: 'missing_geometry'
		});
	});
});

function readyStep(
	id: string,
	occurredAt: string,
	revision: { commitSha: string; generation: number }
): AuditChainStep {
	return {
		id,
		eventType: 'envelope.ready',
		actorType: 'user',
		actorId: 'user-1',
		occurredAt,
		payload: {
			commitSha: revision.commitSha,
			generation: revision.generation,
			recipients: [{ id: 'recipient-1', role: 'approver', routingOrder: 1 }]
		}
	};
}

async function reopenThenReadyChain(
	input: AssembleExecutedAgreementInput,
	reopenPayload: {
		fieldGeneration: number | string;
		generation: number | string;
		commitSha: string;
		readyAuditEventId?: string;
	},
	options: {
		includePriorPlacement?: boolean;
		priorReady?: { commitSha: string; generation: number };
		finalReady?: { commitSha: string; generation: number };
		betweenReopenAndFinalReady?: readonly AuditChainStep[];
	} = {}
): Promise<AssembleExecutedAgreementInput['auditEvents']> {
	const includePriorPlacement: boolean = options.includePriorPlacement !== false;
	const priorReady: { commitSha: string; generation: number } = options.priorReady ?? {
		commitSha: SENT_COMMIT_SHA,
		generation: 1
	};
	const finalReady: { commitSha: string; generation: number } = options.finalReady ?? {
		commitSha: SENT_COMMIT_SHA,
		generation: 1
	};
	return buildVerifiedAuditChain({ envelopeId: ENVELOPE_ID }, [
		{
			id: 'event-created',
			eventType: 'envelope.created',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: '2026-09-10T00:00:00.000Z',
			payload: { title: 'Agreement' }
		},
		readyStep('event-ready-1', '2026-09-10T00:00:05.000Z', priorReady),
		...(includePriorPlacement
			? [
					{
						id: 'event-fields-old',
						eventType: 'envelope.fields_placed',
						actorType: 'user',
						actorId: 'user-1',
						occurredAt: '2026-09-10T00:00:08.000Z',
						payload: {
							commitSha: priorReady.commitSha,
							generation: priorReady.generation,
							fieldGeneration: 1,
							fields: [
								{
									id: 'field-old',
									recipientId: 'recipient-1',
									documentId: MARKDOWN_A_ID,
									documentPath: null,
									fieldType: 'signature',
									required: true,
									position: 0,
									geometry: { page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.05 }
								}
							]
						}
					}
				]
			: []),
		{
			id: 'event-reopened',
			eventType: 'envelope.reopened',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: '2026-09-10T00:00:09.000Z',
			payload: {
				commitSha: reopenPayload.commitSha,
				generation: reopenPayload.generation,
				fieldGeneration: reopenPayload.fieldGeneration,
				readyAuditEventId: reopenPayload.readyAuditEventId ?? 'event-ready-1'
			}
		},
		...(options.betweenReopenAndFinalReady ?? []),
		readyStep('event-ready', '2026-09-10T00:00:10.000Z', finalReady),
		{
			id: 'event-sent',
			eventType: 'envelope.sent',
			actorType: 'user',
			actorId: 'user-1',
			occurredAt: '2026-09-10T00:00:20.000Z',
			payload: {
				commitSha: SENT_COMMIT_SHA,
				readyAuditEventId: 'event-ready',
				documentSetHash: input.sentDocumentSet.documentSetHash,
				documentCount: input.sentDocumentSet.documentCount,
				documents: input.sentDocumentSet.documents.map((document) => ({
					id: document.documentId,
					sha256: document.sha256,
					byteSize: document.byteSize,
					pageCount: document.pageCount
				}))
			}
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
}
