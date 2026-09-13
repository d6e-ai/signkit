import { zipSync, type Zippable } from 'fflate';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type {
	Content,
	Emphasis,
	Heading,
	InlineCode,
	List,
	ListItem,
	Paragraph,
	PhrasingContent,
	Root,
	Strong,
	Text
} from 'mdast';

const MAX_MARKDOWN_BYTES = 512 * 1024;
const MAX_NODES = 20_000;

export class DocxExportError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'DocxExportError';
		this.code = code;
	}
}

export interface DocxExportDocument {
	/** `documents/<name>.md` path this section originated from, used only for a heading-less ordering hint. */
	path: string;
	content: string;
}

export interface DocxExportManifest {
	/** The pinned Git commit this export was generated from. Recorded in core.xml. */
	commitSha: string;
	documents: readonly DocxExportDocument[];
}

/**
 * Renders one or more normalized Markdown documents, pinned to a specific Git
 * commit, into a minimal but valid OOXML WordprocessingML (.docx) package.
 * Pure JS (fflate + unified/remark), so it runs identically under Node and
 * Cloudflare Workers. The DOCX bytes are a transient or retained artifact
 * outside Git; this function has no knowledge of storage or retention policy.
 */
export function exportMarkdownToDocx(manifest: DocxExportManifest): Uint8Array {
	if (manifest.documents.length === 0) {
		throw new DocxExportError('empty_manifest', 'At least one document is required for export');
	}
	const bodyXmlParts: string[] = [];
	for (const document of manifest.documents) {
		const bytes = new TextEncoder().encode(document.content).byteLength;
		if (bytes > MAX_MARKDOWN_BYTES) {
			throw new DocxExportError(
				'document_too_large',
				`${document.path} exceeds the export size limit`
			);
		}
		const tree = parseMarkdown(document.content);
		bodyXmlParts.push(...renderRootToParagraphs(tree));
	}
	const documentXml = wrapDocumentXml(bodyXmlParts.join(''));
	const files: Zippable = {
		'[Content_Types].xml': strToU8(CONTENT_TYPES_XML),
		_rels: { '.rels': strToU8(ROOT_RELS_XML) },
		docProps: { 'core.xml': strToU8(coreXml(manifest.commitSha)) },
		word: {
			'document.xml': strToU8(documentXml),
			'styles.xml': strToU8(STYLES_XML),
			_rels: { 'document.xml.rels': strToU8(DOCUMENT_RELS_XML) }
		}
	};
	return zipSync(files, { level: 6 });
}

function parseMarkdown(content: string): Root {
	if (new TextEncoder().encode(content).byteLength > MAX_MARKDOWN_BYTES) {
		throw new DocxExportError(
			'document_too_large',
			'Markdown source exceeds the export size limit'
		);
	}
	const processor = unified().use(remarkParse).use(remarkGfm);
	return processor.parse(content) as Root;
}

function renderRootToParagraphs(root: Root): string[] {
	let nodeCount = 0;
	const paragraphs: string[] = [];
	for (const child of root.children) {
		nodeCount = countNode(child, nodeCount);
		paragraphs.push(...renderBlock(child));
	}
	return paragraphs;

	function countNode(node: Content, count: number): number {
		const next = count + 1;
		if (next > MAX_NODES) {
			throw new DocxExportError(
				'document_too_complex',
				'Markdown document exceeds the export node budget'
			);
		}
		if ('children' in node && Array.isArray(node.children)) {
			let running = next;
			for (const child of node.children as Content[]) running = countNode(child, running);
			return running;
		}
		return next;
	}
}

function renderBlock(node: Content, listDepth: number = 0): string[] {
	switch (node.type) {
		case 'heading':
			return [renderHeading(node as Heading)];
		case 'paragraph':
			return [renderParagraph(node as Paragraph)];
		case 'list': {
			const list = node as List;
			const out: string[] = [];
			list.children.forEach((item: ListItem, index: number): void => {
				const marker = list.ordered ? `${(list.start ?? 1) + index}. ` : '• ';
				out.push(...renderListItem(item, marker, listDepth));
			});
			return out;
		}
		case 'blockquote':
		case 'code':
		case 'html':
		case 'table':
		case 'thematicBreak':
			return [
				renderParagraph({
					type: 'paragraph',
					children: [{ type: 'text', value: fallbackText(node) }]
				})
			];
		default:
			return [];
	}
}

function renderListItem(item: ListItem, marker: string, depth: number): string[] {
	const out: string[] = [];
	for (const child of item.children) {
		if (child.type === 'paragraph') {
			out.push(renderParagraph(child as Paragraph, marker, depth));
		} else if (child.type === 'list') {
			const nested = child as List;
			nested.children.forEach((nestedItem: ListItem, index: number): void => {
				const nestedMarker = nested.ordered ? `${(nested.start ?? 1) + index}. ` : '◦ ';
				out.push(...renderListItem(nestedItem, nestedMarker, depth + 1));
			});
		}
	}
	return out;
}

function renderHeading(node: Heading): string {
	const style = `Heading${Math.min(Math.max(node.depth, 1), 3)}`;
	const runs = node.children.map((child) => renderInline(child)).join('');
	return paragraphXml(runs, style);
}

function renderParagraph(node: Paragraph, marker: string = '', indent: number = 0): string {
	const indentXml = indent > 0 ? ` w:ind="${indent * 360}"` : '';
	const runs = escapeXmlText(marker) + node.children.map((child) => renderInline(child)).join('');
	return paragraphXml(runs, null, indentXml);
}

function renderInline(
	node: PhrasingContent,
	bold: boolean = false,
	italic: boolean = false
): string {
	switch (node.type) {
		case 'text':
			return runXml(escapeXmlText((node as Text).value), bold, italic);
		case 'strong':
			return (node as Strong).children.map((child) => renderInline(child, true, italic)).join('');
		case 'emphasis':
			return (node as Emphasis).children.map((child) => renderInline(child, bold, true)).join('');
		case 'inlineCode':
			return runXml(escapeXmlText((node as InlineCode).value), bold, italic);
		case 'break':
			return brRunXml();
		case 'link':
			return node.children.map((child) => renderInline(child, bold, italic)).join('');
		default:
			return '';
	}
}

function runXml(text: string, bold: boolean = false, italic: boolean = false): string {
	const props =
		bold || italic ? `<w:rPr>${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}</w:rPr>` : '';
	return `<w:r>${props}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

function brRunXml(): string {
	return '<w:r><w:br/></w:r>';
}

function paragraphXml(runsXml: string, style: string | null, extraPPr: string = ''): string {
	const pStyle = style ? `<w:pStyle w:val="${style}"/>` : '';
	const pPr = pStyle || extraPPr ? `<w:pPr>${pStyle}${extraPPr}</w:pPr>` : '';
	return `<w:p>${pPr}${runsXml}</w:p>`;
}

function fallbackText(node: Content): string {
	if ('value' in node && typeof node.value === 'string') return node.value;
	return '';
}

function wrapDocumentXml(bodyXml: string): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${bodyXml}<w:sectPr/></w:body>
</w:document>`;
}

function coreXml(commitSha: string): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:description>SignKit export pinned to commit ${escapeXmlText(commitSha)}</dc:description>
</cp:coreProperties>`;
}

function escapeXmlText(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

function strToU8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
  <w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
  <w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
  <w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`;
