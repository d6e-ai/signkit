import { unzipSync, type UnzipFileInfo } from 'fflate';
import { normalizeMarkdownContent } from '$lib/domain/draft';

export interface DocxImportLimits {
	readonly maxInputBytes: number;
	readonly maxZipEntries: number;
	readonly maxEntryUncompressedBytes: number;
	readonly maxTotalUncompressedBytes: number;
	readonly maxXmlTokens: number;
}

/** Node/Vercel: keep unzip and XML parsing proportional to a plausible document. */
export const NODE_DOCX_IMPORT_LIMITS: DocxImportLimits = {
	maxInputBytes: 20 * 1024 * 1024,
	maxZipEntries: 2_000,
	maxEntryUncompressedBytes: 20 * 1024 * 1024,
	maxTotalUncompressedBytes: 40 * 1024 * 1024,
	maxXmlTokens: 500_000
};

/**
 * Cloudflare Workers isolate memory is much smaller than Node. These bounds
 * keep the ZIP inflate plus UTF-8 XML string plus token array inside a
 * conservative fraction of the isolate; tests pass this object without a
 * Cloudflare build.
 */
export const CLOUDFLARE_DOCX_IMPORT_LIMITS: DocxImportLimits = {
	maxInputBytes: 2 * 1024 * 1024,
	maxZipEntries: 500,
	maxEntryUncompressedBytes: 2 * 1024 * 1024,
	maxTotalUncompressedBytes: 4 * 1024 * 1024,
	maxXmlTokens: 80_000
};

/** Default (Node) input cap, kept for callers that do not pass explicit limits. */
export const MAX_DOCX_INPUT_BYTES = NODE_DOCX_IMPORT_LIMITS.maxInputBytes;
const MAX_ATTRS_PER_TAG = 32;
const DOCUMENT_XML_PATH = 'word/document.xml';

/**
 * Cloudflare is identified by the D1 binding present only on that deploy
 * target. Node and Vercel keep the larger Node budget.
 */
export function resolveDocxImportLimits(
	platform?: Pick<App.Platform, 'env'> | { env?: { DB?: unknown } }
): DocxImportLimits {
	if (platform?.env !== undefined && platform.env.DB !== undefined) {
		return CLOUDFLARE_DOCX_IMPORT_LIMITS;
	}
	return NODE_DOCX_IMPORT_LIMITS;
}

export class DocxImportError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = 'DocxImportError';
		this.code = code;
	}
}

/**
 * Converts a hostile, untrusted `.docx` byte stream into normalized Markdown.
 * Every stage is bounded before the corresponding expensive operation runs:
 * the raw byte count, the ZIP central directory (entry count and each
 * entry's *declared* uncompressed size) before any entry is inflated, and the
 * XML token count before paragraph/run structure is built. Pure JS (fflate
 * for the ZIP container, a purpose-built linear XML tokenizer for
 * WordprocessingML), so it runs identically under Node and Cloudflare
 * Workers. Only paragraphs, headings 1-6, bold, italic, and line breaks are
 * recognized; lists, tables, images, and other OOXML features degrade to
 * plain paragraph text.
 */
export function importDocxToMarkdown(
	bytes: Uint8Array,
	limits: DocxImportLimits = NODE_DOCX_IMPORT_LIMITS
): string {
	if (bytes.byteLength === 0)
		throw new DocxImportError('empty_input', 'The uploaded file is empty');
	if (bytes.byteLength > limits.maxInputBytes) {
		throw new DocxImportError('too_large', 'The uploaded DOCX file exceeds the import size limit');
	}
	if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
		throw new DocxImportError('invalid_zip', 'The uploaded file is not a valid ZIP/DOCX container');
	}

	let entryCount = 0;
	let totalUncompressed = 0;
	let extracted: Record<string, Uint8Array>;
	try {
		extracted = unzipSync(bytes, {
			filter(info: UnzipFileInfo): boolean {
				entryCount += 1;
				if (entryCount > limits.maxZipEntries) {
					throw new DocxImportError('too_many_entries', 'The DOCX package has too many entries');
				}
				if (info.name !== DOCUMENT_XML_PATH) return false;
				if (info.originalSize > limits.maxEntryUncompressedBytes) {
					throw new DocxImportError(
						'entry_too_large',
						'word/document.xml exceeds the import size limit'
					);
				}
				totalUncompressed += info.originalSize;
				if (totalUncompressed > limits.maxTotalUncompressedBytes) {
					throw new DocxImportError('too_large', 'The DOCX package exceeds the import size limit');
				}
				return true;
			}
		});
	} catch (error: unknown) {
		if (error instanceof DocxImportError) throw error;
		throw new DocxImportError(
			'invalid_zip',
			'The uploaded file could not be read as a ZIP/DOCX container'
		);
	}

	const documentXmlBytes: Uint8Array | undefined = extracted[DOCUMENT_XML_PATH];
	if (documentXmlBytes === undefined) {
		throw new DocxImportError('missing_document_xml', 'The DOCX package has no word/document.xml');
	}

	let xmlText: string;
	try {
		xmlText = new TextDecoder('utf-8', { fatal: true }).decode(documentXmlBytes);
	} catch {
		throw new DocxImportError('invalid_xml', 'word/document.xml is not valid UTF-8');
	}

	const tokens: readonly XmlToken[] = tokenizeXml(xmlText, limits.maxXmlTokens);
	const paragraphs: readonly DocxParagraph[] = buildParagraphs(tokens);
	const markdown: string = renderParagraphsAsMarkdown(paragraphs);
	return normalizeMarkdownContent(markdown);
}

// --- Bounded linear XML tokenizer -----------------------------------------

type XmlToken =
	| { type: 'open'; name: string; attrs: Readonly<Record<string, string>>; selfClosing: boolean }
	| { type: 'close'; name: string }
	| { type: 'text'; value: string };

const TAG_NAME_PATTERN = /^[^\s/>]+/;
const ATTRIBUTE_PATTERN = /([a-zA-Z0-9_:.-]+)\s*=\s*"([^"]*)"/g;

function tokenizeXml(xml: string, maxXmlTokens: number): readonly XmlToken[] {
	const tokens: XmlToken[] = [];
	const length = xml.length;
	let index = 0;

	while (index < length) {
		if (tokens.length > maxXmlTokens) {
			throw new DocxImportError(
				'too_complex',
				'word/document.xml exceeds the import complexity budget'
			);
		}
		if (xml[index] === '<') {
			const end = xml.indexOf('>', index);
			if (end === -1)
				throw new DocxImportError('invalid_xml', 'word/document.xml has an unterminated tag');
			const raw = xml.slice(index + 1, end);
			index = end + 1;
			if (raw.startsWith('?') || raw.startsWith('!')) continue;
			if (raw.startsWith('/')) {
				tokens.push({ type: 'close', name: raw.slice(1).trim() });
				continue;
			}
			const selfClosing = raw.endsWith('/');
			const body = selfClosing ? raw.slice(0, -1) : raw;
			const nameMatch = TAG_NAME_PATTERN.exec(body);
			if (nameMatch === null) {
				throw new DocxImportError('invalid_xml', 'word/document.xml has a malformed tag');
			}
			const attrs: Record<string, string> = {};
			ATTRIBUTE_PATTERN.lastIndex = 0;
			let match: RegExpExecArray | null;
			let attrCount = 0;
			while ((match = ATTRIBUTE_PATTERN.exec(body)) !== null) {
				attrCount += 1;
				if (attrCount > MAX_ATTRS_PER_TAG) break;
				attrs[match[1]] = decodeXmlEntities(match[2]);
			}
			tokens.push({ type: 'open', name: nameMatch[0], attrs, selfClosing });
		} else {
			const next = xml.indexOf('<', index);
			const textEnd = next === -1 ? length : next;
			const raw = xml.slice(index, textEnd);
			index = textEnd;
			if (raw.length > 0) tokens.push({ type: 'text', value: decodeXmlEntities(raw) });
		}
	}
	return tokens;
}

function decodeXmlEntities(value: string): string {
	if (!value.includes('&')) return value;
	return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity: string, body: string): string => {
		if (body === 'lt') return '<';
		if (body === 'gt') return '>';
		if (body === 'amp') return '&';
		if (body === 'quot') return '"';
		if (body === 'apos') return "'";
		if (body.startsWith('#x') || body.startsWith('#X')) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: entity;
		}
		if (body.startsWith('#')) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: entity;
		}
		return entity;
	});
}

// --- Bounded single-pass paragraph/run builder -----------------------------

interface DocxRun {
	text: string;
	bold: boolean;
	italic: boolean;
}

interface DocxParagraph {
	headingLevel: number | null;
	runs: readonly DocxRun[];
}

const HEADING_STYLE_PATTERN = /^Heading([1-6])$/;

function buildParagraphs(tokens: readonly XmlToken[]): readonly DocxParagraph[] {
	const paragraphs: DocxParagraph[] = [];
	let currentParagraph: { headingLevel: number | null; runs: DocxRun[] } | null = null;
	let currentRun: DocxRun | null = null;
	let inParagraphProperties = false;
	let inRunProperties = false;
	let inText = false;
	let textBuffer = '';

	for (const token of tokens) {
		if (token.type === 'open') {
			switch (token.name) {
				case 'w:p':
					currentParagraph = { headingLevel: null, runs: [] };
					break;
				case 'w:pPr':
					inParagraphProperties = true;
					break;
				case 'w:pStyle':
					if (inParagraphProperties && currentParagraph !== null) {
						const value = token.attrs['w:val'] ?? '';
						if (value === 'Title') currentParagraph.headingLevel = 1;
						else {
							const match = HEADING_STYLE_PATTERN.exec(value);
							if (match) currentParagraph.headingLevel = Number(match[1]);
						}
					}
					break;
				case 'w:r':
					currentRun = { text: '', bold: false, italic: false };
					break;
				case 'w:rPr':
					inRunProperties = true;
					break;
				case 'w:b':
					if (inRunProperties && currentRun !== null) {
						currentRun.bold = !isFalseFlag(token.attrs['w:val']);
					}
					break;
				case 'w:i':
					if (inRunProperties && currentRun !== null) {
						currentRun.italic = !isFalseFlag(token.attrs['w:val']);
					}
					break;
				case 'w:t':
					inText = true;
					textBuffer = '';
					break;
				case 'w:br':
					if (currentRun !== null) currentRun.text += '\n';
					break;
				case 'w:tab':
					if (currentRun !== null) currentRun.text += '\t';
					break;
				default:
					break;
			}
		} else if (token.type === 'close') {
			switch (token.name) {
				case 'w:pPr':
					inParagraphProperties = false;
					break;
				case 'w:rPr':
					inRunProperties = false;
					break;
				case 'w:t':
					inText = false;
					if (currentRun !== null) currentRun.text += textBuffer;
					textBuffer = '';
					break;
				case 'w:r':
					if (currentParagraph !== null && currentRun !== null) {
						currentParagraph.runs.push(currentRun);
					}
					currentRun = null;
					break;
				case 'w:p':
					if (currentParagraph !== null) paragraphs.push(currentParagraph);
					currentParagraph = null;
					break;
				default:
					break;
			}
		} else if (inText) {
			textBuffer += token.value;
		}
	}
	return paragraphs;
}

function isFalseFlag(value: string | undefined): boolean {
	return value === '0' || value === 'false';
}

// --- Markdown rendering -----------------------------------------------------

function renderParagraphsAsMarkdown(paragraphs: readonly DocxParagraph[]): string {
	const blocks: string[] = [];
	for (const paragraph of paragraphs) {
		const text = renderParagraphText(paragraph);
		if (text.length === 0) continue;
		blocks.push(
			paragraph.headingLevel !== null ? `${'#'.repeat(paragraph.headingLevel)} ${text}` : text
		);
	}
	return blocks.join('\n\n');
}

function renderParagraphText(paragraph: DocxParagraph): string {
	return paragraph.runs
		.map((run: DocxRun): string => {
			const lines = run.text.split('\n').map(escapeMarkdown);
			const escaped = lines.join('  \n');
			if (escaped.trim().length === 0 || !(run.bold || run.italic)) return escaped;
			// CommonMark emphasis markers must hug their content: leading/trailing
			// whitespace inside `**...**` or `*...*` breaks flanking-delimiter
			// rules and the run would silently stop rendering as emphasis.
			const leading = escaped.match(/^\s*/)?.[0] ?? '';
			const trailing = escaped.match(/\s*$/)?.[0] ?? '';
			const core = escaped.slice(leading.length, escaped.length - trailing.length);
			const marker = run.bold && run.italic ? '***' : run.bold ? '**' : '*';
			return `${leading}${marker}${core}${marker}${trailing}`;
		})
		.join('')
		.trim();
}

const MARKDOWN_ESCAPE_PATTERN = /[\\`*_[\]#>]/g;

function escapeMarkdown(value: string): string {
	return value.replace(MARKDOWN_ESCAPE_PATTERN, (char: string): string => `\\${char}`);
}
