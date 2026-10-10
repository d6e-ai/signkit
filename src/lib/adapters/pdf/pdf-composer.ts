import { unzlibSync } from 'fflate';
import { documentFont } from './document-font';
import {
	decodePng,
	estimatePngDecodeMemory,
	MAX_PNG_DIMENSION,
	PngDecodeError,
	type DecodedPngImage,
	type PngDecodeMemoryEstimate
} from './png-image';
import {
	isArray,
	isDict,
	isRef,
	PdfObjectReader,
	PdfPageMetadataError,
	type PdfDict,
	type PdfPageNode,
	type PdfRef,
	type PdfValue
} from './pdf-object-reader';
import {
	assemblePdf,
	buildFontObjects,
	deflatePdfStream,
	formatNumber,
	hexGlyphs,
	latin1Bytes,
	type PdfObject
} from './pdf-writer-primitives';
import type { TrueTypeFont } from './truetype-font';
import { buildFontProgram, type PdfColor } from './unicode-pdf-writer';

/**
 * Composes one deterministic PDF from several already-verified source PDFs,
 * drawing bounded overlay operations on top of the pages it imports.
 *
 * This is what makes the completion artifact an executed agreement rather than
 * a description of one: the recipient's own document bytes become the base
 * pages, and each signature, name, date, text, or checkbox value is drawn at
 * its frozen geometry over them. Page content is copied object-for-object with
 * its filters intact — nothing is re-encoded, so an uploaded PDF's typography
 * survives exactly as its author shipped it.
 *
 * What is deliberately *not* copied is anything that can act: `/Annots`,
 * `/AA`, and the source catalog (which the reader already rejects when it
 * carries `/OpenAction`, JavaScript, or embedded files) are dropped, so the
 * executed artifact is static page content plus SignKit's own overlays.
 *
 * Output is a pure function of the input: no timestamps, no document ID, no
 * randomness, fixed deflate level. Identical evidence therefore always
 * composes to identical bytes, which is what lets the artifact be
 * content-addressed.
 */

export const MAX_COMPOSED_PDF_SOURCES: number = 32;
export const MAX_COMPOSED_PDF_PAGES: number = 800;
export const MAX_COMPOSED_PDF_INPUT_BYTES: number = 32 * 1024 * 1024;
export const MAX_COMPOSED_PDF_BYTES: number = 32 * 1024 * 1024;
export const MAX_COMPOSED_PDF_OBJECTS: number = 50_000;
export const MAX_COMPOSED_PDF_COPIED_STREAM_BYTES: number = 48 * 1024 * 1024;
export const MAX_COMPOSED_PDF_IMAGES: number = 64;
/**
 * Resident source bytes plus retained image planes and the complete temporary
 * buffer set for the image currently being decoded must fit under this cap.
 */
export const MAX_COMPOSED_PDF_IMAGE_WORKING_SET_BYTES: number = 64 * 1024 * 1024;
export const MAX_COMPOSED_PDF_OVERLAY_OPERATIONS: number = 4_000;
/**
 * UTF-16 code units per text run: the longest field value the signing API
 * accepts (`recipient-signed.ts` text fields), so no accepted value can fail
 * composition after it was signed.
 */
export const MAX_COMPOSED_PDF_TEXT_LENGTH: number = 4_000;
const MAX_COPY_DEPTH: number = 48;
const OVERLAY_FONT_NAME: string = 'ZenKakuGothicNew-Regular';
/** Type0 font, CIDFontType2 descendant, descriptor, FontFile2, ToUnicode. */
const OVERLAY_FONT_OBJECT_COUNT: number = 5;

export type PdfCompositionReason =
	| 'too_many_sources'
	| 'too_many_pages'
	| 'input_too_large'
	| 'output_too_large'
	| 'object_budget_exceeded'
	| 'too_many_images'
	| 'decoded_image_budget_exceeded'
	| 'too_many_operations'
	| 'unknown_image'
	| 'invalid_image'
	| 'invalid_source'
	| 'invalid_resources'
	| 'invalid_overlay';

export class PdfCompositionError extends Error {
	readonly code = 'PDF_COMPOSITION_ERROR';

	constructor(
		readonly reason: PdfCompositionReason,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'PdfCompositionError';
	}
}

/**
 * Overlay coordinates are in points on the page *as a reader sees it*: origin
 * at the bottom-left of the displayed page, y upward, `/Rotate` already
 * applied. The composer converts them into the page's own user space, so a
 * field placed over a rotated page lands where the signer placed it.
 */
export type OverlayOperation =
	| {
			kind: 'text';
			x: number;
			baseline: number;
			size: number;
			text: string;
			color: PdfColor;
	  }
	| {
			kind: 'image';
			imageId: string;
			x: number;
			y: number;
			width: number;
			height: number;
	  }
	| {
			kind: 'rectangle';
			x: number;
			y: number;
			width: number;
			height: number;
			fill: PdfColor | null;
			stroke: PdfColor | null;
			lineWidth: number;
	  }
	| {
			kind: 'polyline';
			points: readonly (readonly [number, number])[];
			stroke: PdfColor;
			lineWidth: number;
	  };

export interface ComposePdfImage {
	/** Stable identifier the overlay operations refer to; also fixes emission order. */
	id: string;
	pngBytes: Uint8Array;
}

export interface ComposePdfSource {
	bytes: Uint8Array;
	/** Overlay operations keyed by zero-based page index within this source. */
	overlays?: ReadonlyMap<number, readonly OverlayOperation[]>;
}

export interface ComposePdfInput {
	sources: readonly ComposePdfSource[];
	images?: readonly ComposePdfImage[];
	maxPages?: number;
	maxOutputBytes?: number;
	/** Optional stricter ceiling, primarily useful for constrained runtimes and tests. */
	maxImageWorkingSetBytes?: number;
	/**
	 * Budget dry runs only: reserves this many `null` objects where the overlay
	 * font and image objects are numbered, so a probe composed without them
	 * still numbers and counts every other object at least as high as the real
	 * composition will (see {@link overlayReservedObjectCount}).
	 */
	reservedObjectCount?: number;
}

export interface ComposePdfResult {
	bytes: Uint8Array;
	pageCount: number;
	/** Page count contributed by each source, in input order. */
	sourcePageCounts: readonly number[];
}

export function composePdf(input: ComposePdfInput): ComposePdfResult {
	const maxPages: number = input.maxPages ?? MAX_COMPOSED_PDF_PAGES;
	const maxOutputBytes: number = input.maxOutputBytes ?? MAX_COMPOSED_PDF_BYTES;
	const requestedImageWorkingSetBytes: number =
		input.maxImageWorkingSetBytes ?? MAX_COMPOSED_PDF_IMAGE_WORKING_SET_BYTES;
	if (!Number.isSafeInteger(requestedImageWorkingSetBytes) || requestedImageWorkingSetBytes < 0) {
		throw fail('decoded_image_budget_exceeded', 'Image working-set budget is invalid');
	}
	const maxImageWorkingSetBytes: number = Math.min(
		requestedImageWorkingSetBytes,
		MAX_COMPOSED_PDF_IMAGE_WORKING_SET_BYTES
	);
	if (input.sources.length === 0) {
		throw fail('invalid_source', 'A composed PDF needs at least one source document');
	}
	if (input.sources.length > MAX_COMPOSED_PDF_SOURCES) {
		throw fail('too_many_sources', 'Too many source documents for one composed PDF');
	}
	const images: readonly ComposePdfImage[] = input.images ?? [];
	if (images.length > MAX_COMPOSED_PDF_IMAGES) {
		throw fail('too_many_images', 'Too many overlay images for one composed PDF');
	}

	let inputBytes: number = 0;
	for (const source of input.sources) inputBytes += source.bytes.byteLength;
	for (const image of images) inputBytes += image.pngBytes.byteLength;
	if (inputBytes > MAX_COMPOSED_PDF_INPUT_BYTES) {
		throw fail('input_too_large', 'Source documents exceed the composition input budget');
	}

	const readers: PdfObjectReader[] = [];
	const pagesBySource: (readonly PdfPageNode[])[] = [];
	let totalPages: number = 0;
	for (const source of input.sources) {
		const reader: PdfObjectReader = new PdfObjectReader(source.bytes);
		let pages: readonly PdfPageNode[];
		try {
			pages = reader.pages();
		} catch (error: unknown) {
			if (error instanceof PdfPageMetadataError) {
				throw new PdfCompositionError('invalid_source', 'A source PDF could not be read', {
					cause: error
				});
			}
			throw error;
		}
		readers.push(reader);
		pagesBySource.push(pages);
		totalPages += pages.length;
		if (totalPages > maxPages) {
			throw fail('too_many_pages', 'Composed PDF exceeds the page budget');
		}
	}

	const shaper: OverlayShaper = new OverlayShaper();
	const shaped: ShapedOverlays = shapeOverlays(input.sources, pagesBySource, shaper);
	const decoded: Map<string, DecodedPngImage> = decodeImages(
		images,
		inputBytes,
		maxImageWorkingSetBytes
	);

	const writer: ObjectWriter = new ObjectWriter();
	const catalogId: number = writer.reserve();
	const pagesId: number = writer.reserve();
	const reservedObjectCount: number = input.reservedObjectCount ?? 0;
	if (!Number.isSafeInteger(reservedObjectCount) || reservedObjectCount < 0) {
		throw fail('object_budget_exceeded', 'Reserved object count is invalid');
	}
	for (let index: number = 0; index < reservedObjectCount; index += 1) writer.reserve();

	let fontId: number | null = null;
	let glyphIdMap: ReadonlyMap<number, number> = new Map();
	if (shaped.usedGlyphs.size > 0) {
		const ids = {
			font: writer.reserve(),
			descendantFont: writer.reserve(),
			descriptor: writer.reserve(),
			fontFile: writer.reserve(),
			toUnicode: writer.reserve()
		};
		const built = buildFontProgram(
			shaper.font,
			shaped.usedGlyphs.keys(),
			shaped.usedGlyphs,
			OVERLAY_FONT_NAME
		);
		for (const { id, object } of buildFontObjects(built.program, ids)) writer.set(id, object);
		fontId = ids.font;
		glyphIdMap = built.glyphIdMap;
	}

	const imageIds: Map<string, number> = new Map();
	for (const image of images) {
		const png: DecodedPngImage | undefined = decoded.get(image.id);
		if (png === undefined) continue;
		imageIds.set(image.id, emitImage(writer, png));
	}

	let saveStateId: number | null = null;
	let restoreStateId: number | null = null;
	const budget: CopyBudget = { streamBytes: 0 };
	const pageIds: number[] = [];
	const sourcePageCounts: number[] = [];

	input.sources.forEach((source: ComposePdfSource, sourceIndex: number): void => {
		const reader: PdfObjectReader = readers[sourceIndex];
		const importer: SourceImporter = new SourceImporter(reader, writer, budget);
		const pages: readonly PdfPageNode[] = pagesBySource[sourceIndex];
		sourcePageCounts.push(pages.length);
		pages.forEach((page: PdfPageNode, pageIndex: number): void => {
			const contentIds: number[] = contentStreamIds(importer, reader, page.contents);
			if (contentIds.length > 0 && (saveStateId === null || restoreStateId === null)) {
				// Imported content can leave the graphics state dirty, so it is
				// bracketed before SignKit draws anything of its own. Two shared
				// one-operator streams cost less than repeating them per page.
				saveStateId = writer.append({ body: '<< /Length 1 >>', stream: latin1Bytes('q') });
				restoreStateId = writer.append({ body: '<< /Length 1 >>', stream: latin1Bytes('Q') });
			}
			const operations: readonly OverlayOperation[] = source.overlays?.get(pageIndex) ?? [];
			const needsFont: boolean = operations.some(
				(operation: OverlayOperation): boolean => operation.kind === 'text'
			);
			const resources: PageResourceNames = mergeResources(
				importer,
				reader,
				page,
				needsFont ? fontId : null,
				operations,
				imageIds
			);
			const overlayStream: Uint8Array = deflatePdfStream(
				latin1Bytes(
					buildOverlayContent({
						page,
						operations,
						resources,
						shaped,
						glyphIdMap,
						runKeyPrefix: `${sourceIndex}:${pageIndex}`
					})
				)
			);
			const overlayId: number = writer.append({
				body: `<< /Length ${overlayStream.byteLength} /Filter /FlateDecode >>`,
				stream: overlayStream
			});
			const contents: number[] =
				contentIds.length === 0
					? [overlayId]
					: [saveStateId as number, ...contentIds, restoreStateId as number, overlayId];
			const pageId: number = writer.append({
				body:
					`<< /Type /Page /Parent ${pagesId} 0 R ` +
					`/MediaBox [${page.mediaBox.map(formatNumber).join(' ')}] ` +
					(page.rotate === 0 ? '' : `/Rotate ${page.rotate} `) +
					`/Resources ${resources.body} ` +
					(page.dict.entries.has('Group')
						? `/Group ${importer.serialize(page.dict.entries.get('Group') as PdfValue, 0)} `
						: '') +
					`/Contents [${contents.map((id: number): string => `${id} 0 R`).join(' ')}] >>`
			});
			pageIds.push(pageId);
		});
	});

	writer.set(catalogId, { body: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` });
	writer.set(pagesId, {
		body: `<< /Type /Pages /Kids [${pageIds.map((id: number): string => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
	});

	const bytes: Uint8Array = assemblePdf(writer.objects());
	if (bytes.byteLength > maxOutputBytes) {
		throw fail('output_too_large', 'Composed PDF exceeds the output size budget');
	}
	return { bytes, pageCount: pageIds.length, sourcePageCounts };
}

/** Width of `text` at `size` points in the bundled document font. */
export function measureOverlayText(text: string, size: number): number {
	return sharedShaper().measure(text) * size;
}

/**
 * The largest size at or below `maximumSize` that keeps `text` inside
 * `maximumWidth`, never smaller than `minimumSize`. Deterministic by
 * construction: no iteration, no rounding beyond the PDF number precision.
 */
export function fitOverlayTextSize(
	text: string,
	maximumWidth: number,
	maximumSize: number,
	minimumSize: number
): number {
	const unitWidth: number = sharedShaper().measure(text);
	if (unitWidth <= 0) return maximumSize;
	const fitted: number = maximumWidth / unitWidth;
	return Math.max(minimumSize, Math.min(maximumSize, Math.floor(fitted * 1000) / 1000));
}

interface ShapedText {
	glyphIds: readonly number[];
}

interface ShapedOverlays {
	/** Shaped runs keyed by `${sourceIndex}:${pageIndex}:${operationIndex}`. */
	runs: Map<string, ShapedText>;
	/** Old glyph id -> the code points it renders, for the subset's ToUnicode map. */
	usedGlyphs: Map<number, readonly number[]>;
}

class OverlayShaper {
	readonly font: TrueTypeFont = documentFont();
	readonly #glyphs: Map<number, number> = new Map();
	readonly #widths: Map<number, number> = new Map();
	readonly used: Map<number, readonly number[]> = new Map();

	shape(text: string): ShapedText {
		const glyphIds: number[] = [];
		for (const character of text) {
			const codePoint: number = character.codePointAt(0) ?? 0;
			glyphIds.push(this.#glyphFor(codePoint));
		}
		return { glyphIds };
	}

	/** Width at font size 1, in points. */
	measure(text: string): number {
		let total: number = 0;
		for (const character of text) {
			const glyphId: number = this.#glyphFor(character.codePointAt(0) ?? 0);
			total += this.#widths.get(glyphId) ?? 0.5;
		}
		return total;
	}

	#glyphFor(codePoint: number): number {
		const cached: number | undefined = this.#glyphs.get(codePoint);
		if (cached !== undefined) return cached;
		const glyphId: number = this.font.glyphIdForCodePoint(codePoint);
		this.#glyphs.set(codePoint, glyphId);
		this.#widths.set(glyphId, this.font.advanceWidth(glyphId) / this.font.metrics.unitsPerEm);
		if (!this.used.has(glyphId)) this.used.set(glyphId, [codePoint]);
		return glyphId;
	}
}

let measurementShaper: OverlayShaper | null = null;

function sharedShaper(): OverlayShaper {
	if (measurementShaper === null) measurementShaper = new OverlayShaper();
	return measurementShaper;
}

function shapeOverlays(
	sources: readonly ComposePdfSource[],
	pagesBySource: readonly (readonly PdfPageNode[])[],
	shaper: OverlayShaper
): ShapedOverlays {
	const runs: Map<string, ShapedText> = new Map();
	let operationCount: number = 0;
	sources.forEach((source: ComposePdfSource, sourceIndex: number): void => {
		const pageCount: number = pagesBySource[sourceIndex].length;
		for (const [pageIndex, operations] of source.overlays ?? new Map()) {
			if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
				throw fail('invalid_overlay', 'An overlay targets a page the source does not have');
			}
			operationCount += operations.length;
			if (operationCount > MAX_COMPOSED_PDF_OVERLAY_OPERATIONS) {
				throw fail('too_many_operations', 'Too many overlay operations for one composed PDF');
			}
			operations.forEach((operation: OverlayOperation, operationIndex: number): void => {
				if (operation.kind !== 'text') return;
				if (operation.text.length > MAX_COMPOSED_PDF_TEXT_LENGTH) {
					throw fail('invalid_overlay', 'An overlay text run exceeds the supported length');
				}
				runs.set(`${sourceIndex}:${pageIndex}:${operationIndex}`, shaper.shape(operation.text));
			});
		}
	});
	return { runs, usedGlyphs: shaper.used };
}

interface PlannedImageDecode {
	image: ComposePdfImage;
	estimate: PngDecodeMemoryEstimate;
}

function decodeImages(
	images: readonly ComposePdfImage[],
	residentSourceBytes: number,
	maximumWorkingSetBytes: number
): Map<string, DecodedPngImage> {
	const planned: readonly PlannedImageDecode[] = planImageDecodes(
		images,
		residentSourceBytes,
		maximumWorkingSetBytes
	);
	const decoded: Map<string, DecodedPngImage> = new Map();
	for (const plan of planned) {
		try {
			const png: DecodedPngImage = decodePng(plan.image.pngBytes, {
				maximumWorkingBytes: plan.estimate.peakWorkingBytes
			});
			decoded.set(plan.image.id, png);
		} catch (error: unknown) {
			if (error instanceof PngDecodeError) throw imageDecodeError(error);
			throw error;
		}
	}
	return decoded;
}

function planImageDecodes(
	images: readonly ComposePdfImage[],
	residentSourceBytes: number,
	maximumWorkingSetBytes: number
): readonly PlannedImageDecode[] {
	if (residentSourceBytes > maximumWorkingSetBytes) {
		throw fail(
			'decoded_image_budget_exceeded',
			'PDF and image sources exceed the composition working-set budget'
		);
	}
	const planned: PlannedImageDecode[] = [];
	const identifiers: Set<string> = new Set();
	let retainedBytes: number = 0;
	for (const image of images) {
		if (identifiers.has(image.id)) continue;
		identifiers.add(image.id);
		let estimate: PngDecodeMemoryEstimate;
		try {
			estimate = estimatePngDecodeMemory(image.pngBytes);
		} catch (error: unknown) {
			if (error instanceof PngDecodeError) throw imageDecodeError(error);
			throw error;
		}
		const peakWorkingSetBytes: number =
			residentSourceBytes + retainedBytes + estimate.peakWorkingBytes;
		if (
			!Number.isSafeInteger(peakWorkingSetBytes) ||
			peakWorkingSetBytes > maximumWorkingSetBytes
		) {
			throw fail(
				'decoded_image_budget_exceeded',
				'Overlay image decoding exceeds the composition working-set budget'
			);
		}
		planned.push({ image, estimate });
		retainedBytes += estimate.retainedBytes;
	}
	return planned;
}

function imageDecodeError(error: PngDecodeError): PdfCompositionError {
	const reason: PdfCompositionReason =
		error.reason === 'decoded_budget_exceeded' ? 'decoded_image_budget_exceeded' : 'invalid_image';
	return new PdfCompositionError(
		reason,
		reason === 'decoded_image_budget_exceeded'
			? 'Overlay image decoding exceeds the composition working-set budget'
			: 'An overlay image could not be decoded',
		{ cause: error }
	);
}

function emitImage(writer: ObjectWriter, image: DecodedPngImage): number {
	let softMaskId: number | null = null;
	if (image.alpha !== null) {
		const mask: Uint8Array = deflatePdfStream(image.alpha);
		softMaskId = writer.append({
			body: softMaskBody(image.width, image.height, mask.byteLength),
			stream: mask
		});
	}
	const samples: Uint8Array = deflatePdfStream(image.samples);
	return writer.append({
		body: imageBody(image.width, image.height, image.colorSpace, samples.byteLength, softMaskId),
		stream: samples
	});
}

function softMaskBody(width: number, height: number, length: number): string {
	return (
		`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
		`/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${length} >>`
	);
}

function imageBody(
	width: number,
	height: number,
	colorSpace: DecodedPngImage['colorSpace'],
	length: number,
	softMaskId: number | null
): string {
	return (
		`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
		`/ColorSpace ${colorSpace === 'gray' ? '/DeviceGray' : '/DeviceRGB'} ` +
		`/BitsPerComponent 8 /Filter /FlateDecode /Length ${length}` +
		(softMaskId === null ? ' >>' : ` /SMask ${softMaskId} 0 R >>`)
	);
}

/**
 * Exact byte length of the sample and soft-mask streams `composePdf` emits
 * for one decoded image. A PNG's own size does not bound this: the composer
 * re-deflates raw planes without PNG's scanline predictors, so callers that
 * must bound future output (signature upload) measure it directly.
 */
export function emittedImageStreamBytes(image: DecodedPngImage): number {
	const samples: number = deflatePdfStream(image.samples).byteLength;
	return image.alpha === null ? samples : samples + deflatePdfStream(image.alpha).byteLength;
}

interface PageResourceNames {
	body: string;
	font: string;
	images: ReadonlyMap<string, string>;
}

function mergeResources(
	importer: SourceImporter,
	reader: PdfObjectReader,
	page: PdfPageNode,
	fontId: number | null,
	operations: readonly OverlayOperation[],
	imageIds: ReadonlyMap<string, number>
): PageResourceNames {
	const resolved: PdfValue | null = page.resources === null ? null : reader.resolve(page.resources);
	if (resolved !== null && !isDict(resolved)) {
		throw fail('invalid_resources', 'A source page has a malformed /Resources entry');
	}
	const existing: PdfDict | null = resolved === null ? null : resolved;
	const usedImages: string[] = [];
	for (const operation of operations) {
		if (operation.kind !== 'image') continue;
		if (!imageIds.has(operation.imageId)) {
			throw fail('unknown_image', 'An overlay references an image that was not supplied');
		}
		if (!usedImages.includes(operation.imageId)) usedImages.push(operation.imageId);
	}

	const prefix: string = uniquePrefix(existing, reader);
	const fontName: string = `${prefix}F`;
	const imageNames: Map<string, string> = new Map(
		usedImages.map((id: string, index: number): [string, string] => [id, `${prefix}I${index}`])
	);

	const parts: string[] = [];
	for (const [key, value] of existing?.entries ?? []) {
		if (key === 'Font' || key === 'XObject') continue;
		parts.push(`/${escapeName(key)} ${importer.serialize(value, 0)}`);
	}
	const fontEntries: string[] = subDictionaryEntries(importer, reader, existing, 'Font');
	if (fontId !== null) fontEntries.push(`/${escapeName(fontName)} ${fontId} 0 R`);
	if (fontEntries.length > 0) parts.push(`/Font << ${fontEntries.join(' ')} >>`);

	const xobjectEntries: string[] = subDictionaryEntries(importer, reader, existing, 'XObject');
	for (const [id, name] of imageNames) {
		xobjectEntries.push(`/${escapeName(name)} ${imageIds.get(id) as number} 0 R`);
	}
	if (xobjectEntries.length > 0) parts.push(`/XObject << ${xobjectEntries.join(' ')} >>`);

	return { body: `<< ${parts.join(' ')} >>`, font: fontName, images: imageNames };
}

function subDictionaryEntries(
	importer: SourceImporter,
	reader: PdfObjectReader,
	resources: PdfDict | null,
	key: 'Font' | 'XObject'
): string[] {
	const value: PdfValue | undefined = resources?.entries.get(key);
	if (value === undefined) return [];
	const resolved: PdfValue = reader.resolve(value);
	if (!isDict(resolved)) {
		throw fail('invalid_resources', `A source page has a malformed /${key} resource dictionary`);
	}
	const entries: string[] = [];
	for (const [name, entry] of resolved.entries) {
		entries.push(`/${escapeName(name)} ${importer.serialize(entry, 0)}`);
	}
	return entries;
}

/** A resource-name prefix that cannot collide with any name the source already uses. */
function uniquePrefix(resources: PdfDict | null, reader: PdfObjectReader): string {
	const taken: Set<string> = new Set<string>();
	for (const key of ['Font', 'XObject'] as const) {
		const value: PdfValue | undefined = resources?.entries.get(key);
		if (value === undefined) continue;
		const resolved: PdfValue = reader.resolve(value);
		if (!isDict(resolved)) continue;
		for (const name of resolved.entries.keys()) taken.add(name);
	}
	let prefix: string = 'SK';
	while ([...taken].some((name: string): boolean => name.startsWith(prefix))) prefix += 'X';
	return prefix;
}

/**
 * `/Contents` is either one stream reference or an array of them (possibly
 * behind a reference of its own). Anything else carries no drawable content.
 */
function contentStreamIds(
	importer: SourceImporter,
	reader: PdfObjectReader,
	contents: PdfValue | undefined
): number[] {
	if (contents === undefined) return [];
	const resolved: PdfValue = isRef(contents) ? reader.resolve(contents) : contents;
	if (isArray(resolved)) {
		const ids: number[] = [];
		for (const item of resolved.items) {
			if (isRef(item)) ids.push(importer.refFor(item));
		}
		return ids;
	}
	return isRef(contents) ? [importer.refFor(contents)] : [];
}

/**
 * Maps display space (origin bottom-left of the page as displayed, y upward)
 * into the page's own user space, undoing `/Rotate` and any non-zero MediaBox
 * origin.
 */
export function displayToUserMatrix(
	mediaBox: readonly [number, number, number, number],
	rotate: number
): readonly [number, number, number, number, number, number] {
	const [x0, y0, x1, y1] = mediaBox;
	const width: number = x1 - x0;
	const height: number = y1 - y0;
	if (rotate === 90) return [0, 1, -1, 0, x0 + width, y0];
	if (rotate === 180) return [-1, 0, 0, -1, x0 + width, y0 + height];
	if (rotate === 270) return [0, -1, 1, 0, x0, y0 + height];
	return [1, 0, 0, 1, x0, y0];
}

/** The page's displayed size in points, with `/Rotate` applied. */
export function displayedSize(page: PdfPageNode): { width: number; height: number } {
	const width: number = page.mediaBox[2] - page.mediaBox[0];
	const height: number = page.mediaBox[3] - page.mediaBox[1];
	return page.rotate === 90 || page.rotate === 270
		? { width: height, height: width }
		: { width, height };
}

interface OverlayContentInput {
	page: PdfPageNode;
	operations: readonly OverlayOperation[];
	resources: PageResourceNames;
	shaped: ShapedOverlays;
	glyphIdMap: ReadonlyMap<number, number>;
	runKeyPrefix: string;
}

function buildOverlayContent(input: OverlayContentInput): string {
	const { page, operations, resources, shaped, glyphIdMap } = input;
	if (operations.length === 0) return '';
	const parts: string[] = [
		'q',
		`${displayToUserMatrix(page.mediaBox, page.rotate).map(formatNumber).join(' ')} cm`
	];
	operations.forEach((operation: OverlayOperation, index: number): void => {
		if (operation.kind === 'rectangle') {
			parts.push('q');
			if (operation.fill !== null) parts.push(`${colorOperands(operation.fill)} rg`);
			if (operation.stroke !== null) {
				parts.push(`${colorOperands(operation.stroke)} RG`);
				parts.push(`${formatNumber(operation.lineWidth)} w`);
			}
			parts.push(
				`${formatNumber(operation.x)} ${formatNumber(operation.y)} ${formatNumber(operation.width)} ${formatNumber(operation.height)} re`
			);
			if (operation.fill !== null && operation.stroke !== null) parts.push('B');
			else if (operation.fill !== null) parts.push('f');
			else if (operation.stroke !== null) parts.push('S');
			else parts.push('n');
			parts.push('Q');
			return;
		}
		if (operation.kind === 'polyline') {
			if (operation.points.length < 2) return;
			parts.push('q');
			parts.push(`${colorOperands(operation.stroke)} RG`);
			parts.push(`${formatNumber(operation.lineWidth)} w 1 J 1 j`);
			operation.points.forEach((point: readonly [number, number], pointIndex: number): void => {
				parts.push(
					`${formatNumber(point[0])} ${formatNumber(point[1])} ${pointIndex === 0 ? 'm' : 'l'}`
				);
			});
			parts.push('S');
			parts.push('Q');
			return;
		}
		if (operation.kind === 'image') {
			const name: string | undefined = resources.images.get(operation.imageId);
			if (name === undefined) return;
			parts.push('q');
			parts.push(
				`${formatNumber(operation.width)} 0 0 ${formatNumber(operation.height)} ${formatNumber(operation.x)} ${formatNumber(operation.y)} cm`
			);
			parts.push(`/${escapeName(name)} Do`);
			parts.push('Q');
			return;
		}
		const run: ShapedText | undefined = shaped.runs.get(`${input.runKeyPrefix}:${index}`);
		const glyphIds: readonly number[] = (run?.glyphIds ?? []).map(
			(glyphId: number): number => glyphIdMap.get(glyphId) ?? 0
		);
		if (glyphIds.length === 0) return;
		parts.push('BT');
		parts.push(`${colorOperands(operation.color)} rg`);
		parts.push(`/${escapeName(resources.font)} ${formatNumber(operation.size)} Tf`);
		parts.push(`1 0 0 1 ${formatNumber(operation.x)} ${formatNumber(operation.baseline)} Tm`);
		parts.push(`<${hexGlyphs(glyphIds)}> Tj`);
		parts.push('ET');
	});
	parts.push('Q');
	return parts.join('\n');
}

function colorOperands(color: PdfColor): string {
	return `${formatNumber(color.red)} ${formatNumber(color.green)} ${formatNumber(color.blue)}`;
}

interface CopyBudget {
	streamBytes: number;
}

class ObjectWriter {
	readonly #objects: (PdfObject | null)[] = [];

	reserve(): number {
		this.#objects.push(null);
		if (this.#objects.length > MAX_COMPOSED_PDF_OBJECTS) {
			throw fail('object_budget_exceeded', 'Composed PDF exceeds the object budget');
		}
		return this.#objects.length;
	}

	set(id: number, object: PdfObject): void {
		this.#objects[id - 1] = object;
	}

	append(object: PdfObject): number {
		const id: number = this.reserve();
		this.set(id, object);
		return id;
	}

	objects(): readonly PdfObject[] {
		return this.#objects.map((object: PdfObject | null): PdfObject => object ?? { body: 'null' });
	}
}

/**
 * Copies one source document's object subgraph into the output, renumbering
 * references as it goes. Streams are carried over raw, still carrying their
 * original `/Filter`, so no page content is ever re-encoded.
 */
class SourceImporter {
	readonly #reader: PdfObjectReader;
	readonly #writer: ObjectWriter;
	readonly #budget: CopyBudget;
	readonly #copied: Map<string, number> = new Map();

	constructor(reader: PdfObjectReader, writer: ObjectWriter, budget: CopyBudget) {
		this.#reader = reader;
		this.#writer = writer;
		this.#budget = budget;
	}

	refFor(ref: PdfRef): number {
		const key: string = `${ref.objectNumber}:${ref.generation}`;
		const existing: number | undefined = this.#copied.get(key);
		if (existing !== undefined) return existing;
		const id: number = this.#writer.reserve();
		// Recorded before the body is serialized so a reference cycle in the
		// source resolves to this same object instead of recursing forever.
		this.#copied.set(key, id);
		let object;
		try {
			object = this.#reader.indirect(ref);
		} catch (error: unknown) {
			if (error instanceof PdfPageMetadataError) {
				throw new PdfCompositionError('invalid_source', 'A source object could not be read', {
					cause: error
				});
			}
			throw error;
		}
		if (object.stream === null) {
			this.#writer.set(id, { body: this.serialize(object.value, 0) });
			return id;
		}
		this.#budget.streamBytes += object.stream.byteLength;
		if (this.#budget.streamBytes > MAX_COMPOSED_PDF_COPIED_STREAM_BYTES) {
			throw fail('input_too_large', 'Copied page content exceeds the composition budget');
		}
		this.#writer.set(id, {
			body: this.serializeDict(
				object.dict,
				0,
				new Map([['Length', String(object.stream.byteLength)]])
			),
			stream: Uint8Array.from(object.stream)
		});
		return id;
	}

	serialize(value: PdfValue, depth: number): string {
		if (depth > MAX_COPY_DEPTH) {
			throw fail('invalid_source', 'A source object nests past the copy depth limit');
		}
		if (value === null) return 'null';
		if (typeof value === 'boolean') return value ? 'true' : 'false';
		if (typeof value === 'number') return formatNumber(value);
		if (typeof value === 'string') return `<${hexString(value)}>`;
		if (value.kind === 'name') return `/${escapeName(value.value)}`;
		if (value.kind === 'ref') return `${this.refFor(value)} 0 R`;
		if (value.kind === 'array') {
			return `[${value.items.map((item: PdfValue): string => this.serialize(item, depth + 1)).join(' ')}]`;
		}
		return this.serializeDict(value, depth, new Map());
	}

	serializeDict(dict: PdfDict, depth: number, overrides: ReadonlyMap<string, string>): string {
		const parts: string[] = [];
		for (const [key, entry] of dict.entries) {
			const override: string | undefined = overrides.get(key);
			parts.push(`/${escapeName(key)} ${override ?? this.serialize(entry, depth + 1)}`);
		}
		for (const [key, override] of overrides) {
			if (!dict.entries.has(key)) parts.push(`/${escapeName(key)} ${override}`);
		}
		return `<< ${parts.join(' ')} >>`;
	}
}

/** Strings are re-emitted as hex so every byte round-trips without escaping rules. */
function hexString(value: string): string {
	let hex: string = '';
	for (let index: number = 0; index < value.length; index += 1) {
		hex += (value.charCodeAt(index) & 0xff).toString(16).padStart(2, '0');
	}
	return hex;
}

function escapeName(name: string): string {
	let escaped: string = '';
	for (let index: number = 0; index < name.length; index += 1) {
		const code: number = name.charCodeAt(index) & 0xff;
		const regular: boolean =
			code > 0x20 && code < 0x7f && !'()<>[]{}/%#'.includes(String.fromCharCode(code));
		escaped += regular
			? String.fromCharCode(code)
			: `#${code.toString(16).padStart(2, '0').toUpperCase()}`;
	}
	return escaped;
}

function fail(reason: PdfCompositionReason, message: string): PdfCompositionError {
	return new PdfCompositionError(reason, message);
}

/**
 * Upper bound on `deflatePdfStream(bytes).byteLength` for any `rawBytes`-long
 * input, whatever its content: fflate 0.8 writes the zlib stream into one
 * buffer of exactly `2 + n + 5 * (1 + ceil(n / 7000)) + 4` bytes and returns
 * a prefix of it (stored blocks are its fallback whenever compression would
 * be larger). `pdf-composer.spec.ts` re-checks this against incompressible
 * input so a dependency upgrade that changes it fails loudly.
 */
export function maxDeflatedPdfStreamBytes(rawBytes: number): number {
	return 2 + rawBytes + 5 * (1 + Math.ceil(rawBytes / 7000)) + 4;
}

/**
 * The most an overlay operation can contribute, for a budget computed before
 * its values exist. `maxLength` is in UTF-16 code units, the same unit
 * `MAX_COMPOSED_PDF_TEXT_LENGTH` limits.
 */
export type OverlayOperationBound =
	{ kind: 'text'; maxLength: number } | { kind: 'image' } | { kind: 'polyline'; points: number };

export interface OverlayBudgetPage {
	reader: PdfObjectReader;
	page: PdfPageNode;
	operations: readonly OverlayOperationBound[];
	/** Upper bound on the magnitude of every numeric operand the operations will carry. */
	maxOperandMagnitude: number;
}

export interface OverlayBudgetInput {
	pages: readonly OverlayBudgetPage[];
	/** Upper bound on distinct images across the whole composition. */
	imageCount: number;
	/** Upper bound on one image's {@link emittedImageStreamBytes}. */
	maxImageStreamBytes: number;
}

/**
 * Objects a budget dry run must reserve (`ComposePdfInput.reservedObjectCount`)
 * so that adding the overlay font and images can only lower, never raise,
 * every other object's number and the total object count.
 */
export function overlayReservedObjectCount(hasText: boolean, imageCount: number): number {
	return (hasText ? OVERLAY_FONT_OBJECT_COUNT : 0) + imageCount * 2;
}

/**
 * Upper bound on how many bytes drawing `input`'s overlays adds to a
 * composition of the same sources made without overlays or images but with
 * {@link overlayReservedObjectCount} objects reserved.
 *
 * Against such a dry run the overlaid composition differs only in: the
 * reserved `null` objects becoming the font and image objects; each overlaid
 * page's content stream growing from an empty deflate to its operations; each
 * overlaid page's `/Resources` gaining font and image entries; and the
 * `startxref` value gaining digits. Object numbering, the copied source graph,
 * and every page without overlays are byte-identical. Each term below mirrors
 * the serialization it bounds in this file and in `pdf-writer-primitives.ts`.
 */
export function overlayOutputReserve(input: OverlayBudgetInput): number {
	const objectIdDigits: number = String(MAX_COMPOSED_PDF_OBJECTS).length;
	// `/Name 12345 0 R`, plus its separating space.
	const referenceEntry = (nameLength: number): number => 1 + nameLength + 1 + objectIdDigits + 5;
	let hasText: boolean = false;
	let total: number = 0;
	for (const entry of input.pages) {
		if (entry.operations.length === 0) continue;
		const number: number = operandLengthBound(entry.maxOperandMagnitude);
		const resolved: PdfValue | null =
			entry.page.resources === null ? null : entry.reader.resolve(entry.page.resources);
		const prefix: string = uniquePrefix(isDict(resolved) ? resolved : null, entry.reader);
		const fontName: number = escapeName(`${prefix}F`).length;
		const imageOperations: number = entry.operations.filter(
			(operation: OverlayOperationBound): boolean => operation.kind === 'image'
		).length;
		const imageName: number = escapeName(`${prefix}I${Math.max(0, imageOperations - 1)}`).length;
		// Every line is counted with a trailing newline, one more than `join('\n')` emits.
		let content: number =
			`q\n${displayToUserMatrix(entry.page.mediaBox, entry.page.rotate).map(formatNumber).join(' ')} cm\nQ\n`
				.length;
		let pageHasText: boolean = false;
		for (const operation of entry.operations) {
			if (operation.kind === 'text') {
				if (operation.maxLength > MAX_COMPOSED_PDF_TEXT_LENGTH) {
					throw fail('invalid_overlay', 'An overlay text bound exceeds the supported length');
				}
				pageHasText = true;
				// BT / r g b rg / /F s Tf / 1 0 0 1 x y Tm / <hex> Tj / ET; four hex digits per code point.
				content += 6 * number + fontName + 4 * operation.maxLength + 37;
			} else if (operation.kind === 'image') {
				// q / w 0 0 h x y cm / /I Do / Q
				content += 4 * number + imageName + 20;
			} else {
				// q / r g b RG / w w 1 J 1 j / per point: x y m|l / S / Q
				content += 4 * number + 23 + operation.points * (2 * number + 4);
			}
		}
		const stream: number = maxDeflatedPdfStreamBytes(content);
		total += stream + String(stream).length;
		if (pageHasText) {
			hasText = true;
			total += '/Font << '.length + referenceEntry(fontName) + ' >> '.length;
		}
		if (imageOperations > 0) {
			total += '/XObject << '.length + imageOperations * referenceEntry(imageName) + ' >> '.length;
		}
	}
	if (hasText) total += overlayFontObjectsBound();
	if (input.imageCount > 0) {
		const imageStream: number = input.maxImageStreamBytes;
		const largestImageBody: number = Math.max(
			imageBody(MAX_PNG_DIMENSION, MAX_PNG_DIMENSION, 'gray', imageStream, MAX_COMPOSED_PDF_OBJECTS)
				.length,
			imageBody(MAX_PNG_DIMENSION, MAX_PNG_DIMENSION, 'rgb', imageStream, MAX_COMPOSED_PDF_OBJECTS)
				.length
		);
		const perImage: number =
			largestImageBody +
			softMaskBody(MAX_PNG_DIMENSION, MAX_PNG_DIMENSION, imageStream).length +
			2 * STREAM_FRAMING_BYTES +
			imageStream;
		total += input.imageCount * perImage;
	}
	// `startxref` is the only trailer value that grows with the body.
	return total + String(Number.MAX_SAFE_INTEGER).length;
}

/** `stream\n` and `\nendstream\n` around each stream object's bytes. */
const STREAM_FRAMING_BYTES: number = 'stream\n'.length + '\nendstream\n'.length;

/**
 * `formatNumber` rounds to three decimals and prints the shortest round-trip
 * form, so an operand of magnitude at most `magnitude` prints in at most a
 * sign, its integer digits, a point, and three decimals.
 */
function operandLengthBound(magnitude: number): number {
	if (!Number.isFinite(magnitude) || magnitude < 0 || magnitude >= 1e15) {
		throw fail('invalid_overlay', 'An overlay operand bound is outside the supported range');
	}
	return 1 + String(Math.floor(magnitude) + 1).length + 1 + 3;
}

let overlayFontBoundCache: number | null = null;

/**
 * Upper bound on the five overlay font objects for *any* glyph subset of the
 * bundled face, derived from the face itself rather than from today's text:
 *
 * - FontFile2: every subset table but `cmap` is a monotone function of the
 *   glyph set (glyph data, `loca`, `hmtx`) or fixed, so the all-glyph subset
 *   bounds them; a subset `cmap` has at most one 12-byte group per mapped
 *   code point, so adding 12 bytes per code point the full `cmap` maps
 *   bounds it too.
 * - ToUnicode: the fixed CMap text plus one `<gid> <utf16>` line (at most 18
 *   bytes) per glyph and one `n beginbfchar`/`endbfchar` pair per 100.
 * - Dictionaries: measured from a real one-glyph build with five-digit
 *   object numbers, plus a worst-case one-glyph-per-run `/W` array and the
 *   stream `/Length` digits.
 */
function overlayFontObjectsBound(): number {
	if (overlayFontBoundCache !== null) return overlayFontBoundCache;
	const font: TrueTypeFont = documentFont();
	const glyphs: number = font.numGlyphs;
	const full: Uint8Array = font.subset(
		Array.from({ length: glyphs }, (_unused: unknown, glyphId: number): number => glyphId)
	).font;
	const programBound: number = full.byteLength + 12 * sfntCmapCodePointCount(full);

	const minimal = buildFontProgram(font, [], new Map(), OVERLAY_FONT_NAME);
	const ids = {
		font: MAX_COMPOSED_PDF_OBJECTS - 4,
		descendantFont: MAX_COMPOSED_PDF_OBJECTS - 3,
		descriptor: MAX_COMPOSED_PDF_OBJECTS - 2,
		fontFile: MAX_COMPOSED_PDF_OBJECTS - 1,
		toUnicode: MAX_COMPOSED_PDF_OBJECTS
	};
	let bodies: number = 0;
	let toUnicodeFixed: number = 0;
	for (const { id, object } of buildFontObjects(minimal.program, ids)) {
		bodies += object.body.length;
		if (id === ids.toUnicode && object.stream !== undefined) {
			toUnicodeFixed = unzlibSync(object.stream).byteLength;
		}
	}
	const toUnicodeBound: number = toUnicodeFixed + 18 * glyphs + 26 * Math.ceil(glyphs / 100);
	const widthDigits: number = String(Math.round((0xffff * 1000) / font.metrics.unitsPerEm)).length;
	// `${start} [${width}]` and a separating space, per glyph.
	const widthArray: number = glyphs * (String(glyphs).length + widthDigits + 4);
	const program: number = maxDeflatedPdfStreamBytes(programBound);
	const toUnicode: number = maxDeflatedPdfStreamBytes(toUnicodeBound);
	overlayFontBoundCache =
		bodies +
		widthArray +
		String(program).length +
		String(programBound).length +
		String(toUnicode).length +
		program +
		toUnicode +
		2 * STREAM_FRAMING_BYTES;
	return overlayFontBoundCache;
}

/** Code points mapped by the single format-12 `cmap` subtable `TrueTypeFont#subset` writes. */
function sfntCmapCodePointCount(sfnt: Uint8Array): number {
	const view: DataView = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
	const tableCount: number = view.getUint16(4);
	for (let index: number = 0; index < tableCount; index += 1) {
		const record: number = 12 + index * 16;
		if (String.fromCharCode(...sfnt.subarray(record, record + 4)) !== 'cmap') continue;
		const subtable: number =
			view.getUint32(record + 8) + view.getUint32(view.getUint32(record + 8) + 8);
		const groups: number = view.getUint32(subtable + 12);
		let codePoints: number = 0;
		for (let group: number = 0; group < groups; group += 1) {
			const offset: number = subtable + 16 + group * 12;
			codePoints += view.getUint32(offset + 4) - view.getUint32(offset) + 1;
		}
		return codePoints;
	}
	throw new Error('Subset font has no cmap table');
}
