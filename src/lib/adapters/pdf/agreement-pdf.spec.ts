import { describe, expect, it } from 'vitest';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import {
	AGREEMENT_PDF_PAGE_HEIGHT,
	AGREEMENT_PDF_PAGE_WIDTH,
	AgreementPdfBoundExceededError,
	MAX_AGREEMENT_PDF_PAGES,
	renderAgreementPdf,
	type AgreementPdfDocument
} from './agreement-pdf';
import { documentFont, verifyDocumentFontDigest } from './document-font';
import { PDF_UNSUPPORTED_CHARACTER_PLACEHOLDER } from './deterministic-pdf-writer';

function document(title: string, markdown: string): AgreementPdfDocument {
	return { title, nodes: renderRecipientMarkdown(markdown).nodes };
}

const JAPANESE = '本契約は、甲と乙との間で締結される。第一条（目的）業務委託の範囲を定める。';

describe('agreement PDF rendering', () => {
	it('ships a font whose bytes match the digest recorded beside them', async () => {
		await expect(verifyDocumentFontDigest()).resolves.toBe(true);
	});

	it('has a real glyph for every character of a Japanese agreement', () => {
		const font = documentFont();
		for (const character of `${JAPANESE}ABCdef0123 —「」`) {
			const codePoint: number = character.codePointAt(0) ?? 0;
			// Zero is .notdef: the old Courier writer substituted '?' here, which
			// is exactly the failure this renderer exists to avoid.
			expect(font.glyphIdForCodePoint(codePoint)).not.toBe(0);
		}
		expect(PDF_UNSUPPORTED_CHARACTER_PLACEHOLDER).toBe('?');
	});

	it('embeds only a subset of the typeface, not the whole 2 MB font', () => {
		const result = renderAgreementPdf([document('Agreement', `# Agreement\n\n${JAPANESE}\n`)]);
		expect(result.bytes.byteLength).toBeGreaterThan(1024);
		// A few hundred glyphs, not seven thousand.
		expect(result.bytes.byteLength).toBeLessThan(400 * 1024);
	});

	it('is a pure function of its input, so the artifact can be content-addressed', () => {
		const pages: AgreementPdfDocument[] = [document('Agreement', `# Agreement\n\n${JAPANESE}\n`)];
		const first = renderAgreementPdf(pages);
		const second = renderAgreementPdf(pages);
		expect(Array.from(first.bytes)).toEqual(Array.from(second.bytes));
	});

	it('starts every document on its own page and reports the page map', () => {
		const result = renderAgreementPdf([
			document('First', '# First\n\nShort.\n'),
			document('Second', `# Second\n\n${JAPANESE.repeat(60)}\n`),
			document('Third', '# Third\n\nAlso short.\n')
		]);

		expect(result.pageWidth).toBe(AGREEMENT_PDF_PAGE_WIDTH);
		expect(result.pageHeight).toBe(AGREEMENT_PDF_PAGE_HEIGHT);
		expect(result.documents).toHaveLength(3);
		expect(result.documents[0]).toMatchObject({ index: 0, title: 'First', firstPage: 1 });
		expect(result.documents[1].firstPage).toBe(result.documents[0].lastPage + 1);
		expect(result.documents[2].firstPage).toBe(result.documents[1].lastPage + 1);
		expect(result.documents[2].lastPage).toBe(result.pageCount);
		// A long document really does take more than one page.
		expect(result.documents[1].lastPage).toBeGreaterThan(result.documents[1].firstPage);
	});

	it('does not inject the metadata title into page content', () => {
		const body = 'Only authored body text.\n';
		const named = renderAgreementPdf([document('agreement', body)]);
		const renamed = renderAgreementPdf([document('zxq-synthetic-title', body)]);
		expect(Array.from(named.bytes)).toEqual(Array.from(renamed.bytes));
		expect(named.documents[0]?.title).toBe('agreement');
		expect(renamed.documents[0]?.title).toBe('zxq-synthetic-title');
	});

	it('still occupies a page for an empty document so the next document starts after it', () => {
		const result = renderAgreementPdf([
			document('Cover', ''),
			document('Agreement', 'Short body.\n')
		]);
		expect(result.documents[0]).toMatchObject({
			index: 0,
			title: 'Cover',
			firstPage: 1,
			lastPage: 1
		});
		expect(result.documents[1]).toMatchObject({
			index: 1,
			title: 'Agreement',
			firstPage: 2,
			lastPage: 2
		});
		expect(result.pageCount).toBe(2);
	});

	it('produces a structurally valid PDF with one page object per rendered page', () => {
		const result = renderAgreementPdf([document('Agreement', '# Agreement\n\nHello.\n')]);
		const text: string = new TextDecoder('latin1').decode(result.bytes);
		expect(text.startsWith('%PDF-1.7')).toBe(true);
		expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
		expect(text).toContain('/Type /Catalog');
		expect(text).toContain('/Subtype /Type0');
		expect(text).toContain('/Encoding /Identity-H');
		expect(text).toContain('/CIDToGIDMap /Identity');
		expect(text).toContain('/FontFile2');
		expect(text).toContain('/ToUnicode');
		expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBe(result.pageCount);
	});

	it('renders sanitized content only: no images, no scripts, no external references', () => {
		const result = renderAgreementPdf([
			document(
				'Agreement',
				'![tracker](https://tracker.example/pixel.gif)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n'
			)
		]);
		const text: string = new TextDecoder('latin1').decode(result.bytes);
		expect(text).not.toContain('tracker.example');
		expect(text).not.toContain('javascript:');
		expect(text).not.toContain('/JavaScript');
		expect(text).not.toContain('/URI');
		expect(text).not.toContain('/EmbeddedFile');
	});

	it('refuses a set of documents that would exceed the page bound', () => {
		// Every document takes at least one page, so one more document than the
		// bound is the cheapest way to prove the renderer stops rather than
		// grinding through an unbounded artifact.
		const many: AgreementPdfDocument[] = Array.from(
			{ length: MAX_AGREEMENT_PDF_PAGES + 1 },
			(_unused, index: number): AgreementPdfDocument =>
				document(`Document ${index + 1}`, 'Short.\n')
		);
		expect(() => renderAgreementPdf(many)).toThrow(AgreementPdfBoundExceededError);
	});

	it('refuses a document with too many blocks', () => {
		const enormous: string = 'Paragraph.\n\n'.repeat(21_000);
		expect(() => renderAgreementPdf([document('Huge', enormous)])).toThrow(
			AgreementPdfBoundExceededError
		);
	});

	it('refuses to render nothing at all', () => {
		expect(() => renderAgreementPdf([])).toThrow(AgreementPdfBoundExceededError);
	});
});
