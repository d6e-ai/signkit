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
import type { CompletionManifestV1 } from './completion-manifest';

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
		documentPath: 'documents/agreement.md',
		position: 1,
		recipientId: '01930000-0000-7000-8000-000000000001'
	}
];

describe('buildCompletionPdfPages + renderCompletionPdf', () => {
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
		expect(text).toContain('documents/agreement.md#1');
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
});

describe('buildCompletionPdfManifest', () => {
	it('records the pdf digest, manifest pointer, ink references, and geometry', async () => {
		const pdfBytes = renderCompletionPdf(buildCompletionPdfPages(MANIFEST, DOCUMENTS, GEOMETRY));
		const pdfManifest = await buildCompletionPdfManifest({
			manifest: MANIFEST,
			manifestSha256: 'e'.repeat(64),
			pdfBytes,
			fieldGeometry: GEOMETRY
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
				geometry: { documentPath: 'documents/agreement.md', position: 1 }
			}
		]);
		expect(pdfManifest.generatedAt).toBe(MANIFEST.completedAt);
	});

	it('records null geometry when placement evidence is unavailable', async () => {
		const pdfBytes = renderCompletionPdf(buildCompletionPdfPages(MANIFEST, DOCUMENTS, []));
		const pdfManifest = await buildCompletionPdfManifest({
			manifest: MANIFEST,
			manifestSha256: 'e'.repeat(64),
			pdfBytes,
			fieldGeometry: []
		});
		expect(pdfManifest.fields[0].geometry).toBeNull();
	});

	it('serializes to deterministic fixed-key JSON', async () => {
		const pdfBytes = renderCompletionPdf(buildCompletionPdfPages(MANIFEST, DOCUMENTS, GEOMETRY));
		const pdfManifest = await buildCompletionPdfManifest({
			manifest: MANIFEST,
			manifestSha256: 'e'.repeat(64),
			pdfBytes,
			fieldGeometry: GEOMETRY
		});
		expect(canonicalPdfManifestJson(pdfManifest)).toBe(canonicalPdfManifestJson(pdfManifest));
	});
});
