import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { exportMarkdownToDocx } from './docx-export';
import {
	CLOUDFLARE_DOCX_IMPORT_LIMITS,
	DocxImportError,
	importDocxToMarkdown,
	MAX_DOCX_INPUT_BYTES,
	resolveDocxImportLimits
} from './docx-import';

const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';

function wrapDocumentXml(bodyXml: string): Uint8Array {
	const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyXml}</w:body>
</w:document>`;
	return zipSync({ 'word/document.xml': new TextEncoder().encode(xml) });
}

describe('importDocxToMarkdown', () => {
	it('round-trips a document produced by exportMarkdownToDocx', () => {
		const source =
			'# Master Agreement\n\nThis is **bold** and *italic* text.\n\nA second paragraph.\n';
		const docx = exportMarkdownToDocx({
			commitSha: COMMIT_SHA,
			documents: [{ path: 'documents/agreement.md', content: source }]
		});
		const markdown = importDocxToMarkdown(docx);
		expect(markdown).toContain('# Master Agreement');
		expect(markdown).toContain('**bold**');
		expect(markdown).toContain('*italic*');
		expect(markdown).toContain('A second paragraph.');
		expect(markdown.endsWith('\n')).toBe(true);
	});

	it('extracts paragraphs, headings, bold, italic, and line breaks from hand-built OOXML', () => {
		const docx = wrapDocumentXml(
			'<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Section Two</w:t></w:r></w:p>' +
				'<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold </w:t></w:r>' +
				'<w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r>' +
				'<w:r><w:br/><w:t>next line</w:t></w:r></w:p>'
		);
		const markdown = importDocxToMarkdown(docx);
		expect(markdown).toContain('## Section Two');
		expect(markdown).toContain('**Bold**');
		expect(markdown).toContain('*italic*');
		expect(markdown).toContain('next line');
	});

	it('decodes XML entities and numeric character references in text', () => {
		const docx = wrapDocumentXml(
			'<w:p><w:r><w:t>Tom &amp; Jerry &lt;3&gt; &#65;&#x42;</w:t></w:r></w:p>'
		);
		const markdown = importDocxToMarkdown(docx);
		expect(markdown).toContain('Tom & Jerry');
		expect(markdown).toContain('AB');
	});

	it('escapes Markdown-significant characters found in run text', () => {
		const docx = wrapDocumentXml(
			'<w:p><w:r><w:t>* not a list * and _not_ emphasis</w:t></w:r></w:p>'
		);
		const markdown = importDocxToMarkdown(docx);
		expect(markdown).toContain('\\* not a list \\*');
		expect(markdown).toContain('\\_not\\_');
	});

	it('rejects an empty upload', () => {
		expect(() => importDocxToMarkdown(new Uint8Array(0))).toThrow(DocxImportError);
	});

	it('rejects an oversized upload before attempting to unzip it', () => {
		const oversized = new Uint8Array(MAX_DOCX_INPUT_BYTES + 1);
		oversized[0] = 0x50;
		oversized[1] = 0x4b;
		expect(() => importDocxToMarkdown(oversized)).toThrow(DocxImportError);
	});

	it('rejects a non-ZIP file', () => {
		const notZip = new TextEncoder().encode('this is not a docx file at all');
		try {
			importDocxToMarkdown(notZip);
			expect.unreachable('expected importDocxToMarkdown to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(DocxImportError);
			expect((error as DocxImportError).code).toBe('invalid_zip');
		}
	});

	it('rejects a ZIP whose declared word/document.xml size exceeds the per-entry bound', () => {
		// A ZIP bomb is detected from the central directory's *declared*
		// uncompressed size, before any inflate work happens: this fake
		// document.xml claims to be far larger than the per-entry cap while its
		// actual compressed payload is tiny.
		const hugeButCompressible = 'A'.repeat(21 * 1024 * 1024);
		const docx = zipSync(
			{ 'word/document.xml': new TextEncoder().encode(hugeButCompressible) },
			{ level: 9 }
		);
		try {
			importDocxToMarkdown(docx);
			expect.unreachable('expected importDocxToMarkdown to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(DocxImportError);
			expect(['entry_too_large', 'too_large']).toContain((error as DocxImportError).code);
		}
	});

	it('rejects a ZIP with an excessive number of entries', () => {
		const files: Record<string, Uint8Array> = {};
		for (let index = 0; index < 2_100; index += 1) {
			files[`junk/${index}.txt`] = new Uint8Array([0]);
		}
		const docx = zipSync(files);
		try {
			importDocxToMarkdown(docx);
			expect.unreachable('expected importDocxToMarkdown to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(DocxImportError);
			expect((error as DocxImportError).code).toBe('too_many_entries');
		}
	});

	it('rejects a ZIP with no word/document.xml', () => {
		const docx = zipSync({ 'readme.txt': new TextEncoder().encode('hello') });
		try {
			importDocxToMarkdown(docx);
			expect.unreachable('expected importDocxToMarkdown to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(DocxImportError);
			expect((error as DocxImportError).code).toBe('missing_document_xml');
		}
	});

	it('rejects malformed XML with an unterminated tag', () => {
		const docx = zipSync({
			'word/document.xml': new TextEncoder().encode('<w:document><w:body><w:p')
		});
		try {
			importDocxToMarkdown(docx);
			expect.unreachable('expected importDocxToMarkdown to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(DocxImportError);
			expect((error as DocxImportError).code).toBe('invalid_xml');
		}
	});

	it('selects Cloudflare bounds when the D1 binding is present', () => {
		expect(resolveDocxImportLimits({ env: { DB: {} } }).maxInputBytes).toBe(
			CLOUDFLARE_DOCX_IMPORT_LIMITS.maxInputBytes
		);
		expect(resolveDocxImportLimits(undefined).maxInputBytes).toBe(MAX_DOCX_INPUT_BYTES);
	});

	it('rejects uploads that fit Node but exceed the Cloudflare input bound', () => {
		const oversized = new Uint8Array(CLOUDFLARE_DOCX_IMPORT_LIMITS.maxInputBytes + 1);
		oversized[0] = 0x50;
		oversized[1] = 0x4b;
		try {
			importDocxToMarkdown(oversized, CLOUDFLARE_DOCX_IMPORT_LIMITS);
			expect.unreachable('expected importDocxToMarkdown to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(DocxImportError);
			expect((error as DocxImportError).code).toBe('too_large');
		}
	});

	it('rejects a ZIP whose entry count exceeds the Cloudflare bound while remaining under Node', () => {
		const files: Record<string, Uint8Array> = {
			'word/document.xml': new TextEncoder().encode(
				'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:body></w:document>'
			)
		};
		for (let index = 0; index < CLOUDFLARE_DOCX_IMPORT_LIMITS.maxZipEntries + 1; index += 1) {
			files[`junk/${index}.txt`] = new Uint8Array([0]);
		}
		const docx = zipSync(files);
		try {
			importDocxToMarkdown(docx, CLOUDFLARE_DOCX_IMPORT_LIMITS);
			expect.unreachable('expected Cloudflare-bounded import to throw');
		} catch (error) {
			expect(error).toBeInstanceOf(DocxImportError);
			expect((error as DocxImportError).code).toBe('too_many_entries');
		}
		expect(importDocxToMarkdown(docx)).toContain('Hi');
	});
});
