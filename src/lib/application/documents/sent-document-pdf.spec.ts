import { describe, expect, it } from 'vitest';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import type { ObjectMetadata, ObjectStore, PutObject } from '$lib/ports/object-store';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import type { DraftActor, DraftRepository, DraftVersion } from '$lib/ports/draft-repository';
import {
	draftArchiveKey,
	type ImmutableDraftRevision
} from '$lib/application/drafts/draft-persistence';
import { renderAgreementPdf } from '$lib/adapters/pdf/agreement-pdf';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import { parsePdfPageMetadata } from '$lib/adapters/pdf/pdf-page-metadata';
import { uploadedPdfObjectKey } from '$lib/application/documents/uploaded-pdf';
import { normalizeMarkdownContent } from '$lib/domain/draft';
import {
	appendPdfDocument,
	serializeDocumentSet,
	upsertMarkdownDocument,
	type DocumentSetManifest
} from '$lib/domain/document-set';
import { buildFixturePdf, textPage } from '$lib/adapters/pdf/pdf-fixture-test-support';
import { MAX_COMPOSED_PDF_PAGES } from '$lib/adapters/pdf/pdf-composer';
import {
	computeWorstCaseEvidenceAppendix,
	SendCompletionBudgetError
} from '$lib/application/envelopes/send-completion-budget';
import type { Recipient } from '$lib/domain/envelope';
import type {
	CompletionPdfEvidenceStore,
	CompletionPdfFieldGeometry
} from '$lib/ports/completion-pdf-evidence-store';
import {
	MAX_SENT_PDF_DOCUMENTS,
	parseSentPdfObjectKey,
	SentDocumentPdfError,
	SentDocumentPdfService,
	sentPdfObjectKey,
	sha256Hex,
	renderRevisionPdf,
	type SendCompletionContext
} from './sent-document-pdf';

const ENVELOPE_ID = '01900000-0000-7000-8000-000000000001';
const MARKDOWN_A_ID = '01900000-0000-7000-8000-000000000021';
const PDF_ID = '01900000-0000-7000-8000-000000000022';
const MARKDOWN_B_ID = '01900000-0000-7000-8000-000000000023';

const actor: DraftActor = {
	id: '01900000-0000-7000-8000-000000000003',
	name: 'Author',
	email: 'author@example.com',
	type: 'user'
};

const DEFAULT_RECIPIENTS: readonly Recipient[] = [
	{
		id: 'r1',
		envelopeId: ENVELOPE_ID,
		email: 'signer@example.com',
		name: 'Signer',
		role: 'signer',
		locale: 'en',
		routingOrder: 1,
		status: 'pending'
	}
];

function sendContext(recipients: readonly Recipient[] = DEFAULT_RECIPIENTS): SendCompletionContext {
	return { title: 'Agreement', fieldGeneration: 0, recipients };
}

class FakeFieldPlacements implements CompletionPdfEvidenceStore {
	constructor(private readonly fields: readonly CompletionPdfFieldGeometry[] = []) {}

	async readFieldGeometry(): Promise<readonly CompletionPdfFieldGeometry[]> {
		return this.fields;
	}
}

const noFields: FakeFieldPlacements = new FakeFieldPlacements();

/** A valid, distinct multi-page PDF: `label` makes its content (and so its SHA-256) unique. */
function manyPagePdf(pageCount: number, label: string): Uint8Array {
	return buildFixturePdf(
		Array.from({ length: pageCount }, (_unused, index: number) =>
			textPage(`${label} page ${index}`)
		)
	);
}

async function pinnedPdfOnlyRevision(
	objects: ObjectStore,
	repository: DraftRepository,
	pdfs: readonly { id: string; title: string; bytes: Uint8Array }[]
): Promise<{ revision: ImmutableDraftRevision; sha256ById: ReadonlyMap<string, string> }> {
	let manifest: DocumentSetManifest | null = null;
	const sha256ById: Map<string, string> = new Map();
	for (const pdf of pdfs) {
		const sha256: string = await sha256Hex(pdf.bytes);
		sha256ById.set(pdf.id, sha256);
		const metadata = parsePdfPageMetadata(pdf.bytes);
		manifest = appendPdfDocument(
			manifest,
			{
				id: pdf.id,
				title: pdf.title,
				sha256,
				byteSize: pdf.bytes.byteLength,
				pageCount: metadata.pageCount,
				pageWidth: metadata.pageWidth,
				pageHeight: metadata.pageHeight
			},
			() => pdf.id
		);
		await objects.putImmutable(uploadedPdfObjectKey(ENVELOPE_ID, sha256), {
			contentType: 'application/pdf',
			body: pdf.bytes,
			sha256
		});
	}
	const version: DraftVersion = await repository.commit(
		null,
		[{ path: 'document-set.json', content: serializeDocumentSet(manifest as DocumentSetManifest) }],
		'seed pdf-only bundle',
		actor
	);
	const archiveKey: string = draftArchiveKey(ENVELOPE_ID, version.archiveSha256);
	await objects.putImmutable(archiveKey, {
		contentType: 'application/vnd.signkit.git-archive+gzip',
		body: version.archive,
		sha256: version.archiveSha256
	});
	return {
		revision: {
			envelopeId: ENVELOPE_ID,
			commitSha: version.commitSha,
			archiveKey,
			archiveSha256: version.archiveSha256
		},
		sha256ById
	};
}

function samplePdfBytes(): Uint8Array {
	return renderAgreementPdf([
		{ title: 'Schedule A', nodes: renderRecipientMarkdown('# Schedule A\n\nTerms.\n').nodes }
	]).bytes;
}

async function pinnedMixedRevision(
	objects: ObjectStore,
	repository: DraftRepository,
	options: { includeUploadedPdf?: boolean } = {}
): Promise<{
	revision: ImmutableDraftRevision;
	uploadedBytes: Uint8Array;
	uploadedSha256: string;
	markdownAId: string;
	pdfId: string;
	markdownBId: string;
}> {
	const includeUploadedPdf: boolean = options.includeUploadedPdf ?? true;
	const nda: string = normalizeMarkdownContent('# NDA\n\nConfidential.\n');
	const appendix: string = normalizeMarkdownContent('# Appendix\n\nExtra terms.\n');
	const uploadedBytes: Uint8Array = samplePdfBytes();
	const uploadedSha256: string = await sha256Hex(uploadedBytes);
	const metadata = parsePdfPageMetadata(uploadedBytes);
	let manifest: DocumentSetManifest | null = null;
	manifest = upsertMarkdownDocument(
		manifest,
		'documents/nda.md',
		await sha256Hex(new TextEncoder().encode(nda)),
		() => MARKDOWN_A_ID
	);
	manifest = appendPdfDocument(
		manifest,
		{
			id: PDF_ID,
			title: 'Schedule A',
			sha256: uploadedSha256,
			byteSize: uploadedBytes.byteLength,
			pageCount: metadata.pageCount,
			pageWidth: metadata.pageWidth,
			pageHeight: metadata.pageHeight
		},
		() => PDF_ID
	);
	manifest = upsertMarkdownDocument(
		manifest,
		'documents/appendix.md',
		await sha256Hex(new TextEncoder().encode(appendix)),
		() => MARKDOWN_B_ID,
		'Appendix'
	);
	const version: DraftVersion = await repository.commit(
		null,
		[
			{ path: 'documents/nda.md', content: nda },
			{ path: 'documents/appendix.md', content: appendix },
			{ path: 'document-set.json', content: serializeDocumentSet(manifest) }
		],
		'seed mixed bundle',
		actor
	);
	const archiveKey: string = draftArchiveKey(ENVELOPE_ID, version.archiveSha256);
	await objects.putImmutable(archiveKey, {
		contentType: 'application/vnd.signkit.git-archive+gzip',
		body: version.archive,
		sha256: version.archiveSha256
	});
	if (includeUploadedPdf) {
		await objects.putImmutable(uploadedPdfObjectKey(ENVELOPE_ID, uploadedSha256), {
			contentType: 'application/pdf',
			body: uploadedBytes,
			sha256: uploadedSha256
		});
	}
	return {
		revision: {
			envelopeId: ENVELOPE_ID,
			commitSha: version.commitSha,
			archiveKey,
			archiveSha256: version.archiveSha256
		},
		uploadedBytes,
		uploadedSha256,
		markdownAId: MARKDOWN_A_ID,
		pdfId: PDF_ID,
		markdownBId: MARKDOWN_B_ID
	};
}

describe('sentPdfObjectKey', () => {
	it('is content-addressed and instance-scoped, and round-trips', () => {
		const sha256: string = 'a'.repeat(64);
		const key: string = sentPdfObjectKey(ENVELOPE_ID, sha256);
		expect(key).toBe(`sent-documents/v1/envelopes/${ENVELOPE_ID}/sha256/${sha256}.pdf`);
		expect(parseSentPdfObjectKey(key)).toEqual({
			envelopeId: ENVELOPE_ID,
			sha256
		});
	});

	it('escapes scope segments so no identifier can climb out of its prefix', () => {
		const key: string = sentPdfObjectKey('env/../other', 'b'.repeat(64));
		expect(key).not.toContain('..');
		expect(key.split('/')).toHaveLength(6);
		expect(parseSentPdfObjectKey(key)).toEqual({
			envelopeId: 'env/../other',
			sha256: 'b'.repeat(64)
		});
	});

	it('rejects a digest that is not a SHA-256 hex string', () => {
		expect(() => sentPdfObjectKey(ENVELOPE_ID, 'nope')).toThrow(SentDocumentPdfError);
		expect(parseSentPdfObjectKey('sent-documents/v1/anything.pdf')).toBeNull();
	});
});

describe('renderRevisionPdf', () => {
	it('refuses a revision with no documents', () => {
		expect(() => renderRevisionPdf([])).toThrow(SentDocumentPdfError);
	});

	it('refuses more documents than the bound allows', () => {
		const documents = Array.from(
			{ length: MAX_SENT_PDF_DOCUMENTS + 1 },
			(_unused, index: number) => ({
				path: `documents/doc-${index}.md` as `documents/${string}.md`,
				content: '# Doc\n'
			})
		);
		expect(() => renderRevisionPdf(documents)).toThrow(SentDocumentPdfError);
	});

	it('refuses a revision that exceeds the total Markdown budget', () => {
		expect(() =>
			renderRevisionPdf([
				{ path: 'documents/a.md', content: 'x'.repeat(600 * 1024) },
				{ path: 'documents/b.md', content: 'x'.repeat(600 * 1024) }
			])
		).toThrow(SentDocumentPdfError);
	});
});

describe('SentDocumentPdfService', () => {
	it('publishes one object per document, copying uploaded PDF bytes identically', async () => {
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const seeded = await pinnedMixedRevision(objects, repository);
		const service: SentDocumentPdfService = new SentDocumentPdfService(
			objects,
			repository,
			noFields
		);

		const artifact = await service.publish(seeded.revision, sendContext());

		expect(artifact.documentCount).toBe(3);
		expect(artifact.documents.map((document) => document.documentId)).toEqual([
			seeded.markdownAId,
			seeded.pdfId,
			seeded.markdownBId
		]);
		expect(new Set(artifact.documents.map((document) => document.sha256)).size).toBe(3);
		const uploaded = artifact.documents.find((document) => document.kind === 'pdf');
		expect(uploaded?.sha256).toBe(seeded.uploadedSha256);
		const stored: ReadableStream<Uint8Array> | null = await objects.get(uploaded!.objectKey);
		expect(stored).not.toBeNull();
		const sentBytes: Uint8Array = new Uint8Array(await new Response(stored).arrayBuffer());
		expect(sentBytes).toEqual(seeded.uploadedBytes);
		expect(await sha256Hex(sentBytes)).toBe(seeded.uploadedSha256);
		expect(objects.getCallsByKey.get(seeded.revision.archiveKey)).toBe(1);
	});

	it('renders Markdown documents deterministically across two publishes', async () => {
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const seeded = await pinnedMixedRevision(objects, repository);
		const service: SentDocumentPdfService = new SentDocumentPdfService(
			objects,
			repository,
			noFields
		);

		const first = await service.publish(seeded.revision, sendContext());
		const second = await service.publish(seeded.revision, sendContext());
		expect(second).toEqual(first);
		const markdown = first.documents.filter((document) => document.kind === 'markdown');
		expect(markdown).toHaveLength(2);
		expect(markdown[0]?.sha256).not.toBe(markdown[1]?.sha256);
	});

	it('fails closed when an uploaded PDF object is missing', async () => {
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const seeded = await pinnedMixedRevision(objects, repository, { includeUploadedPdf: false });

		await expect(
			new SentDocumentPdfService(objects, repository, noFields).publish(
				seeded.revision,
				sendContext()
			)
		).rejects.toThrow(SentDocumentPdfError);
	});

	it('fails closed when a failed write cannot be proven to have landed correctly', async () => {
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const seeded = await pinnedMixedRevision(objects, repository);
		class HostileStore extends InMemoryObjectStore {
			override async putImmutable(key: string, object: PutObject): Promise<ObjectMetadata> {
				if (key.startsWith('sent-documents/')) throw new Error('provider rejected the write');
				return super.putImmutable(key, object);
			}
			override async head(key: string): Promise<ObjectMetadata | null> {
				if (key.startsWith('sent-documents/')) {
					return {
						key,
						contentType: 'application/pdf',
						size: 7,
						sha256: 'c'.repeat(64),
						version: null
					};
				}
				return super.head(key);
			}
		}
		const hostile: HostileStore = new HostileStore();
		const stream: ReadableStream<Uint8Array> | null = await objects.get(seeded.revision.archiveKey);
		const archive: Uint8Array = new Uint8Array(await new Response(stream).arrayBuffer());
		await hostile.putImmutable(seeded.revision.archiveKey, {
			contentType: 'application/vnd.signkit.git-archive+gzip',
			body: archive,
			sha256: seeded.revision.archiveSha256
		});
		await hostile.putImmutable(uploadedPdfObjectKey(ENVELOPE_ID, seeded.uploadedSha256), {
			contentType: 'application/pdf',
			body: seeded.uploadedBytes,
			sha256: seeded.uploadedSha256
		});

		await expect(
			new SentDocumentPdfService(hostile, repository, noFields).publish(
				seeded.revision,
				sendContext()
			)
		).rejects.toThrow('provider rejected the write');
	});

	it('renders one document without storing sent objects when only the geometry is needed', async () => {
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const seeded = await pinnedMixedRevision(objects, repository);
		const before = (await objects.list({ prefix: 'sent-documents/' })).objects.length;

		const rendered = await new SentDocumentPdfService(objects, repository).renderDocument(
			seeded.revision,
			seeded.markdownAId
		);

		expect(rendered.bytes.byteLength).toBe(rendered.byteSize);
		expect(rendered.documentId).toBe(seeded.markdownAId);
		expect((await objects.list({ prefix: 'sent-documents/' })).objects.length).toBe(before);
	});
});

/** The exact worst-case evidence appendix page count for a pdf-only set with these recipients. */
async function measureAppendixPages(
	pdfLeafCount: number,
	recipients: readonly Recipient[]
): Promise<number> {
	let manifest: DocumentSetManifest | null = null;
	for (let index: number = 0; index < pdfLeafCount; index += 1) {
		manifest = appendPdfDocument(
			manifest,
			{
				title: `Agreement ${index}`,
				sha256: 'a'.repeat(64),
				byteSize: 1,
				pageCount: 1,
				pageWidth: 612,
				pageHeight: 792
			},
			() => `01900000-0000-7000-8000-${(40 + index).toString().padStart(12, '0')}`
		);
	}
	const appendix = computeWorstCaseEvidenceAppendix({
		envelopeId: ENVELOPE_ID,
		title: 'Agreement',
		sentCommitSha: '0'.repeat(40),
		draftArchiveSha256: '0'.repeat(64),
		fieldGeneration: 0,
		documentSetHash: 'b'.repeat(64),
		documentSet: manifest as DocumentSetManifest,
		markdown: new Map(),
		recipients,
		fields: []
	});
	return appendix.pageCount;
}

describe('SentDocumentPdfService completion budget', () => {
	const PDF_A_ID = '01900000-0000-7000-8000-000000000031';
	const PDF_B_ID = '01900000-0000-7000-8000-000000000032';
	const PDF_C_ID = '01900000-0000-7000-8000-000000000033';
	const MARKDOWN_BLANK_ID = '01900000-0000-7000-8000-000000000034';

	it(
		'rejects three distinct, individually valid 400-page PDFs before persisting ' +
			'any of them, and never reads the documents after the one that tips the budget over',
		async () => {
			const objects: InMemoryObjectStore = new InMemoryObjectStore();
			const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
			const pdfs = [
				{ id: PDF_A_ID, title: 'Agreement A', bytes: manyPagePdf(400, 'agreement-a') },
				{ id: PDF_B_ID, title: 'Agreement B', bytes: manyPagePdf(400, 'agreement-b') },
				{ id: PDF_C_ID, title: 'Agreement C', bytes: manyPagePdf(400, 'agreement-c') }
			];
			const seeded = await pinnedPdfOnlyRevision(objects, repository, pdfs);
			expect(new Set(seeded.sha256ById.values()).size).toBe(3);

			await expect(
				new SentDocumentPdfService(objects, repository, noFields).publish(
					seeded.revision,
					sendContext()
				)
			).rejects.toThrowError(expect.objectContaining({ reason: 'too_many_pages' }));

			const bKey: string = uploadedPdfObjectKey(
				ENVELOPE_ID,
				seeded.sha256ById.get(PDF_B_ID) as string
			);
			const cKey: string = uploadedPdfObjectKey(
				ENVELOPE_ID,
				seeded.sha256ById.get(PDF_C_ID) as string
			);
			expect(objects.getCallsByKey.get(bKey)).toBeUndefined();
			expect(objects.getCallsByKey.get(cKey)).toBeUndefined();
			// The aggregate is proven before any document is persisted as a sent
			// object: a failed preflight writes nothing, rather than persisting
			// documents read before the one that tipped the running total over.
			expect((await objects.list({ prefix: 'sent-documents/' })).objects.length).toBe(0);
		}
	);

	it('publishes successfully when the aggregate page total lands exactly on the budget boundary', async () => {
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		// The exact appendix reservation for this send, measured the same way
		// the service itself measures it, so the two originals are sized to
		// land precisely at the shared composer ceiling rather than merely
		// near it.
		const appendixPages: number = await measureAppendixPages(2, DEFAULT_RECIPIENTS);
		const originalsBudget: number = MAX_COMPOSED_PDF_PAGES - appendixPages;
		const firstPages: number = Math.floor(originalsBudget / 2);
		const secondPages: number = originalsBudget - firstPages;
		const pdfs = [
			{ id: PDF_A_ID, title: 'Agreement A', bytes: manyPagePdf(firstPages, 'boundary-a') },
			{ id: PDF_B_ID, title: 'Agreement B', bytes: manyPagePdf(secondPages, 'boundary-b') }
		];
		const seeded = await pinnedPdfOnlyRevision(objects, repository, pdfs);

		const artifact = await new SentDocumentPdfService(objects, repository, noFields).publish(
			seeded.revision,
			sendContext(DEFAULT_RECIPIENTS)
		);

		expect(artifact.documentCount).toBe(2);
		const totalPages: number = artifact.documents.reduce(
			(sum, document) => sum + document.pageCount,
			0
		);
		// The real service measures its own appendix from the real document
		// set (which now includes the two originals' real titles/digests, not
		// the placeholders `measureAppendixPages` used), so this asserts the
		// boundary was reached, not that it landed on the precomputed value
		// exactly.
		expect(totalPages).toBe(originalsBudget);
	});

	it('rejects with the composition reason, not a generic SentDocumentPdfError', async () => {
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const pdfs = [
			{ id: PDF_A_ID, title: 'Agreement A', bytes: manyPagePdf(400, 'wrapper-a') },
			{ id: PDF_B_ID, title: 'Agreement B', bytes: manyPagePdf(400, 'wrapper-b') }
		];
		const seeded = await pinnedPdfOnlyRevision(objects, repository, pdfs);

		await expect(
			new SentDocumentPdfService(objects, repository, noFields).publish(
				seeded.revision,
				sendContext()
			)
		).rejects.toBeInstanceOf(SendCompletionBudgetError);
	});

	it('refuses to send without frozen field placements to prove the budget against', async () => {
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const seeded = await pinnedPdfOnlyRevision(objects, repository, [
			{ id: PDF_A_ID, title: 'Agreement A', bytes: manyPagePdf(1, 'unplaced') }
		]);

		await expect(
			new SentDocumentPdfService(objects, repository).publish(seeded.revision, sendContext())
		).rejects.toThrow(SentDocumentPdfError);
		expect((await objects.list({ prefix: 'sent-documents/' })).objects.length).toBe(0);
	});

	it('rejects a field completion could not draw before persisting anything', async () => {
		const objects: InMemoryObjectStore = new InMemoryObjectStore();
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const seeded = await pinnedPdfOnlyRevision(objects, repository, [
			{ id: PDF_A_ID, title: 'Agreement A', bytes: manyPagePdf(1, 'misplaced') }
		]);
		const placements: FakeFieldPlacements = new FakeFieldPlacements([
			{
				id: '01900000-0000-7000-8000-000000000041',
				documentId: PDF_A_ID,
				documentPath: null,
				position: 0,
				recipientId: 'r1',
				fieldType: 'signature',
				required: true,
				geometry: { page: 2, x: 0.1, y: 0.1, width: 0.2, height: 0.1 }
			}
		]);

		await expect(
			new SentDocumentPdfService(objects, repository, placements).publish(
				seeded.revision,
				sendContext()
			)
		).rejects.toThrowError(expect.objectContaining({ reason: 'invalid_field_placement' }));
		expect((await objects.list({ prefix: 'sent-documents/' })).objects.length).toBe(0);
	});

	it(
		'rejects a send whose Markdown originals are individually tiny but whose raw content ' +
			'would blow up the evidence appendix, which a page/byte total on the sent PDFs alone ' +
			'would never have caught',
		async () => {
			const objects: InMemoryObjectStore = new InMemoryObjectStore();
			const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
			// Collapses to a single short paragraph once rendered as the signing
			// PDF (CommonMark merges consecutive blank lines), but the evidence
			// appendix dumps the raw text verbatim, one wrapped line per input
			// line: tens of thousands of blank lines become tens of thousands of
			// near-empty appendix lines.
			const blankLines: string = '\n'.repeat(60_000);
			const content: string = normalizeMarkdownContent(`# Title\n\n${blankLines}Visible text.\n`);
			let manifest: DocumentSetManifest | null = null;
			manifest = upsertMarkdownDocument(
				manifest,
				'documents/blank.md',
				await sha256Hex(new TextEncoder().encode(content)),
				() => MARKDOWN_BLANK_ID
			);
			const version: DraftVersion = await repository.commit(
				null,
				[
					{ path: 'documents/blank.md', content },
					{ path: 'document-set.json', content: serializeDocumentSet(manifest) }
				],
				'seed blank-line bundle',
				actor
			);
			const archiveKey: string = draftArchiveKey(ENVELOPE_ID, version.archiveSha256);
			await objects.putImmutable(archiveKey, {
				contentType: 'application/vnd.signkit.git-archive+gzip',
				body: version.archive,
				sha256: version.archiveSha256
			});
			const revision: ImmutableDraftRevision = {
				envelopeId: ENVELOPE_ID,
				commitSha: version.commitSha,
				archiveKey,
				archiveSha256: version.archiveSha256
			};

			await expect(
				new SentDocumentPdfService(objects, repository, noFields).publish(revision, sendContext())
			).rejects.toThrowError(expect.objectContaining({ reason: 'too_many_pages' }));
			// Nothing was persisted: the single sent document would have been
			// tiny, but the appendix it would carry at completion is not.
			expect((await objects.list({ prefix: 'sent-documents/' })).objects.length).toBe(0);
		}
	);
});
