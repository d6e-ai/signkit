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
import {
	MAX_SENT_PDF_DOCUMENTS,
	parseSentPdfObjectKey,
	SentDocumentPdfError,
	SentDocumentPdfService,
	sentPdfObjectKey,
	sha256Hex,
	renderRevisionPdf
} from './sent-document-pdf';

const ORGANIZATION_ID = '01900000-0000-7000-8000-000000000002';
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
	const archiveKey: string = draftArchiveKey(ORGANIZATION_ID, ENVELOPE_ID, version.archiveSha256);
	await objects.putImmutable(archiveKey, {
		contentType: 'application/vnd.signkit.git-archive+gzip',
		body: version.archive,
		sha256: version.archiveSha256
	});
	if (includeUploadedPdf) {
		await objects.putImmutable(uploadedPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, uploadedSha256), {
			contentType: 'application/pdf',
			body: uploadedBytes,
			sha256: uploadedSha256
		});
	}
	return {
		revision: {
			organizationId: ORGANIZATION_ID,
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
	it('is content-addressed and tenant-scoped, and round-trips', () => {
		const sha256: string = 'a'.repeat(64);
		const key: string = sentPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, sha256);
		expect(key).toBe(
			`sent-documents/v1/organizations/${ORGANIZATION_ID}/envelopes/${ENVELOPE_ID}/sha256/${sha256}.pdf`
		);
		expect(parseSentPdfObjectKey(key)).toEqual({
			organizationId: ORGANIZATION_ID,
			envelopeId: ENVELOPE_ID,
			sha256
		});
	});

	it('escapes scope segments so no identifier can climb out of its prefix', () => {
		const key: string = sentPdfObjectKey('../escape', 'env/../other', 'b'.repeat(64));
		expect(key).not.toContain('..');
		expect(key.split('/')).toHaveLength(8);
		expect(parseSentPdfObjectKey(key)).toEqual({
			organizationId: '../escape',
			envelopeId: 'env/../other',
			sha256: 'b'.repeat(64)
		});
	});

	it('rejects a digest that is not a SHA-256 hex string', () => {
		expect(() => sentPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, 'nope')).toThrow(
			SentDocumentPdfError
		);
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
		const service: SentDocumentPdfService = new SentDocumentPdfService(objects, repository);

		const artifact = await service.publish(seeded.revision);

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
		const service: SentDocumentPdfService = new SentDocumentPdfService(objects, repository);

		const first = await service.publish(seeded.revision);
		const second = await service.publish(seeded.revision);
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
			new SentDocumentPdfService(objects, repository).publish(seeded.revision)
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
		await hostile.putImmutable(
			uploadedPdfObjectKey(ORGANIZATION_ID, ENVELOPE_ID, seeded.uploadedSha256),
			{
				contentType: 'application/pdf',
				body: seeded.uploadedBytes,
				sha256: seeded.uploadedSha256
			}
		);

		await expect(
			new SentDocumentPdfService(hostile, repository).publish(seeded.revision)
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
