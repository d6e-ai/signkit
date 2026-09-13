import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { DocxExportError, exportMarkdownToDocx } from './docx-export';

const COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';

function documentXmlFrom(bytes: Uint8Array): string {
	const files = unzipSync(bytes);
	const documentXml = files['word/document.xml'];
	expect(documentXml).toBeDefined();
	return new TextDecoder().decode(documentXml);
}

describe('exportMarkdownToDocx', () => {
	it('produces a well-formed ZIP with the required OOXML parts', () => {
		const bytes = exportMarkdownToDocx({
			commitSha: COMMIT_SHA,
			documents: [{ path: 'documents/agreement.md', content: '# Agreement\n\nHello world.\n' }]
		});
		const files = unzipSync(bytes);
		expect(Object.keys(files)).toEqual(
			expect.arrayContaining([
				'[Content_Types].xml',
				'_rels/.rels',
				'word/document.xml',
				'word/styles.xml',
				'word/_rels/document.xml.rels',
				'docProps/core.xml'
			])
		);
	});

	it('renders headings, bold, and italic as WordprocessingML markup', () => {
		const bytes = exportMarkdownToDocx({
			commitSha: COMMIT_SHA,
			documents: [
				{
					path: 'documents/agreement.md',
					content: '# Master Agreement\n\nThis is **bold** and *italic* text.\n'
				}
			]
		});
		const xml = documentXmlFrom(bytes);
		expect(xml).toContain('w:pStyle w:val="Heading1"');
		expect(xml).toContain('Master Agreement');
		expect(xml).toContain('<w:b/>');
		expect(xml).toContain('<w:i/>');
		expect(xml).toContain('bold');
		expect(xml).toContain('italic');
	});

	it('pins the commit SHA into docProps/core.xml', () => {
		const bytes = exportMarkdownToDocx({
			commitSha: COMMIT_SHA,
			documents: [{ path: 'documents/agreement.md', content: 'Agreement text.\n' }]
		});
		const files = unzipSync(bytes);
		const core = new TextDecoder().decode(files['docProps/core.xml']);
		expect(core).toContain(COMMIT_SHA);
	});

	it('concatenates multiple documents into one document.xml body', () => {
		const bytes = exportMarkdownToDocx({
			commitSha: COMMIT_SHA,
			documents: [
				{ path: 'documents/a.md', content: '# First\n' },
				{ path: 'documents/b.md', content: '# Second\n' }
			]
		});
		const xml = documentXmlFrom(bytes);
		expect(xml).toContain('First');
		expect(xml).toContain('Second');
	});

	it('rejects an empty document manifest', () => {
		expect(() => exportMarkdownToDocx({ commitSha: COMMIT_SHA, documents: [] })).toThrow(
			DocxExportError
		);
	});

	it('escapes XML-significant characters in text content', () => {
		const bytes = exportMarkdownToDocx({
			commitSha: COMMIT_SHA,
			documents: [{ path: 'documents/a.md', content: 'Tom & Jerry, a "classic" duo\n' }]
		});
		const xml = documentXmlFrom(bytes);
		expect(xml).toContain('Tom &amp; Jerry, a &quot;classic&quot; duo');
	});
});
