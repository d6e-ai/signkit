import { describe, expect, it } from 'vitest';
import type { DraftDocument } from '$lib/ports/draft-repository';
import type { CompletionPdfFieldGeometry } from '$lib/ports/completion-pdf-evidence-store';
import {
	buildCompletionPdfManifest,
	buildCompletionPdfPages,
	canonicalPdfManifestJson,
	COMPLETION_PDF_MANIFEST_SCHEMA,
	renderCompletionPdf
} from './completion-pdf';
import {
	MAX_EVIDENCE_SUMMARY_PDF_BYTES,
	MAX_PUBLISHED_COMPLETION_PDF_BYTES
} from './completion-pdf-limits';
import { MAX_EXECUTED_PDF_BYTES } from './executed-pdf';
import { CompletionArtifactIntegrityError, type CompletionManifestV1 } from './completion-manifest';

const MANIFEST: CompletionManifestV1 = {
	schema: 'signkit-completion-manifest-v1',
	envelopeId: '01900000-0000-7000-8000-000000000001',
	title: 'Service Agreement',
	sentCommitSha: 'a'.repeat(40),
	draftArchiveSha256: 'b'.repeat(64),
	fieldGeneration: 1,
	completedAt: '2026-09-13T00:00:00.000Z',
	documents: [{ path: 'documents/agreement.md', sha256: 'c'.repeat(64) }],
	recipients: [
		{
			id: '01930000-0000-7000-8000-000000000001',
			role: 'signer',
			routingOrder: 1,
			status: 'completed',
			decisionEventId: '01960000-0000-7000-8000-000000000001',
			decisionAt: '2026-09-12T00:00:00.000Z'
		}
	],
	fields: [
		{
			id: '01940000-0000-7000-8000-000000000001',
			fieldType: 'signature',
			valueSha256: 'd'.repeat(64)
		}
	],
	auditProof: {
		anchorEventType: 'envelope.completed',
		anchorEventId: '01960000-0000-7000-8000-000000000002',
		headSequence: 5,
		verifiedEventCount: 5,
		hashChainVerified: true
	}
};

const DOCUMENTS: readonly DraftDocument[] = [
	{ path: 'documents/agreement.md', content: '# Agreement\n\nThis is the agreement text.' }
];

const GEOMETRY: readonly CompletionPdfFieldGeometry[] = [
	{
		id: '01940000-0000-7000-8000-000000000001',
		documentId: null,
		documentPath: 'documents/agreement.md',
		position: 1,
		recipientId: '01930000-0000-7000-8000-000000000001',
		fieldType: 'signature',
		required: true,
		geometry: { page: 2, x: 0.25, y: 0.5, width: 0.3, height: 0.05 }
	}
];

describe('buildCompletionPdfPages + renderCompletionPdf', () => {
	it('keeps the final artifact limit separate from the smaller evidence-summary limit', () => {
		expect(MAX_EXECUTED_PDF_BYTES).toBe(MAX_PUBLISHED_COMPLETION_PDF_BYTES);
		expect(MAX_PUBLISHED_COMPLETION_PDF_BYTES).toBe(32 * 1024 * 1024);
		expect(MAX_EVIDENCE_SUMMARY_PDF_BYTES).toBe(8 * 1024 * 1024);
	});

	it('is fully deterministic for identical inputs', () => {
		const pagesA = buildCompletionPdfPages(MANIFEST, DOCUMENTS, GEOMETRY);
		const pagesB = buildCompletionPdfPages(MANIFEST, DOCUMENTS, GEOMETRY);
		expect(pagesA).toEqual(pagesB);
		const pdfA = renderCompletionPdf(pagesA);
		const pdfB = renderCompletionPdf(pagesB);
		expect(Array.from(pdfA)).toEqual(Array.from(pdfB));
	});

	it('includes document content, field ink references, geometry, recipients, and audit proof', () => {
		const pages = buildCompletionPdfPages(MANIFEST, DOCUMENTS, GEOMETRY);
		const text = pages.flat().join('\n');
		expect(text).toContain('documents/agreement.md');
		expect(text).toContain('This is the agreement text.');
		expect(text).toContain('ink-sha256:' + 'd'.repeat(64));
		expect(text).toContain('documents/agreement.md#1 page 2 at 0.25,0.5 size 0.3x0.05');
		expect(text).toContain('01930000-0000-7000-8000-000000000001');
		expect(text).toContain('envelope.completed');
	});

	it('renders "unplaced" for a field with no geometry evidence rather than failing', () => {
		const pages = buildCompletionPdfPages(MANIFEST, DOCUMENTS, []);
		expect(pages.flat().join('\n')).toContain('unplaced');
	});

	it('never renders raw field values or recipient PII beyond what the manifest itself already allows', () => {
		const pages = buildCompletionPdfPages(MANIFEST, DOCUMENTS, GEOMETRY);
		const text = pages.flat().join('\n');
		expect(text).not.toContain('@');
	});

	it('emits a reference block for a PDF leaf and never inlines the document-set manifest', () => {
		const mixed: CompletionManifestV1 = {
			...MANIFEST,
			documentSetHash: 'e'.repeat(64),
			documents: [
				{
					id: '01900000-0000-7000-8000-000000000021',
					kind: 'markdown',
					position: 0,
					title: 'Agreement',
					path: 'documents/agreement.md',
					sha256: 'c'.repeat(64)
				},
				{
					id: '01900000-0000-7000-8000-000000000022',
					kind: 'pdf',
					position: 1,
					title: 'Schedule A',
					sha256: 'f'.repeat(64),
					byteSize: 812345,
					pageCount: 12
				}
			]
		};
		const text = buildCompletionPdfPages(mixed, DOCUMENTS, GEOMETRY).flat().join('\n');
		expect(text).toContain('Document set hash: ' + 'e'.repeat(64));
		expect(text).toContain('This is the agreement text.');
		expect(text).toContain('Kind: pdf');
		expect(text).toContain('Pages: 12');
		expect(text).toContain('SHA-256: ' + 'f'.repeat(64));
		expect(text).toContain('Size: 812345 bytes');
		expect(text).not.toContain('signkit-document-set-v1');
		expect(text).not.toContain('%PDF');
		expect(text).not.toContain(JSON.stringify(mixed.documents[1]));
	});
});

describe('buildCompletionPdfManifest', () => {
	it('records the pdf digest, manifest pointer, ink references, and geometry', async () => {
		const pdfBytes = renderCompletionPdf(buildCompletionPdfPages(MANIFEST, DOCUMENTS, GEOMETRY));
		const pdfManifest = await buildCompletionPdfManifest({
			manifest: MANIFEST,
			manifestSha256: 'e'.repeat(64),
			pdfBytes,
			fieldGeometry: GEOMETRY,
			artifactKind: 'executed-agreement-v1',
			pageCount: 4,
			appendixFirstPage: 3,
			documentPages: new Map([
				['01900000-0000-7000-8000-000000000021', { firstPage: 1, lastPage: 2 }]
			])
		});

		expect(pdfManifest.schema).toBe(COMPLETION_PDF_MANIFEST_SCHEMA);
		expect(pdfManifest.envelopeId).toBe(MANIFEST.envelopeId);
		expect(pdfManifest.manifestSha256).toBe('e'.repeat(64));
		expect(pdfManifest.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(pdfManifest.documents).toEqual([
			{ path: 'documents/agreement.md', sha256: 'c'.repeat(64) }
		]);
		expect(pdfManifest.fields).toEqual([
			{
				id: '01940000-0000-7000-8000-000000000001',
				fieldType: 'signature',
				inkSha256: 'd'.repeat(64),
				geometry: {
					documentId: null,
					documentPath: 'documents/agreement.md',
					position: 1,
					page: 2,
					x: 0.25,
					y: 0.5,
					width: 0.3,
					height: 0.05
				}
			}
		]);
		expect(pdfManifest.generatedAt).toBe(MANIFEST.completedAt);
	});

	it('records null geometry for a legacy evidence summary with no placement rows', async () => {
		const pdfBytes = renderCompletionPdf(buildCompletionPdfPages(MANIFEST, DOCUMENTS, []));
		const pdfManifest = await buildCompletionPdfManifest({
			manifest: MANIFEST,
			manifestSha256: 'e'.repeat(64),
			pdfBytes,
			fieldGeometry: [],
			artifactKind: 'evidence-summary-v1',
			pageCount: 1
		});
		expect(pdfManifest.artifactKind).toBe('evidence-summary-v1');
		expect(pdfManifest.fields[0].geometry).toBeNull();
		expect(pdfManifest.appendixFirstPage).toBeNull();
	});

	it.each([
		['no placement row at all', []],
		[
			'a placement row without frozen geometry',
			[{ ...GEOMETRY[0], geometry: null }] as readonly CompletionPdfFieldGeometry[]
		]
	])('refuses to publish an executed agreement with %s', async (_label, fieldGeometry) => {
		const pdfBytes = renderCompletionPdf(buildCompletionPdfPages(MANIFEST, DOCUMENTS, []));

		await expect(
			buildCompletionPdfManifest({
				manifest: MANIFEST,
				manifestSha256: 'e'.repeat(64),
				pdfBytes,
				fieldGeometry,
				artifactKind: 'executed-agreement-v1',
				pageCount: 2
			})
		).rejects.toThrowError(CompletionArtifactIntegrityError);
	});

	it('serializes to deterministic fixed-key JSON', async () => {
		const pdfBytes = renderCompletionPdf(buildCompletionPdfPages(MANIFEST, DOCUMENTS, GEOMETRY));
		const pdfManifest = await buildCompletionPdfManifest({
			manifest: MANIFEST,
			manifestSha256: 'e'.repeat(64),
			pdfBytes,
			fieldGeometry: GEOMETRY,
			artifactKind: 'executed-agreement-v1',
			pageCount: 4
		});
		expect(canonicalPdfManifestJson(pdfManifest)).toBe(canonicalPdfManifestJson(pdfManifest));
	});
});
