import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { renderAgreementPdf } from '$lib/adapters/pdf/agreement-pdf';
import { buildFixturePdf, textPage } from '$lib/adapters/pdf/pdf-fixture-test-support';
import { parsePdfPageMetadata } from '$lib/adapters/pdf/pdf-page-metadata';
import { drawnSignaturePng } from '$lib/adapters/pdf/png-image-test-support';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import {
	buildExecutedPdf,
	ExecutedPdfBoundExceededError,
	ExecutedPdfIntegrityError,
	parseExecutedFieldValue,
	type ExecutedPdfDocument,
	type ExecutedPdfField,
	type ExecutedPdfResult
} from './executed-pdf';

const SIGNATURE_SHA256: string = 'a'.repeat(64);

function markdownDocument(
	overrides: Partial<ExecutedPdfDocument> = {},
	body: string = 'The parties agree to the terms of this agreement.'
): ExecutedPdfDocument {
	const rendered = renderAgreementPdf([
		{ title: 'agreement', nodes: renderRecipientMarkdown(body).nodes }
	]);
	return {
		id: 'document-markdown',
		title: 'agreement',
		position: 0,
		kind: 'markdown',
		bytes: rendered.bytes,
		pageCount: rendered.pageCount,
		...overrides
	};
}

/** Stands in for an uploaded original: a PDF SignKit did not render itself. */
function uploadedDocument(overrides: Partial<ExecutedPdfDocument> = {}): ExecutedPdfDocument {
	return {
		id: 'document-uploaded',
		title: 'uploaded',
		position: 1,
		kind: 'pdf',
		bytes: buildFixturePdf([textPage('Uploaded original page'), textPage('Signature page')]),
		pageCount: 2,
		...overrides
	};
}

function field(overrides: Partial<ExecutedPdfField> = {}): ExecutedPdfField {
	return {
		id: 'field-1',
		documentId: 'document-markdown',
		fieldType: 'signature',
		geometry: { page: 1, x: 0.1, y: 0.7, width: 0.35, height: 0.08 },
		value: { kind: 'text', text: 'Alex Signer' },
		...overrides
	};
}

async function pageText(bytes: Uint8Array, pageNumber: number): Promise<string> {
	const task = getDocument({ data: Uint8Array.from(bytes) });
	const document = await task.promise;
	try {
		const content = await (await document.getPage(pageNumber)).getTextContent();
		return content.items
			.map((item: unknown): string =>
				typeof item === 'object' && item !== null && 'str' in item ? String(item.str) : ''
			)
			.join('');
	} finally {
		await task.destroy();
	}
}

describe('buildExecutedPdf', () => {
	it('renders a Markdown agreement with a typed signature drawn over it', async () => {
		const result: ExecutedPdfResult = buildExecutedPdf({
			documents: [markdownDocument()],
			fields: [field()]
		});

		expect(result.renderedFieldCount).toBe(1);
		expect(result.documents).toEqual([
			{ documentId: 'document-markdown', firstPage: 1, lastPage: result.pageCount }
		]);
		expect(result.appendixFirstPage).toBeNull();
		const text: string = await pageText(result.bytes, 1);
		expect(text).toContain('The parties agree to the terms of this agreement.');
		expect(text).toContain('Alex Signer');
	});

	it('keeps an uploaded PDF as the base and overlays the value on its own page', async () => {
		const uploaded: ExecutedPdfDocument = uploadedDocument({ position: 0 });

		const result: ExecutedPdfResult = buildExecutedPdf({
			documents: [uploaded],
			fields: [
				field({
					documentId: 'document-uploaded',
					fieldType: 'text',
					geometry: { page: 2, x: 0.1, y: 0.5, width: 0.4, height: 0.05 },
					value: { kind: 'text', text: 'Counterparty' }
				})
			]
		});

		expect(result.pageCount).toBe(2);
		await expect(pageText(result.bytes, 1)).resolves.toContain('Uploaded original page');
		const second: string = await pageText(result.bytes, 2);
		expect(second).toContain('Signature page');
		expect(second).toContain('Counterparty');
	});

	it('composites a drawn signature from its verified asset bytes', () => {
		const result: ExecutedPdfResult = buildExecutedPdf({
			documents: [markdownDocument()],
			fields: [
				field({
					value: { kind: 'drawn-signature', sha256: SIGNATURE_SHA256 },
					signaturePngBytes: drawnSignaturePng(64, 24)
				})
			]
		});

		const raw: string = new TextDecoder('latin1').decode(result.bytes);
		expect(raw).toContain('/Subtype /Image');
		expect(raw).toContain('/SMask');
	});

	it('orders multiple documents by position and reports each page range', () => {
		const markdown: ExecutedPdfDocument = markdownDocument({ position: 1 });
		const uploaded: ExecutedPdfDocument = uploadedDocument({ position: 0 });

		const result: ExecutedPdfResult = buildExecutedPdf({
			documents: [markdown, uploaded],
			fields: [
				field({
					documentId: 'document-uploaded',
					value: { kind: 'checkbox', checked: true },
					fieldType: 'checkbox'
				}),
				field({ id: 'field-2' })
			]
		});

		const markdownPages: number = parsePdfPageMetadata(markdown.bytes).pageCount;
		expect(result.documents).toEqual([
			{ documentId: 'document-uploaded', firstPage: 1, lastPage: 2 },
			{ documentId: 'document-markdown', firstPage: 3, lastPage: 2 + markdownPages }
		]);
		expect(result.renderedFieldCount).toBe(2);
	});

	it('appends the evidence summary after the agreement and reports its first page', () => {
		const appendix = renderAgreementPdf([
			{ title: 'evidence', nodes: renderRecipientMarkdown('Completion evidence.').nodes }
		]);

		const result: ExecutedPdfResult = buildExecutedPdf({
			documents: [markdownDocument()],
			fields: [field()],
			appendixPdfBytes: appendix.bytes
		});

		expect(result.appendixFirstPage).toBe(result.pageCount - appendix.pageCount + 1);
	});

	it('draws nothing for a blank optional field or an unchecked box', () => {
		const result: ExecutedPdfResult = buildExecutedPdf({
			documents: [markdownDocument()],
			fields: [
				field({ value: { kind: 'empty' } }),
				field({ id: 'field-2', fieldType: 'checkbox', value: { kind: 'checkbox', checked: false } })
			]
		});

		expect(result.renderedFieldCount).toBe(0);
	});

	it('produces byte-identical output for identical evidence', () => {
		const inputs = () => ({
			documents: [markdownDocument(), uploadedDocument()],
			fields: [
				field({
					value: { kind: 'drawn-signature', sha256: SIGNATURE_SHA256 },
					signaturePngBytes: drawnSignaturePng()
				}),
				field({
					id: 'field-2',
					documentId: 'document-uploaded',
					fieldType: 'date',
					geometry: { page: 1, x: 0.5, y: 0.5, width: 0.2, height: 0.04 },
					value: { kind: 'text', text: '2026-09-15' }
				})
			]
		});

		const first: ExecutedPdfResult = buildExecutedPdf(inputs());
		const second: ExecutedPdfResult = buildExecutedPdf(inputs());

		expect([...first.bytes]).toEqual([...second.bytes]);
	});

	it('draws fields in a fixed order regardless of how the store returned them', () => {
		const ordered: ExecutedPdfField[] = [
			field({ id: 'field-a', geometry: { page: 1, x: 0.1, y: 0.2, width: 0.2, height: 0.05 } }),
			field({ id: 'field-b', geometry: { page: 1, x: 0.1, y: 0.6, width: 0.2, height: 0.05 } })
		];

		const forward: ExecutedPdfResult = buildExecutedPdf({
			documents: [markdownDocument()],
			fields: ordered
		});
		const reversed: ExecutedPdfResult = buildExecutedPdf({
			documents: [markdownDocument()],
			fields: [...ordered].reverse()
		});

		expect([...forward.bytes]).toEqual([...reversed.bytes]);
	});

	it.each([
		['missing geometry', field({ geometry: null }), 'missing_geometry'],
		[
			'a coordinate past the page edge',
			field({ geometry: { page: 1, x: 0.9, y: 0.1, width: 0.3, height: 0.05 } }),
			'invalid_geometry'
		],
		[
			'a zero-height box',
			field({ geometry: { page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0 } }),
			'invalid_geometry'
		],
		[
			'a page the document does not have',
			field({ geometry: { page: 9, x: 0.1, y: 0.1, width: 0.3, height: 0.05 } }),
			'page_out_of_range'
		],
		['an unknown document', field({ documentId: 'document-missing' }), 'unknown_document']
	])('fails closed on %s', (_label, invalid, reason) => {
		expect(() =>
			buildExecutedPdf({ documents: [markdownDocument()], fields: [invalid] })
		).toThrowError(expect.objectContaining({ reason }));
	});

	it('fails closed when a drawn signature asset is absent', () => {
		expect(() =>
			buildExecutedPdf({
				documents: [markdownDocument()],
				fields: [field({ value: { kind: 'drawn-signature', sha256: SIGNATURE_SHA256 } })]
			})
		).toThrowError(expect.objectContaining({ reason: 'missing_signature_asset' }));
	});

	it('fails closed when a drawn signature asset is not a decodable image', () => {
		expect(() =>
			buildExecutedPdf({
				documents: [markdownDocument()],
				fields: [
					field({
						value: { kind: 'drawn-signature', sha256: SIGNATURE_SHA256 },
						signaturePngBytes: new Uint8Array(64).fill(0x89)
					})
				]
			})
		).toThrowError(ExecutedPdfIntegrityError);
	});

	it('fails closed when a document no longer paginates the way its document set pinned', () => {
		expect(() =>
			buildExecutedPdf({
				documents: [markdownDocument({ pageCount: 7 })],
				fields: [field()]
			})
		).toThrowError(expect.objectContaining({ reason: 'page_count_mismatch' }));
	});

	it('fails closed when a document is not a readable PDF', () => {
		expect(() =>
			buildExecutedPdf({
				documents: [markdownDocument({ bytes: new TextEncoder().encode('not a pdf') })],
				fields: [field()]
			})
		).toThrowError(expect.objectContaining({ reason: 'invalid_document' }));
	});

	it('fails closed when the executed agreement exceeds its size budget', () => {
		expect(() =>
			buildExecutedPdf({
				documents: [markdownDocument()],
				fields: [field()],
				maxOutputBytes: 1024
			})
		).toThrowError(ExecutedPdfBoundExceededError);
	});

	it('maps image working-set exhaustion to a completion bound error', () => {
		expect(() =>
			buildExecutedPdf({
				documents: [markdownDocument()],
				fields: [
					field({
						value: { kind: 'drawn-signature', sha256: SIGNATURE_SHA256 },
						signaturePngBytes: drawnSignaturePng(8, 4)
					})
				],
				maxImageWorkingSetBytes: 1
			})
		).toThrowError(ExecutedPdfBoundExceededError);
	});

	it('maps resident source exhaustion without an image to a completion bound error', () => {
		expect(() =>
			buildExecutedPdf({
				documents: [markdownDocument()],
				fields: [],
				maxImageWorkingSetBytes: 1
			})
		).toThrowError(ExecutedPdfBoundExceededError);
	});

	it('fails closed when the envelope has more documents than the bound allows', () => {
		const documents: ExecutedPdfDocument[] = Array.from({ length: 21 }, (_, index) =>
			markdownDocument({ id: `document-${index}`, position: index })
		);

		expect(() => buildExecutedPdf({ documents, fields: [] })).toThrowError(
			ExecutedPdfBoundExceededError
		);
	});

	it('rejects an empty document set', () => {
		expect(() => buildExecutedPdf({ documents: [], fields: [] })).toThrowError(
			expect.objectContaining({ reason: 'no_documents' })
		);
	});
});

describe('parseExecutedFieldValue', () => {
	it('reads a drawn signature reference as its asset digest', () => {
		expect(
			parseExecutedFieldValue('signature', JSON.stringify(`sig:sha256:${SIGNATURE_SHA256}`))
		).toEqual({ kind: 'drawn-signature', sha256: SIGNATURE_SHA256 });
	});

	it('reads a typed signature, text, and date as text', () => {
		expect(parseExecutedFieldValue('signature', '"Alex Signer"')).toEqual({
			kind: 'text',
			text: 'Alex Signer'
		});
		expect(parseExecutedFieldValue('date', '"2026-09-15"')).toEqual({
			kind: 'text',
			text: '2026-09-15'
		});
	});

	it('reads a checkbox as a boolean and an empty string as no value', () => {
		expect(parseExecutedFieldValue('checkbox', 'true')).toEqual({
			kind: 'checkbox',
			checked: true
		});
		expect(parseExecutedFieldValue('text', '""')).toEqual({ kind: 'empty' });
	});

	it.each([
		['checkbox', '"yes"'],
		['text', 'true'],
		['signature', '{'],
		['signature', JSON.stringify('sig:sha256:not-a-digest')]
	])('fails closed on a %s value of %s', (fieldType, valueJson) => {
		expect(() =>
			parseExecutedFieldValue(fieldType as Parameters<typeof parseExecutedFieldValue>[0], valueJson)
		).toThrowError(ExecutedPdfIntegrityError);
	});
});
