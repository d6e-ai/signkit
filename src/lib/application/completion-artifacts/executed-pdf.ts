import {
	composePdf,
	displayedSize,
	fitOverlayTextSize,
	measureOverlayText,
	PdfCompositionError,
	type ComposePdfImage,
	type ComposePdfResult,
	type ComposePdfSource,
	type OverlayOperation
} from '$lib/adapters/pdf/pdf-composer';
import { PdfObjectReader, type PdfPageNode } from '$lib/adapters/pdf/pdf-object-reader';
import { SIGNATURE_ASSET_REF_PREFIX } from '$lib/application/documents/signature-asset';
import type { FieldType } from '$lib/domain/envelope';

/**
 * Builds the executed agreement: the immutable sent document set, in document
 * order, with each signed value drawn at the geometry frozen when the envelope
 * was sent.
 *
 * Every input here is already verified by the caller — document bytes against
 * the pinned document-set manifest, field values against their persisted
 * SHA-256, signature assets against their content-addressed reference — so
 * this module's job is to fail closed on anything that cannot be placed
 * faithfully rather than to degrade. A field whose geometry is missing,
 * out of range, or points at a page the document does not have is an
 * integrity failure, not a field to skip: an agreement that silently drops a
 * signature is worse than one that is never published.
 */

export const MAX_EXECUTED_PDF_DOCUMENTS: number = 20;
export const MAX_EXECUTED_PDF_FIELDS: number = 200;
export const MAX_EXECUTED_PDF_PAGES: number = 800;
export const MAX_EXECUTED_PDF_BYTES: number = 32 * 1024 * 1024;

const INK = { red: 0.05, green: 0.06, blue: 0.1 };
/** Cap so a short value in a tall box does not render as absurdly large type. */
const MAX_VALUE_TEXT_SIZE: number = 18;
const MIN_VALUE_TEXT_SIZE: number = 4;
const SIGNATURE_BOX_INSET: number = 0.06;

export type ExecutedPdfFailureReason =
	| 'unknown_document'
	| 'missing_geometry'
	| 'invalid_geometry'
	| 'page_out_of_range'
	| 'page_count_mismatch'
	| 'missing_signature_asset'
	| 'invalid_field_value'
	| 'invalid_document'
	| 'no_documents';

export class ExecutedPdfIntegrityError extends Error {
	readonly code = 'EXECUTED_PDF_INTEGRITY_ERROR';

	constructor(
		readonly reason: ExecutedPdfFailureReason,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'ExecutedPdfIntegrityError';
	}
}

export class ExecutedPdfBoundExceededError extends Error {
	readonly code = 'EXECUTED_PDF_BOUND_EXCEEDED';

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ExecutedPdfBoundExceededError';
	}
}

/** The frozen, unit-square placement of one field on one page of one document. */
export interface ExecutedPdfGeometry {
	/** 1-based page within the field's own document. */
	page: number;
	/** Fractions of the displayed page, x from the left and y from the top. */
	x: number;
	y: number;
	width: number;
	height: number;
}

export type ExecutedFieldValue =
	| { kind: 'text'; text: string }
	| { kind: 'drawn-signature'; sha256: string }
	| { kind: 'checkbox'; checked: boolean }
	| { kind: 'empty' };

export interface ExecutedPdfDocument {
	id: string;
	title: string;
	position: number;
	kind: 'markdown' | 'pdf';
	/** The sent document's own PDF bytes: the uploaded original, or the Markdown rendering. */
	bytes: Uint8Array;
	/** The page count pinned in the sent document set; the base bytes must agree with it. */
	pageCount: number;
}

export interface ExecutedPdfField {
	id: string;
	documentId: string;
	fieldType: FieldType;
	geometry: ExecutedPdfGeometry | null;
	value: ExecutedFieldValue;
	/** Required, and verified by the caller, when `value` is a drawn signature. */
	signaturePngBytes?: Uint8Array;
}

export interface BuildExecutedPdfInput {
	documents: readonly ExecutedPdfDocument[];
	fields: readonly ExecutedPdfField[];
	/** Optional evidence-summary pages appended after the agreement itself. */
	appendixPdfBytes?: Uint8Array;
	maxPages?: number;
	maxOutputBytes?: number;
}

export interface ExecutedPdfDocumentPages {
	documentId: string;
	/** 1-based, inclusive page range this document occupies in the executed PDF. */
	firstPage: number;
	lastPage: number;
}

export interface ExecutedPdfResult {
	bytes: Uint8Array;
	pageCount: number;
	documents: readonly ExecutedPdfDocumentPages[];
	/** First page of the evidence appendix, or `null` when none was supplied. */
	appendixFirstPage: number | null;
	/** Fields actually drawn; a blank optional field draws nothing and is not counted. */
	renderedFieldCount: number;
}

export function buildExecutedPdf(input: BuildExecutedPdfInput): ExecutedPdfResult {
	const documents: readonly ExecutedPdfDocument[] = [...input.documents].sort(
		(left: ExecutedPdfDocument, right: ExecutedPdfDocument): number =>
			left.position - right.position || compareText(left.id, right.id)
	);
	if (documents.length === 0) {
		throw integrity('no_documents', 'The sent revision has no documents to execute');
	}
	if (documents.length > MAX_EXECUTED_PDF_DOCUMENTS) {
		throw new ExecutedPdfBoundExceededError('The envelope has too many documents to execute');
	}
	if (input.fields.length > MAX_EXECUTED_PDF_FIELDS) {
		throw new ExecutedPdfBoundExceededError('The envelope has too many fields to execute');
	}

	const documentIndex: Map<string, number> = new Map(
		documents.map((document: ExecutedPdfDocument, index: number): [string, number] => [
			document.id,
			index
		])
	);
	const pageNodes: readonly (readonly PdfPageNode[])[] = documents.map(
		(document: ExecutedPdfDocument): readonly PdfPageNode[] => readPages(document)
	);

	const overlays: Map<number, Map<number, OverlayOperation[]>> = new Map();
	const images: ComposePdfImage[] = [];
	const imageIds: Set<string> = new Set();
	let renderedFieldCount: number = 0;

	for (const field of sortFields(input.fields, documentIndex)) {
		const index: number | undefined = documentIndex.get(field.documentId);
		if (index === undefined) {
			throw integrity('unknown_document', 'A signed field references an unknown document');
		}
		const geometry: ExecutedPdfGeometry = requireGeometry(field);
		const pages: readonly PdfPageNode[] = pageNodes[index];
		if (geometry.page > pages.length) {
			throw integrity('page_out_of_range', 'A signed field is placed past the end of its document');
		}
		const page: PdfPageNode = pages[geometry.page - 1];
		const operations: OverlayOperation[] = drawField(field, geometry, page);
		if (operations.length === 0) continue;
		renderedFieldCount += 1;
		for (const operation of operations) {
			if (operation.kind === 'image' && !imageIds.has(operation.imageId)) {
				imageIds.add(operation.imageId);
				images.push({ id: operation.imageId, pngBytes: requireSignatureBytes(field) });
			}
		}
		const byPage: Map<number, OverlayOperation[]> = overlays.get(index) ?? new Map();
		byPage.set(geometry.page - 1, [...(byPage.get(geometry.page - 1) ?? []), ...operations]);
		overlays.set(index, byPage);
	}

	const sources: ComposePdfSource[] = documents.map(
		(document: ExecutedPdfDocument, index: number): ComposePdfSource => ({
			bytes: document.bytes,
			overlays: overlays.get(index) ?? new Map()
		})
	);
	if (input.appendixPdfBytes !== undefined) sources.push({ bytes: input.appendixPdfBytes });

	let composed: ComposePdfResult;
	try {
		composed = composePdf({
			sources,
			images,
			maxPages: input.maxPages ?? MAX_EXECUTED_PDF_PAGES,
			maxOutputBytes: input.maxOutputBytes ?? MAX_EXECUTED_PDF_BYTES
		});
	} catch (error: unknown) {
		throw translateCompositionError(error);
	}

	const ranges: ExecutedPdfDocumentPages[] = [];
	let cursor: number = 1;
	documents.forEach((document: ExecutedPdfDocument, index: number): void => {
		const pages: number = composed.sourcePageCounts[index];
		ranges.push({ documentId: document.id, firstPage: cursor, lastPage: cursor + pages - 1 });
		cursor += pages;
	});

	return {
		bytes: composed.bytes,
		pageCount: composed.pageCount,
		documents: ranges,
		appendixFirstPage: input.appendixPdfBytes === undefined ? null : cursor,
		renderedFieldCount
	};
}

/**
 * Reads the base document's pages and holds them to the page count pinned in
 * the sent document set: bytes that no longer paginate the way the frozen
 * manifest says they do cannot carry that manifest's geometry.
 */
function readPages(document: ExecutedPdfDocument): readonly PdfPageNode[] {
	let pages: readonly PdfPageNode[];
	try {
		pages = new PdfObjectReader(document.bytes).pages();
	} catch (error: unknown) {
		throw new ExecutedPdfIntegrityError(
			'invalid_document',
			'A sent document could not be read as a PDF',
			{ cause: error }
		);
	}
	if (pages.length !== document.pageCount) {
		throw integrity(
			'page_count_mismatch',
			'A sent document no longer has the page count its document set pinned'
		);
	}
	return pages;
}

function sortFields(
	fields: readonly ExecutedPdfField[],
	documentIndex: ReadonlyMap<string, number>
): readonly ExecutedPdfField[] {
	// Drawing order is fixed independently of the store's row order so identical
	// evidence always produces an identical content stream.
	return [...fields].sort((left: ExecutedPdfField, right: ExecutedPdfField): number => {
		const leftDocument: number = documentIndex.get(left.documentId) ?? Number.MAX_SAFE_INTEGER;
		const rightDocument: number = documentIndex.get(right.documentId) ?? Number.MAX_SAFE_INTEGER;
		if (leftDocument !== rightDocument) return leftDocument - rightDocument;
		const leftPage: number = left.geometry?.page ?? 0;
		const rightPage: number = right.geometry?.page ?? 0;
		if (leftPage !== rightPage) return leftPage - rightPage;
		const leftY: number = left.geometry?.y ?? 0;
		const rightY: number = right.geometry?.y ?? 0;
		if (leftY !== rightY) return leftY - rightY;
		const leftX: number = left.geometry?.x ?? 0;
		const rightX: number = right.geometry?.x ?? 0;
		if (leftX !== rightX) return leftX - rightX;
		return compareText(left.id, right.id);
	});
}

function requireGeometry(field: ExecutedPdfField): ExecutedPdfGeometry {
	const geometry: ExecutedPdfGeometry | null = field.geometry;
	if (geometry === null) {
		throw integrity('missing_geometry', 'A signed field has no placement geometry');
	}
	const { page, x, y, width, height } = geometry;
	if (!Number.isSafeInteger(page) || page < 1) {
		throw integrity('invalid_geometry', 'A signed field has an invalid page number');
	}
	for (const value of [x, y]) {
		if (!Number.isFinite(value) || value < 0 || value > 1) {
			throw integrity('invalid_geometry', 'A signed field coordinate is outside the page');
		}
	}
	for (const value of [width, height]) {
		if (!Number.isFinite(value) || value <= 0 || value > 1) {
			throw integrity('invalid_geometry', 'A signed field has invalid dimensions');
		}
	}
	// The same tolerance field placement allows for pixel-to-fraction rounding.
	if (x + width > 1.0001 || y + height > 1.0001) {
		throw integrity('invalid_geometry', 'A signed field extends past the page edge');
	}
	return geometry;
}

function requireSignatureBytes(field: ExecutedPdfField): Uint8Array {
	const bytes: Uint8Array | undefined = field.signaturePngBytes;
	if (bytes === undefined || bytes.byteLength === 0) {
		throw integrity('missing_signature_asset', 'A drawn signature asset is missing');
	}
	return bytes;
}

interface DisplayBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

function drawField(
	field: ExecutedPdfField,
	geometry: ExecutedPdfGeometry,
	page: PdfPageNode
): OverlayOperation[] {
	const size = displayedSize(page);
	// Unit-square geometry measures y downward from the top of the displayed
	// page; PDF content measures upward from the bottom.
	const box: DisplayBox = {
		x: geometry.x * size.width,
		y: size.height - (geometry.y + geometry.height) * size.height,
		width: geometry.width * size.width,
		height: geometry.height * size.height
	};

	if (field.value.kind === 'empty') return [];
	if (field.value.kind === 'checkbox') {
		return field.value.checked ? [checkMark(box)] : [];
	}
	if (field.value.kind === 'drawn-signature') {
		return [drawnSignature(field.value.sha256, field, box)];
	}
	return typedValue(field, field.value.text, box);
}

/** Fits the signature raster inside its box without distorting the stroke. */
function drawnSignature(
	sha256: string,
	field: ExecutedPdfField,
	box: DisplayBox
): OverlayOperation {
	const png = decodeDimensions(requireSignatureBytes(field));
	const inset: number = Math.min(box.width, box.height) * SIGNATURE_BOX_INSET;
	const availableWidth: number = Math.max(box.width - inset * 2, box.width * 0.5);
	const availableHeight: number = Math.max(box.height - inset * 2, box.height * 0.5);
	const scale: number = Math.min(availableWidth / png.width, availableHeight / png.height);
	const width: number = png.width * scale;
	const height: number = png.height * scale;
	return {
		kind: 'image',
		imageId: sha256,
		x: box.x + (box.width - width) / 2,
		y: box.y + (box.height - height) / 2,
		width,
		height
	};
}

/**
 * Reads the PNG header directly. The composer decodes the full raster anyway;
 * placement only needs the aspect ratio, and reading 8 bytes is cheaper than
 * decoding twice.
 */
function decodeDimensions(bytes: Uint8Array): { width: number; height: number } {
	if (bytes.byteLength < 24) {
		throw integrity('missing_signature_asset', 'A drawn signature asset is truncated');
	}
	const width: number = readUint32(bytes, 16);
	const height: number = readUint32(bytes, 20);
	if (width < 1 || height < 1) {
		throw integrity('missing_signature_asset', 'A drawn signature asset has no pixels');
	}
	return { width, height };
}

function readUint32(bytes: Uint8Array, offset: number): number {
	return (
		bytes[offset] * 0x1000000 +
		(bytes[offset + 1] << 16) +
		(bytes[offset + 2] << 8) +
		bytes[offset + 3]
	);
}

function typedValue(field: ExecutedPdfField, value: string, box: DisplayBox): OverlayOperation[] {
	if (value.length === 0) return [];
	const signatureLike: boolean = field.fieldType === 'signature' || field.fieldType === 'initials';
	// A typed signature sits on the box's baseline like a handwritten one;
	// text and date values are centered in their box.
	const heightFactor: number = signatureLike ? 0.62 : 0.56;
	const size: number = fitOverlayTextSize(
		value,
		box.width * 0.96,
		Math.min(MAX_VALUE_TEXT_SIZE, box.height * heightFactor),
		MIN_VALUE_TEXT_SIZE
	);
	const width: number = measureOverlayText(value, size);
	const baseline: number = signatureLike
		? box.y + box.height * 0.22
		: box.y + (box.height - size * 0.72) / 2;
	return [
		{
			kind: 'text',
			x: box.x + Math.max(0, (box.width - width) / 2),
			baseline,
			size,
			text: value,
			color: INK
		}
	];
}

/** A check drawn as a stroked path, so it needs no glyph and no font fallback. */
function checkMark(box: DisplayBox): OverlayOperation {
	const side: number = Math.min(box.width, box.height);
	const left: number = box.x + (box.width - side) / 2;
	const bottom: number = box.y + (box.height - side) / 2;
	return {
		kind: 'polyline',
		points: [
			[left + side * 0.2, bottom + side * 0.52],
			[left + side * 0.42, bottom + side * 0.28],
			[left + side * 0.82, bottom + side * 0.76]
		],
		stroke: INK,
		lineWidth: Math.max(0.75, side * 0.1)
	};
}

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;

/**
 * Interprets one persisted `field_value.value_json` payload. The value has
 * already been re-hashed against its stored digest, so anything unreadable
 * here is a shape violation rather than tampering — and either way it must not
 * be guessed at.
 */
export function parseExecutedFieldValue(
	fieldType: FieldType,
	valueJson: string
): ExecutedFieldValue {
	let parsed: unknown;
	try {
		parsed = JSON.parse(valueJson);
	} catch (error: unknown) {
		throw new ExecutedPdfIntegrityError(
			'invalid_field_value',
			'A signed field value is not valid JSON',
			{ cause: error }
		);
	}
	if (fieldType === 'checkbox') {
		if (typeof parsed !== 'boolean') {
			throw integrity('invalid_field_value', 'A checkbox field value is not a boolean');
		}
		return { kind: 'checkbox', checked: parsed };
	}
	if (typeof parsed !== 'string') {
		throw integrity('invalid_field_value', 'A signed field value is not a string');
	}
	if (parsed.length === 0) return { kind: 'empty' };
	if (
		(fieldType === 'signature' || fieldType === 'initials') &&
		parsed.startsWith(SIGNATURE_ASSET_REF_PREFIX)
	) {
		const sha256: string = parsed.slice(SIGNATURE_ASSET_REF_PREFIX.length);
		if (!SHA256_PATTERN.test(sha256)) {
			throw integrity('invalid_field_value', 'A drawn signature reference is malformed');
		}
		return { kind: 'drawn-signature', sha256 };
	}
	return { kind: 'text', text: parsed };
}

function translateCompositionError(error: unknown): Error {
	if (!(error instanceof PdfCompositionError)) return error as Error;
	switch (error.reason) {
		case 'too_many_pages':
		case 'too_many_sources':
		case 'too_many_images':
		case 'decoded_image_budget_exceeded':
		case 'too_many_operations':
		case 'input_too_large':
		case 'output_too_large':
		case 'object_budget_exceeded':
			return new ExecutedPdfBoundExceededError(
				'The executed agreement exceeds a composition budget',
				{ cause: error }
			);
		default:
			return new ExecutedPdfIntegrityError(
				'invalid_document',
				'The executed agreement could not be composed from the sent documents',
				{ cause: error }
			);
	}
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function integrity(reason: ExecutedPdfFailureReason, message: string): ExecutedPdfIntegrityError {
	return new ExecutedPdfIntegrityError(reason, message);
}
