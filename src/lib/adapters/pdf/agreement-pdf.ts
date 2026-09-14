import type { RecipientMarkdownNode } from '$lib/security/recipient-markdown';
import { documentFont } from './document-font';
import type { TrueTypeFont } from './truetype-font';
import {
	A4_HEIGHT_POINTS,
	A4_WIDTH_POINTS,
	buildFontProgram,
	renderUnicodePdf,
	type PdfColor,
	type PdfOperation,
	type PdfPage
} from './unicode-pdf-writer';

/**
 * Lays sanitized agreement Markdown out as a paginated PDF.
 *
 * The input is the same node tree the recipient's browser would render, taken
 * from {@link import('$lib/security/recipient-markdown').renderRecipientMarkdown}
 * -- so images are already placeholders, HTML is already inert text, links are
 * already restricted to https/mailto, and invisible Unicode controls are
 * already surfaced. Nothing in this module fetches anything, and the PDF it
 * produces references no external resource.
 *
 * Output is deterministic: identical documents produce byte-identical PDFs,
 * which is what allows the sent artifact to be content-addressed.
 */

export const AGREEMENT_PDF_PAGE_WIDTH: number = A4_WIDTH_POINTS;
export const AGREEMENT_PDF_PAGE_HEIGHT: number = A4_HEIGHT_POINTS;

const MARGIN_X: number = 56;
const MARGIN_TOP: number = 64;
const MARGIN_BOTTOM: number = 72;
const CONTENT_WIDTH: number = AGREEMENT_PDF_PAGE_WIDTH - MARGIN_X * 2;
const BODY_SIZE: number = 10.5;
const BODY_LINE_HEIGHT: number = 1.62;
const PARAGRAPH_GAP: number = 7;
const LIST_INDENT: number = 18;
const QUOTE_INDENT: number = 14;
const CODE_SIZE: number = 9.5;
const CODE_PADDING: number = 6;
const TABLE_CELL_PADDING: number = 5;
const RULE_THICKNESS: number = 0.6;

const INK: PdfColor = { red: 0.1, green: 0.11, blue: 0.13 };
const MUTED: PdfColor = { red: 0.42, green: 0.45, blue: 0.5 };
const LINK: PdfColor = { red: 0.11, green: 0.33, blue: 0.68 };
const RULE: PdfColor = { red: 0.8, green: 0.82, blue: 0.85 };
const CODE_BACKGROUND: PdfColor = { red: 0.96, green: 0.965, blue: 0.97 };

const HEADING_SIZES: Readonly<Record<string, number>> = {
	h1: 19,
	h2: 15.5,
	h3: 13.5,
	h4: 12,
	h5: 11,
	h6: 10.5
};

/** Hard ceilings so one hostile or runaway document cannot exhaust the renderer. */
export const MAX_AGREEMENT_PDF_PAGES: number = 400;
const MAX_LAYOUT_BLOCKS: number = 40_000;
const MAX_TREE_DEPTH: number = 24;

export class AgreementPdfBoundExceededError extends Error {
	readonly code = 'AGREEMENT_PDF_BOUND_EXCEEDED';

	constructor(message: string) {
		super(message);
		this.name = 'AgreementPdfBoundExceededError';
	}
}

export interface AgreementPdfDocument {
	/** Human-readable heading rendered above the document body. */
	title: string;
	nodes: readonly RecipientMarkdownNode[];
}

export interface AgreementPdfDocumentPages {
	/** Index of the document in the input order. */
	index: number;
	title: string;
	/** 1-indexed, inclusive page range this document occupies in the PDF. */
	firstPage: number;
	lastPage: number;
}

export interface AgreementPdfResult {
	bytes: Uint8Array;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
	documents: readonly AgreementPdfDocumentPages[];
}

interface InlineStyle {
	bold: boolean;
	italic: boolean;
	code: boolean;
	link: boolean;
}

const PLAIN: InlineStyle = { bold: false, italic: false, code: false, link: false };

interface InlineRun {
	text: string;
	style: InlineStyle;
}

type LayoutBlock =
	| { kind: 'heading'; level: keyof typeof HEADING_SIZES; runs: readonly InlineRun[] }
	| { kind: 'paragraph'; runs: readonly InlineRun[]; indent: number; quoted: boolean }
	| { kind: 'listItem'; marker: string; runs: readonly InlineRun[]; indent: number }
	| { kind: 'code'; lines: readonly string[] }
	| { kind: 'rule' }
	| {
			kind: 'table';
			rows: readonly (readonly { runs: readonly InlineRun[]; header: boolean }[])[];
	  };

interface Atom {
	glyphs: number[];
	/** Width in points at size 1; multiply by the run's font size. */
	unitWidth: number;
	style: InlineStyle;
	canBreakBefore: boolean;
	isSpace: boolean;
}

interface PositionedLine {
	height: number;
	/** Draw callbacks keyed to a resolved top coordinate. */
	draw(top: number): PdfOperation[];
}

class GlyphCache {
	readonly #font: TrueTypeFont;
	readonly #glyphs: Map<number, number> = new Map<number, number>();
	readonly #widths: Map<number, number> = new Map<number, number>();
	readonly used: Map<number, readonly number[]> = new Map<number, readonly number[]>();

	constructor(font: TrueTypeFont) {
		this.#font = font;
	}

	glyphFor(codePoint: number): number {
		const cached: number | undefined = this.#glyphs.get(codePoint);
		if (cached !== undefined) return cached;
		const glyphId: number = this.#font.glyphIdForCodePoint(codePoint);
		this.#glyphs.set(codePoint, glyphId);
		this.#widths.set(glyphId, this.#font.advanceWidth(glyphId) / this.#font.metrics.unitsPerEm);
		if (!this.used.has(glyphId)) this.used.set(glyphId, [codePoint]);
		return glyphId;
	}

	/** Advance of one glyph at font size 1, in points. */
	unitWidth(glyphId: number): number {
		return this.#widths.get(glyphId) ?? 0.5;
	}
}

export function renderAgreementPdf(documents: readonly AgreementPdfDocument[]): AgreementPdfResult {
	if (documents.length === 0) throw new AgreementPdfBoundExceededError('No documents to render');
	const font: TrueTypeFont = documentFont();
	const cache: GlyphCache = new GlyphCache(font);

	const pages: PdfPage[] = [];
	const documentPages: AgreementPdfDocumentPages[] = [];

	for (const [index, document] of documents.entries()) {
		const blocks: LayoutBlock[] = [];
		collectBlocks(document.nodes, blocks, { indent: 0, quoted: false, style: PLAIN, depth: 0 });
		const lines: PositionedLine[] = [];
		// Each document starts on a fresh page and leads with its own title, so
		// a recipient can never mistake where one agreement document ends and
		// the next begins -- and so a field's page number maps to exactly one
		// document.
		lines.push(...layoutHeading(cache, document.title, 'h1'));
		lines.push(spacer(PARAGRAPH_GAP));
		lines.push(ruleLine());
		lines.push(spacer(PARAGRAPH_GAP * 2));
		for (const block of blocks) lines.push(...layoutBlock(cache, block));

		const firstPage: number = pages.length + 1;
		paginate(lines, pages);
		documentPages.push({
			index,
			title: document.title,
			firstPage,
			lastPage: pages.length
		});
		if (pages.length > MAX_AGREEMENT_PDF_PAGES) {
			throw new AgreementPdfBoundExceededError('Agreement exceeds the maximum page count');
		}
	}

	appendPageFooters(cache, pages);

	const { program, glyphIdMap } = buildFontProgram(
		font,
		cache.used.keys(),
		cache.used,
		'ZenKakuGothicNew-Regular'
	);
	const bytes: Uint8Array = renderUnicodePdf(remapGlyphIds(pages, glyphIdMap), program);
	return {
		bytes,
		pageCount: pages.length,
		pageWidth: AGREEMENT_PDF_PAGE_WIDTH,
		pageHeight: AGREEMENT_PDF_PAGE_HEIGHT,
		documents: documentPages
	};
}

/**
 * The subset renumbers glyphs densely, so every recorded operation has to be
 * rewritten from source glyph ids to subset ids before the writer emits it.
 */
function remapGlyphIds(
	pages: readonly PdfPage[],
	glyphIdMap: ReadonlyMap<number, number>
): PdfPage[] {
	return pages.map((page: PdfPage): PdfPage => ({
		width: page.width,
		height: page.height,
		operations: page.operations.map((operation: PdfOperation): PdfOperation =>
			operation.kind === 'text'
				? {
						...operation,
						glyphIds: operation.glyphIds.map(
							(glyphId: number): number => glyphIdMap.get(glyphId) ?? 0
						)
					}
				: operation
		)
	}));
}

function collectBlocks(
	nodes: readonly RecipientMarkdownNode[],
	blocks: LayoutBlock[],
	context: { indent: number; quoted: boolean; style: InlineStyle; depth: number }
): void {
	if (context.depth > MAX_TREE_DEPTH) {
		throw new AgreementPdfBoundExceededError('Document nesting is too deep');
	}
	for (const node of nodes) {
		if (blocks.length > MAX_LAYOUT_BLOCKS) {
			throw new AgreementPdfBoundExceededError('Document has too many blocks');
		}
		if (node.type === 'text') {
			if (node.value.trim().length === 0) continue;
			blocks.push({
				kind: 'paragraph',
				runs: [{ text: node.value, style: context.style }],
				indent: context.indent,
				quoted: context.quoted
			});
			continue;
		}
		switch (node.tag) {
			case 'h1':
			case 'h2':
			case 'h3':
			case 'h4':
			case 'h5':
			case 'h6':
				blocks.push({ kind: 'heading', level: node.tag, runs: inlineRuns(node.children, PLAIN) });
				break;
			case 'p':
				blocks.push({
					kind: 'paragraph',
					runs: inlineRuns(node.children, context.style),
					indent: context.indent,
					quoted: context.quoted
				});
				break;
			case 'hr':
				blocks.push({ kind: 'rule' });
				break;
			case 'pre':
				blocks.push({ kind: 'code', lines: plainText(node.children).split('\n') });
				break;
			case 'blockquote':
				collectBlocks(node.children, blocks, {
					indent: context.indent + QUOTE_INDENT,
					quoted: true,
					style: context.style,
					depth: context.depth + 1
				});
				break;
			case 'ul':
			case 'ol': {
				const start: number = Number.parseInt(node.attributes.start ?? '1', 10);
				let ordinal: number = Number.isSafeInteger(start) && start > 0 ? start : 1;
				for (const child of node.children) {
					if (child.type !== 'element' || child.tag !== 'li') continue;
					const marker: string = node.tag === 'ol' ? `${ordinal}.` : '•';
					ordinal += 1;
					collectListItem(child.children, marker, blocks, {
						indent: context.indent + LIST_INDENT,
						quoted: context.quoted,
						style: context.style,
						depth: context.depth + 1
					});
				}
				break;
			}
			case 'table':
				blocks.push(collectTable(node));
				break;
			case 'section':
				collectBlocks(node.children, blocks, { ...context, depth: context.depth + 1 });
				break;
			default:
				blocks.push({
					kind: 'paragraph',
					runs: inlineRuns([node], context.style),
					indent: context.indent,
					quoted: context.quoted
				});
		}
	}
}

function collectListItem(
	children: readonly RecipientMarkdownNode[],
	marker: string,
	blocks: LayoutBlock[],
	context: { indent: number; quoted: boolean; style: InlineStyle; depth: number }
): void {
	const leading: RecipientMarkdownNode[] = [];
	const trailing: RecipientMarkdownNode[] = [];
	let seenBlock: boolean = false;
	for (const child of children) {
		const isNestedBlock: boolean =
			child.type === 'element' && (child.tag === 'ul' || child.tag === 'ol');
		if (isNestedBlock) seenBlock = true;
		(seenBlock ? trailing : leading).push(child);
	}
	blocks.push({
		kind: 'listItem',
		marker,
		runs: inlineRuns(leading, context.style),
		indent: context.indent
	});
	if (trailing.length > 0) collectBlocks(trailing, blocks, context);
}

function collectTable(node: Extract<RecipientMarkdownNode, { type: 'element' }>): LayoutBlock {
	const rows: { runs: readonly InlineRun[]; header: boolean }[][] = [];
	const visitRows = (parent: readonly RecipientMarkdownNode[], header: boolean): void => {
		for (const child of parent) {
			if (child.type !== 'element') continue;
			if (child.tag === 'thead') visitRows(child.children, true);
			else if (child.tag === 'tbody') visitRows(child.children, false);
			else if (child.tag === 'tr') {
				const cells: { runs: readonly InlineRun[]; header: boolean }[] = [];
				for (const cell of child.children) {
					if (cell.type !== 'element') continue;
					if (cell.tag !== 'td' && cell.tag !== 'th') continue;
					cells.push({
						runs: inlineRuns(cell.children, { ...PLAIN, bold: header || cell.tag === 'th' }),
						header: header || cell.tag === 'th'
					});
				}
				if (cells.length > 0) rows.push(cells);
			}
		}
	};
	visitRows(node.children, false);
	return { kind: 'table', rows };
}

function inlineRuns(
	nodes: readonly RecipientMarkdownNode[],
	style: InlineStyle
): readonly InlineRun[] {
	const runs: InlineRun[] = [];
	const visit = (node: RecipientMarkdownNode, current: InlineStyle, depth: number): void => {
		if (depth > MAX_TREE_DEPTH) {
			throw new AgreementPdfBoundExceededError('Document nesting is too deep');
		}
		if (node.type === 'text') {
			if (node.value.length > 0) runs.push({ text: node.value, style: current });
			return;
		}
		if (node.tag === 'br') {
			runs.push({ text: '\n', style: current });
			return;
		}
		const next: InlineStyle = {
			bold: current.bold || node.tag === 'strong' || node.tag.startsWith('h'),
			italic: current.italic || node.tag === 'em',
			code: current.code || node.tag === 'code',
			link: current.link || node.tag === 'a'
		};
		for (const child of node.children) visit(child, next, depth + 1);
		// A link that renders as its own href needs no decoration beyond the
		// underline the layout already draws; anything else keeps the target
		// visible in print, where a hover has no meaning.
		if (node.tag === 'a') {
			const href: string | undefined = node.attributes.href;
			const label: string = plainText(node.children).trim();
			if (href !== undefined && href.length > 0 && label !== href) {
				runs.push({ text: ` <${href}>`, style: { ...current, link: false, italic: true } });
			}
		}
	};
	for (const node of nodes) visit(node, style, 0);
	return runs;
}

function plainText(nodes: readonly RecipientMarkdownNode[]): string {
	let text: string = '';
	const visit = (node: RecipientMarkdownNode, depth: number): void => {
		if (depth > MAX_TREE_DEPTH) {
			throw new AgreementPdfBoundExceededError('Document nesting is too deep');
		}
		if (node.type === 'text') {
			text += node.value;
			return;
		}
		if (node.tag === 'br') {
			text += '\n';
			return;
		}
		for (const child of node.children) visit(child, depth + 1);
	};
	for (const node of nodes) visit(node, 0);
	return text;
}

function layoutBlock(cache: GlyphCache, block: LayoutBlock): PositionedLine[] {
	switch (block.kind) {
		case 'heading': {
			const lines: PositionedLine[] = [spacer(PARAGRAPH_GAP)];
			lines.push(
				...layoutRuns(cache, block.runs, HEADING_SIZES[block.level], MARGIN_X, CONTENT_WIDTH)
			);
			lines.push(spacer(PARAGRAPH_GAP * 0.7));
			return lines;
		}
		case 'paragraph': {
			const lines: PositionedLine[] = layoutRuns(
				cache,
				block.runs,
				BODY_SIZE,
				MARGIN_X + block.indent,
				CONTENT_WIDTH - block.indent,
				block.quoted ? MARGIN_X + block.indent - QUOTE_INDENT + 2 : null
			);
			lines.push(spacer(PARAGRAPH_GAP));
			return lines;
		}
		case 'listItem': {
			const markerLines: PositionedLine[] = layoutRuns(
				cache,
				block.runs,
				BODY_SIZE,
				MARGIN_X + block.indent,
				CONTENT_WIDTH - block.indent
			);
			const markerGlyphs: number[] = [...block.marker].map((character: string): number =>
				cache.glyphFor(character.codePointAt(0) ?? 0x20)
			);
			const markerWidth: number =
				markerGlyphs.reduce(
					(total: number, glyphId: number): number => total + cache.unitWidth(glyphId),
					0
				) * BODY_SIZE;
			const first: PositionedLine | undefined = markerLines[0];
			if (first !== undefined) {
				markerLines[0] = {
					height: first.height,
					draw: (top: number): PdfOperation[] => [
						{
							kind: 'text',
							x: MARGIN_X + block.indent - markerWidth - 5,
							baselineFromTop: top + BODY_SIZE * 1.12,
							size: BODY_SIZE,
							glyphIds: markerGlyphs,
							color: INK,
							bold: false,
							italic: false
						},
						...first.draw(top)
					]
				};
			}
			markerLines.push(spacer(PARAGRAPH_GAP * 0.4));
			return markerLines;
		}
		case 'code': {
			const lineHeight: number = CODE_SIZE * 1.5;
			const lines: PositionedLine[] = [spacer(PARAGRAPH_GAP * 0.6)];
			for (const [index, text] of block.lines.entries()) {
				const glyphs: number[] = [...text].map((character: string): number =>
					cache.glyphFor(character.codePointAt(0) ?? 0x20)
				);
				const isFirst: boolean = index === 0;
				const isLast: boolean = index === block.lines.length - 1;
				lines.push({
					height: lineHeight + (isFirst ? CODE_PADDING : 0) + (isLast ? CODE_PADDING : 0),
					draw: (top: number): PdfOperation[] => [
						{
							kind: 'rectangle',
							x: MARGIN_X,
							yFromTop: top,
							width: CONTENT_WIDTH,
							height: lineHeight + (isFirst ? CODE_PADDING : 0) + (isLast ? CODE_PADDING : 0),
							fill: CODE_BACKGROUND,
							stroke: null,
							lineWidth: 0
						},
						{
							kind: 'text',
							x: MARGIN_X + CODE_PADDING,
							baselineFromTop: top + (isFirst ? CODE_PADDING : 0) + CODE_SIZE * 1.15,
							size: CODE_SIZE,
							glyphIds: glyphs,
							color: INK,
							bold: false,
							italic: false
						}
					]
				});
			}
			lines.push(spacer(PARAGRAPH_GAP));
			return lines;
		}
		case 'rule':
			return [spacer(PARAGRAPH_GAP), ruleLine(), spacer(PARAGRAPH_GAP)];
		case 'table':
			return layoutTable(cache, block.rows);
	}
}

function layoutTable(
	cache: GlyphCache,
	rows: readonly (readonly { runs: readonly InlineRun[]; header: boolean }[])[]
): PositionedLine[] {
	if (rows.length === 0) return [];
	const columnCount: number = rows.reduce(
		(widest: number, row): number => Math.max(widest, row.length),
		0
	);
	if (columnCount === 0) return [];
	const columnWidth: number = CONTENT_WIDTH / columnCount;
	const lines: PositionedLine[] = [spacer(PARAGRAPH_GAP)];

	for (const row of rows) {
		const cellLines: PositionedLine[][] = [];
		for (let column: number = 0; column < columnCount; column += 1) {
			const cell = row[column];
			cellLines.push(
				cell === undefined
					? []
					: layoutRuns(
							cache,
							cell.runs,
							BODY_SIZE,
							MARGIN_X + column * columnWidth + TABLE_CELL_PADDING,
							columnWidth - TABLE_CELL_PADDING * 2
						)
			);
		}
		const rowHeight: number =
			Math.max(
				BODY_SIZE * BODY_LINE_HEIGHT,
				...cellLines.map((cell: PositionedLine[]): number =>
					cell.reduce((total: number, line: PositionedLine): number => total + line.height, 0)
				)
			) +
			TABLE_CELL_PADDING * 2;
		const header: boolean = row.some((cell): boolean => cell.header);
		lines.push({
			height: rowHeight,
			draw: (top: number): PdfOperation[] => {
				const operations: PdfOperation[] = [];
				for (let column: number = 0; column < columnCount; column += 1) {
					operations.push({
						kind: 'rectangle',
						x: MARGIN_X + column * columnWidth,
						yFromTop: top,
						width: columnWidth,
						height: rowHeight,
						fill: header ? CODE_BACKGROUND : null,
						stroke: RULE,
						lineWidth: RULE_THICKNESS
					});
					let cursor: number = top + TABLE_CELL_PADDING;
					for (const line of cellLines[column]) {
						operations.push(...line.draw(cursor));
						cursor += line.height;
					}
				}
				return operations;
			}
		});
	}
	lines.push(spacer(PARAGRAPH_GAP));
	return lines;
}

function layoutHeading(
	cache: GlyphCache,
	text: string,
	level: keyof typeof HEADING_SIZES
): PositionedLine[] {
	return layoutRuns(
		cache,
		[{ text, style: { ...PLAIN, bold: true } }],
		HEADING_SIZES[level],
		MARGIN_X,
		CONTENT_WIDTH
	);
}

function layoutRuns(
	cache: GlyphCache,
	runs: readonly InlineRun[],
	size: number,
	left: number,
	maxWidth: number,
	quoteBarX: number | null = null
): PositionedLine[] {
	const lineHeight: number = size * BODY_LINE_HEIGHT;
	const lines: PositionedLine[] = [];
	for (const paragraph of splitHardBreaks(runs)) {
		const atoms: Atom[] = buildAtoms(cache, paragraph, maxWidth / Math.max(size, 0.01));
		const wrapped: Atom[][] = wrapAtoms(atoms, maxWidth / Math.max(size, 0.01));
		for (const lineAtoms of wrapped) {
			lines.push(buildLine(lineAtoms, size, left, lineHeight, quoteBarX));
		}
		if (wrapped.length === 0) lines.push(spacer(lineHeight));
	}
	return lines;
}

function splitHardBreaks(runs: readonly InlineRun[]): InlineRun[][] {
	const paragraphs: InlineRun[][] = [[]];
	for (const run of runs) {
		const segments: string[] = run.text.split('\n');
		segments.forEach((segment: string, index: number): void => {
			if (index > 0) paragraphs.push([]);
			if (segment.length > 0) {
				paragraphs[paragraphs.length - 1].push({ text: segment, style: run.style });
			}
		});
	}
	return paragraphs;
}

function buildAtoms(cache: GlyphCache, runs: readonly InlineRun[], maxUnitWidth: number): Atom[] {
	const atoms: Atom[] = [];
	let previousCodePoint: number | null = null;
	for (const run of runs) {
		const codePoints: number[] = [...run.text].map(
			(character: string): number => character.codePointAt(0) ?? 0x20
		);
		let index: number = 0;
		while (index < codePoints.length) {
			const codePoint: number = codePoints[index];
			if (isSpace(codePoint)) {
				const glyphs: number[] = [];
				let unitWidth: number = 0;
				while (index < codePoints.length && isSpace(codePoints[index])) {
					const glyphId: number = cache.glyphFor(0x20);
					glyphs.push(glyphId);
					unitWidth += cache.unitWidth(glyphId);
					index += 1;
				}
				atoms.push({ glyphs, unitWidth, style: run.style, canBreakBefore: true, isSpace: true });
				previousCodePoint = 0x20;
				continue;
			}
			const glyphs: number[] = [];
			let unitWidth: number = 0;
			const canBreakBefore: boolean =
				previousCodePoint === null || allowBreakBetween(previousCodePoint, codePoint);
			while (index < codePoints.length) {
				const current: number = codePoints[index];
				if (isSpace(current)) break;
				if (glyphs.length > 0 && allowBreakBetween(codePoints[index - 1], current)) break;
				const glyphId: number = cache.glyphFor(current);
				glyphs.push(glyphId);
				unitWidth += cache.unitWidth(glyphId);
				previousCodePoint = current;
				index += 1;
			}
			if (glyphs.length === 0) {
				index += 1;
				continue;
			}
			atoms.push({ glyphs, unitWidth, style: run.style, canBreakBefore, isSpace: false });
		}
	}
	return splitOversizedAtoms(cache, atoms, maxUnitWidth);
}

/** A single token wider than the measure is broken at glyph boundaries. */
function splitOversizedAtoms(cache: GlyphCache, atoms: Atom[], maxUnitWidth: number): Atom[] {
	const result: Atom[] = [];
	for (const atom of atoms) {
		if (atom.isSpace || atom.unitWidth <= maxUnitWidth || atom.glyphs.length < 2) {
			result.push(atom);
			continue;
		}
		let current: Atom = {
			glyphs: [],
			unitWidth: 0,
			style: atom.style,
			canBreakBefore: atom.canBreakBefore,
			isSpace: false
		};
		for (const glyphId of atom.glyphs) {
			const width: number = cache.unitWidth(glyphId);
			if (current.glyphs.length > 0 && current.unitWidth + width > maxUnitWidth) {
				result.push(current);
				current = {
					glyphs: [],
					unitWidth: 0,
					style: atom.style,
					canBreakBefore: true,
					isSpace: false
				};
			}
			current.glyphs.push(glyphId);
			current.unitWidth += width;
		}
		if (current.glyphs.length > 0) result.push(current);
	}
	return result;
}

function wrapAtoms(atoms: readonly Atom[], maxUnitWidth: number): Atom[][] {
	const lines: Atom[][] = [];
	let current: Atom[] = [];
	let width: number = 0;
	let pendingSpace: Atom | null = null;
	for (const atom of atoms) {
		if (atom.isSpace) {
			if (current.length > 0) pendingSpace = atom;
			continue;
		}
		const spaceWidth: number = pendingSpace?.unitWidth ?? 0;
		const breakable: boolean = pendingSpace !== null || atom.canBreakBefore;
		if (current.length > 0 && breakable && width + spaceWidth + atom.unitWidth > maxUnitWidth) {
			lines.push(current);
			current = [atom];
			width = atom.unitWidth;
			pendingSpace = null;
			continue;
		}
		if (pendingSpace !== null) {
			current.push(pendingSpace);
			width += pendingSpace.unitWidth;
			pendingSpace = null;
		}
		current.push(atom);
		width += atom.unitWidth;
	}
	if (current.length > 0) lines.push(current);
	return lines;
}

function buildLine(
	atoms: readonly Atom[],
	size: number,
	left: number,
	lineHeight: number,
	quoteBarX: number | null
): PositionedLine {
	return {
		height: lineHeight,
		draw: (top: number): PdfOperation[] => {
			const operations: PdfOperation[] = [];
			if (quoteBarX !== null) {
				operations.push({
					kind: 'rectangle',
					x: quoteBarX,
					yFromTop: top,
					width: 2,
					height: lineHeight,
					fill: RULE,
					stroke: null,
					lineWidth: 0
				});
			}
			const baseline: number = top + size * 1.18;
			let x: number = left;
			let index: number = 0;
			while (index < atoms.length) {
				const style: InlineStyle = atoms[index].style;
				const glyphs: number[] = [];
				let unitWidth: number = 0;
				while (index < atoms.length && sameStyle(atoms[index].style, style)) {
					glyphs.push(...atoms[index].glyphs);
					unitWidth += atoms[index].unitWidth;
					index += 1;
				}
				const width: number = unitWidth * size;
				if (style.code) {
					operations.push({
						kind: 'rectangle',
						x: x - 1,
						yFromTop: top + lineHeight - size * 1.32,
						width: width + 2,
						height: size * 1.3,
						fill: CODE_BACKGROUND,
						stroke: null,
						lineWidth: 0
					});
				}
				operations.push({
					kind: 'text',
					x,
					baselineFromTop: baseline,
					size,
					glyphIds: glyphs,
					color: style.link ? LINK : INK,
					bold: style.bold,
					italic: style.italic
				});
				if (style.link) {
					operations.push({
						kind: 'rectangle',
						x,
						yFromTop: baseline + size * 0.12,
						width,
						height: 0.6,
						fill: LINK,
						stroke: null,
						lineWidth: 0
					});
				}
				x += width;
			}
			return operations;
		}
	};
}

function sameStyle(left: InlineStyle, right: InlineStyle): boolean {
	return (
		left.bold === right.bold &&
		left.italic === right.italic &&
		left.code === right.code &&
		left.link === right.link
	);
}

function spacer(height: number): PositionedLine {
	return { height, draw: (): PdfOperation[] => [] };
}

function ruleLine(): PositionedLine {
	return {
		height: RULE_THICKNESS,
		draw: (top: number): PdfOperation[] => [
			{
				kind: 'rectangle',
				x: MARGIN_X,
				yFromTop: top,
				width: CONTENT_WIDTH,
				height: RULE_THICKNESS,
				fill: RULE,
				stroke: null,
				lineWidth: 0
			}
		]
	};
}

function paginate(lines: readonly PositionedLine[], pages: PdfPage[]): void {
	const usableHeight: number = AGREEMENT_PDF_PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
	let operations: PdfOperation[] = [];
	let cursor: number = MARGIN_TOP;
	const flush = (): void => {
		pages.push({
			width: AGREEMENT_PDF_PAGE_WIDTH,
			height: AGREEMENT_PDF_PAGE_HEIGHT,
			operations
		});
		operations = [];
		cursor = MARGIN_TOP;
	};
	for (const line of lines) {
		// Spacer lines advance the cursor without emitting any operations, so
		// `operations.length` alone cannot tell a genuinely fresh page from one
		// that has already spent part of its usable height on leading gaps.
		if (cursor + line.height > MARGIN_TOP + usableHeight && cursor > MARGIN_TOP) flush();
		operations.push(...line.draw(cursor));
		cursor += line.height;
		if (pages.length > MAX_AGREEMENT_PDF_PAGES) {
			throw new AgreementPdfBoundExceededError('Agreement exceeds the maximum page count');
		}
	}
	flush();
}

function appendPageFooters(cache: GlyphCache, pages: PdfPage[]): void {
	const total: number = pages.length;
	pages.forEach((page: PdfPage, index: number): void => {
		const label: string = `${index + 1} / ${total}`;
		const glyphs: number[] = [...label].map((character: string): number =>
			cache.glyphFor(character.codePointAt(0) ?? 0x20)
		);
		const width: number =
			glyphs.reduce(
				(total: number, glyphId: number): number => total + cache.unitWidth(glyphId),
				0
			) * 9;
		page.operations = [
			...page.operations,
			{
				kind: 'text',
				x: AGREEMENT_PDF_PAGE_WIDTH / 2 - width / 2,
				baselineFromTop: AGREEMENT_PDF_PAGE_HEIGHT - MARGIN_BOTTOM + 30,
				size: 9,
				glyphIds: glyphs,
				color: MUTED,
				bold: false,
				italic: false
			}
		];
	});
}

function isSpace(codePoint: number): boolean {
	return codePoint === 0x20 || codePoint === 0x09 || codePoint === 0x3000;
}

/**
 * Japanese text has no spaces, so a line may break between almost any two
 * characters -- except where kinsoku shori forbids it: a line never starts
 * with closing punctuation or a small kana, and never ends with an opening
 * bracket.
 */
const CLOSING_PUNCTUATION: ReadonlySet<number> = new Set(
	[
		'、',
		'。',
		'，',
		'．',
		'：',
		'；',
		'？',
		'！',
		'〉',
		'》',
		'」',
		'』',
		'】',
		'〕',
		'）',
		'］',
		'｝',
		'ー',
		'々',
		'ゝ',
		'ゞ',
		'ヽ',
		'ヾ',
		'ぁ',
		'ぃ',
		'ぅ',
		'ぇ',
		'ぉ',
		'っ',
		'ゃ',
		'ゅ',
		'ょ',
		'ゎ',
		'ァ',
		'ィ',
		'ゥ',
		'ェ',
		'ォ',
		'ッ',
		'ャ',
		'ュ',
		'ョ',
		'ヮ'
	].map((character: string): number => character.codePointAt(0) ?? 0)
);

const OPENING_PUNCTUATION: ReadonlySet<number> = new Set(
	['〈', '《', '「', '『', '【', '〔', '（', '［', '｛'].map(
		(character: string): number => character.codePointAt(0) ?? 0
	)
);

function isWideScript(codePoint: number): boolean {
	return (
		(codePoint >= 0x2e80 && codePoint <= 0x303f) ||
		(codePoint >= 0x3040 && codePoint <= 0x30ff) ||
		(codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
		(codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xff00 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x20000 && codePoint <= 0x2ebef)
	);
}

function allowBreakBetween(previous: number, next: number): boolean {
	if (!isWideScript(previous) && !isWideScript(next)) return false;
	if (OPENING_PUNCTUATION.has(previous)) return false;
	if (CLOSING_PUNCTUATION.has(next)) return false;
	return true;
}
