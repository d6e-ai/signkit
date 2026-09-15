import { PdfObjectReader, type PdfPageNode } from './pdf-object-reader';

/**
 * Bounded structural PDF metadata reader. It counts page-tree leaves and reads
 * the first page's displayed dimensions; it never decodes a content stream or
 * renders. All parsing, budgets, and failure reasons live in
 * {@link import('./pdf-object-reader').PdfObjectReader}, which the executed-PDF
 * composer shares so an uploaded document is validated and imported by exactly
 * one parser.
 */

export {
	MAX_PDF_INFLATE_BYTES,
	MAX_PDF_NESTING,
	MAX_PDF_NODE_BUDGET,
	MAX_PDF_PAGE_TREE_DEPTH,
	MAX_PDF_PREV_CHAIN,
	MAX_PDF_TOKEN_BUDGET,
	PdfPageMetadataError,
	type PdfPageMetadataReason
} from './pdf-object-reader';

export interface PdfPageMetadata {
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
}

export function parsePdfPageMetadata(bytes: Uint8Array): PdfPageMetadata {
	const pages: readonly PdfPageNode[] = new PdfObjectReader(bytes).pages();
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
