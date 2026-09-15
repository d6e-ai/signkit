import {
	MAX_PDF_NODE_BUDGET,
	PdfObjectReader,
	PdfPageMetadataError,
	isArray,
	isDict,
	isNameValue,
	type PdfPageMetadataReason as PdfPageMetadataReasonBase,
	type PdfPageNode,
	type PdfValue
} from './pdf-object-reader';

/**
 * Bounded structural PDF metadata reader. It counts page-tree leaves and reads
 * the first page's displayed dimensions; it never decodes a content stream or
 * renders. All parsing, budgets, and failure reasons live in
 * {@link import('./pdf-object-reader').PdfObjectReader}, which the executed-PDF
 * composer shares so an uploaded document is validated and imported by exactly
 * one parser.
 *
 * On top of the shared reader this module rejects passive-upload active
 * content recursively: a catalog `/AcroForm`, page or annotation additional
 * actions (`/AA`), inherently active annotation subtypes, and annotation
 * actions outside the internal-GoTo-only policy (followed through `/Next`
 * chains). External `/URI` actions are rejected the same way as every other
 * non-`/GoTo` action: an uploaded PDF must not reach outside the document.
 * The walk resolves through {@link PdfObjectReader.resolve} so references
 * hidden inside object streams are checked the same way as plain indirect
 * objects.
 */

export {
	MAX_PDF_INFLATE_BYTES,
	MAX_PDF_NESTING,
	MAX_PDF_NODE_BUDGET,
	MAX_PDF_PAGE_TREE_DEPTH,
	MAX_PDF_PREV_CHAIN,
	MAX_PDF_TOKEN_BUDGET,
	PdfPageMetadataError
} from './pdf-object-reader';

export const MAX_PDF_ACTION_CHAIN: number = 32;

export type PdfPageMetadataReason =
	| PdfPageMetadataReasonBase
	| 'active_content_acroform'
	| 'active_content_page_aa'
	| 'active_content_annotation_aa'
	| 'active_content_annotation_type'
	| 'active_content_action';

/**
 * Annotation subtypes that carry or trigger active content by their mere
 * presence, regardless of what action (if any) they name: rich media and 3D
 * embed executable/plugin content, file attachments and sound/movie embed or
 * stream external payloads, and widgets are AcroForm form fields (AcroForm
 * itself is already rejected outright). SignKit only needs to display a flat
 * page image, so none of these are legitimate on an uploaded PDF.
 */
const BLOCKED_ANNOTATION_SUBTYPES: ReadonlySet<string> = new Set([
	'RichMedia',
	'FileAttachment',
	'Screen',
	'3D',
	'Widget',
	'Sound',
	'Movie'
]);

/**
 * The only action subtype that cannot execute code or reach outside the
 * PDF's own pages is `/GoTo`, which navigates within the same document.
 * External `/URI` actions are rejected recursively: a `/URI` entry names an
 * outside URL for the viewer to open, so an uploaded document carrying one is
 * not passive input even when the viewer would open it in a separate browser
 * rather than automatically. Every other action subtype -- `/URI`,
 * `/Launch`, `/JavaScript`, `/SubmitForm`, `/GoToR`, `/ImportData`,
 * `/Named`, media/rendition actions, and anything not on this list -- is
 * rejected.
 */
const ALLOWED_ACTION_SUBTYPES: ReadonlySet<string> = new Set(['GoTo']);

interface TraversalBudget {
	count: number;
}

export interface PdfPageMetadata {
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
}

export function parsePdfPageMetadata(bytes: Uint8Array): PdfPageMetadata {
	const reader: PdfObjectReader = new PdfObjectReader(bytes);
	const budget: TraversalBudget = { count: 0 };
	assertCatalogPassive(reader);
	const pages: readonly PdfPageNode[] = reader.pages();
	for (const page of pages) {
		assertPagePassive(reader, page, budget);
	}
	const first: PdfPageNode = pages[0];
	return { pageCount: pages.length, ...displayedPageSize(first) };
}

/** The page as a reader sees it: a 90/270 degree `/Rotate` swaps width and height. */
export function displayedPageSize(page: PdfPageNode): { pageWidth: number; pageHeight: number } {
	const width: number = page.mediaBox[2] - page.mediaBox[0];
	const height: number = page.mediaBox[3] - page.mediaBox[1];
	if (page.rotate === 90 || page.rotate === 270) {
		return { pageWidth: height, pageHeight: width };
	}
	return { pageWidth: width, pageHeight: height };
}

function assertCatalogPassive(reader: PdfObjectReader): void {
	if (reader.catalog().entries.has('AcroForm')) {
		// Rejecting /AcroForm outright also covers /XFA, which can only
		// appear nested inside it -- SignKit has no use for interactive
		// forms, so there is nothing to allowlist inside this dict.
		throw fail('active_content_acroform', 'PDFs with an interactive /AcroForm are not accepted');
	}
}

function assertPagePassive(
	reader: PdfObjectReader,
	page: PdfPageNode,
	budget: TraversalBudget
): void {
	if (page.dict.entries.has('AA')) {
		throw fail('active_content_page_aa', 'PDFs with page additional actions are not accepted');
	}
	const annotsValue: PdfValue | undefined = page.dict.entries.get('Annots');
	if (annotsValue !== undefined) assertAnnotationsSafe(reader, annotsValue, budget);
}

/**
 * Rejects any annotation that is inherently active (rich media, file
 * attachments, form widgets, sound/movie) or that carries additional
 * actions or an action outside the internal-GoTo-only policy. Each annotation
 * consumes one node from the shared traversal budget, so a huge or
 * cyclic `/Annots` array fails closed the same way an oversized page
 * tree does.
 */
function assertAnnotationsSafe(
	reader: PdfObjectReader,
	annotsValue: PdfValue,
	budget: TraversalBudget
): void {
	const resolved: PdfValue = reader.resolve(annotsValue);
	if (!isArray(resolved)) throw fail('damaged_xref', 'PDF array is required');
	for (const item of resolved.items) {
		countNode(budget);
		const annotation: PdfValue = reader.resolve(item);
		if (!isDict(annotation)) throw fail('damaged_xref', 'PDF dictionary is required');
		if (annotation.entries.has('AA')) {
			throw fail(
				'active_content_annotation_aa',
				'PDFs with annotation additional actions are not accepted'
			);
		}
		const subtype: PdfValue | undefined = annotation.entries.get('Subtype');
		if (isNameValue(subtype) && BLOCKED_ANNOTATION_SUBTYPES.has(subtype.value)) {
			throw fail(
				'active_content_annotation_type',
				`PDFs with a /${subtype.value} annotation are not accepted`
			);
		}
		const actionValue: PdfValue | undefined = annotation.entries.get('A');
		if (actionValue !== undefined) assertActionChainSafe(reader, actionValue, 0, budget);
	}
}

/**
 * Actions can chain through `/Next` (a single action dict or an array of
 * them) to run several actions in sequence. Every link in the chain must
 * itself be the internal `/GoTo` action, and the chain is bounded so a
 * crafted or cyclic `/Next` graph cannot force unbounded recursion.
 */
function assertActionChainSafe(
	reader: PdfObjectReader,
	actionValue: PdfValue,
	depth: number,
	budget: TraversalBudget
): void {
	if (depth > MAX_PDF_ACTION_CHAIN) {
		throw fail('active_content_action', 'PDF action chain is too long');
	}
	countNode(budget);
	const resolved: PdfValue = reader.resolve(actionValue);
	if (!isDict(resolved)) throw fail('damaged_xref', 'PDF dictionary is required');
	const subtype: PdfValue | undefined = resolved.entries.get('S');
	if (isNameValue(subtype) && !ALLOWED_ACTION_SUBTYPES.has(subtype.value)) {
		throw fail('active_content_action', `PDFs with a /${subtype.value} action are not accepted`);
	}
	const nextValue: PdfValue | undefined = resolved.entries.get('Next');
	if (nextValue === undefined) return;
	const resolvedNext: PdfValue = reader.resolve(nextValue);
	const nextActions: readonly PdfValue[] = isArray(resolvedNext)
		? resolvedNext.items
		: [resolvedNext];
	for (const next of nextActions) {
		assertActionChainSafe(reader, next, depth + 1, budget);
	}
}

function countNode(budget: TraversalBudget): void {
	budget.count += 1;
	if (budget.count > MAX_PDF_NODE_BUDGET) {
		throw fail('node_budget_exceeded', 'PDF page tree exceeds the node budget');
	}
}

function fail(reason: PdfPageMetadataReason, message: string): PdfPageMetadataError {
	return new PdfPageMetadataError(reason as PdfPageMetadataReasonBase, message);
}
