import { unzlibSync, inflateSync } from 'fflate';
import {
	MAX_UPLOADED_PDF_PAGE_DIMENSION,
	MAX_UPLOADED_PDF_PAGES
} from '$lib/application/documents/uploaded-pdf';

/**
 * Bounded structural PDF reader.
 *
 * It walks the cross-reference chain, resolves indirect objects, and
 * enumerates page-tree leaves with their inherited geometry and resources. It
 * never decodes a content stream, never executes anything, and never renders:
 * every consumer either reads metadata from what it returns
 * ({@link import('./pdf-page-metadata').parsePdfPageMetadata}) or copies raw,
 * already-filtered object bytes verbatim into a new document
 * ({@link import('./pdf-composer').composePdf}).
 *
 * Every traversal is bounded: inflate output, `/Prev` chain length, page-tree
 * depth, object nesting, node count, and token count all have hard ceilings so
 * a hostile file cannot exhaust a Worker isolate.
 */

export const MAX_PDF_INFLATE_BYTES: number = 32 * 1024 * 1024;
export const MAX_PDF_PREV_CHAIN: number = 64;
export const MAX_PDF_PAGE_TREE_DEPTH: number = 64;
export const MAX_PDF_NESTING: number = 64;
export const MAX_PDF_NODE_BUDGET: number = 8_192;
export const MAX_PDF_TOKEN_BUDGET: number = 2_000_000;

export type PdfPageMetadataReason =
	| 'invalid_header'
	| 'damaged_xref'
	| 'encrypted'
	| 'zero_pages'
	| 'too_many_pages'
	| 'oversized_page'
	| 'unsupported_page_geometry'
	| 'prev_cycle'
	| 'prev_chain_too_long'
	| 'page_tree_cycle'
	| 'page_tree_too_deep'
	| 'node_budget_exceeded'
	| 'inflate_bomb'
	| 'nesting_overflow'
	| 'token_budget_exceeded'
	| 'active_content_open_action'
	| 'active_content_aa'
	| 'active_content_javascript'
	| 'active_content_embedded_files';

export class PdfPageMetadataError extends Error {
	readonly code = 'PDF_PAGE_METADATA_ERROR';

	constructor(
		readonly reason: PdfPageMetadataReason,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'PdfPageMetadataError';
	}
}

export interface PdfRef {
	readonly kind: 'ref';
	readonly objectNumber: number;
	readonly generation: number;
}

export interface PdfName {
	readonly kind: 'name';
	readonly value: string;
}

export interface PdfDict {
	readonly kind: 'dict';
	readonly entries: Map<string, PdfValue>;
}

export interface PdfArray {
	readonly kind: 'array';
	readonly items: readonly PdfValue[];
}

/**
 * A parsed PDF object. Strings carry one byte per code unit (see
 * {@link ascii}), so they round-trip byte-for-byte when re-serialized.
 */
export type PdfValue = number | boolean | null | string | PdfName | PdfRef | PdfDict | PdfArray;

/** One page-tree leaf with every attribute the page tree may have inherited resolved. */
export interface PdfPageNode {
	/** The page dictionary itself, for callers that copy a whitelist of its entries. */
	readonly dict: PdfDict;
	/** `[llx, lly, urx, ury]`, already validated as four finite numbers inside the size bound. */
	readonly mediaBox: readonly [number, number, number, number];
	/** Normalized to 0, 90, 180, or 270. */
	readonly rotate: number;
	/** Inherited when the leaf itself has none; `null` when the whole tree has none. */
	readonly resources: PdfValue | null;
	/** `/Contents`, unresolved: a stream reference, an array of them, or absent. */
	readonly contents: PdfValue | undefined;
}

export interface PdfIndirectObject {
	readonly value: PdfValue;
	readonly dict: PdfDict;
	/** Raw, still-filtered stream bytes, or `null` for a non-stream object. */
	readonly stream: Uint8Array | null;
}

interface XrefEntry {
	readonly type: 0 | 1 | 2;
	readonly field2: number;
	readonly field3: number;
}

interface TrailerInfo {
	readonly root: PdfRef;
	readonly prev: number | null;
	readonly encrypt: boolean;
}

const HEADER_PATTERN: RegExp = /^%PDF-(1\.[0-9]|2\.0)/;
const WHITESPACE: Set<number> = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITER: Set<number> = new Set([
	0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25
]);

export class PdfObjectReader {
	readonly #bytes: Uint8Array;
	#pos: number = 0;
	#tokenBudget: number = MAX_PDF_TOKEN_BUDGET;
	#inflateUsed: number = 0;
	#nodeCount: number = 0;
	readonly #xref: Map<number, XrefEntry> = new Map();
	readonly #objectCache: Map<string, PdfValue> = new Map();
	readonly #objectStreams: Map<number, readonly PdfValue[]> = new Map();
	#catalog: PdfDict | null = null;
	#pages: readonly PdfPageNode[] | null = null;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}

	/** Loads the xref chain and the catalog, rejecting encryption and active content. */
	catalog(): PdfDict {
		if (this.#catalog !== null) return this.#catalog;
		this.#assertHeader();
		const startXref: number = this.#findStartXref();
		const trailer: TrailerInfo = this.#loadXrefChain(startXref);
		if (trailer.encrypt) {
			throw fail('encrypted', 'Encrypted PDFs are not accepted');
		}
		const catalog: PdfDict = this.#asDict(this.#resolve(trailer.root), 'damaged_xref');
		this.#assertCatalogSafe(catalog);
		this.#catalog = catalog;
		return catalog;
	}

	/** Page-tree leaves in document order, each with inherited geometry and resources. */
	pages(): readonly PdfPageNode[] {
		if (this.#pages !== null) return this.#pages;
		const catalog: PdfDict = this.catalog();
		const pagesRef: PdfValue | undefined = catalog.entries.get('Pages');
		if (pagesRef === undefined) throw fail('damaged_xref', 'PDF catalog is missing /Pages');
		const pages: PdfPageNode[] = [];
		this.#walkPageTree(pagesRef, null, null, null, null, 0, new Set(), pages);
		if (pages.length === 0) throw fail('zero_pages', 'The PDF contains no pages');
		if (pages.length > MAX_UPLOADED_PDF_PAGES) {
			throw fail('too_many_pages', 'The PDF has too many pages');
		}
		this.#pages = pages;
		return pages;
	}

	resolve(value: PdfValue): PdfValue {
		return this.#resolve(value);
	}

	/** Loads one indirect object, keeping its raw stream bytes when it has one. */
	indirect(ref: PdfRef): PdfIndirectObject {
		const entry: XrefEntry | undefined = this.#xref.get(ref.objectNumber);
		if (entry === undefined || entry.type === 0) {
			throw fail('damaged_xref', 'PDF object reference is missing from the xref');
		}
		if (entry.type === 2) {
			// Objects inside an object stream can never themselves be streams.
			const value: PdfValue = this.#loadCompressedObject(entry.field2, entry.field3);
			return { value, dict: asDictOrEmpty(value), stream: null };
		}
		const parsed = this.#parseIndirectObjectAt(entry.field2, true);
		return { value: parsed.value, dict: parsed.dict, stream: parsed.stream };
	}

	/** Inflates and un-predicts a stream, enforcing the shared inflate budget. */
	decodeStream(dict: PdfDict, data: Uint8Array): Uint8Array {
		return this.#decodeStream(dict, data);
	}

	#assertHeader(): void {
		if (this.#bytes.byteLength < 8) throw fail('invalid_header', 'PDF header is missing');
		const header: string = ascii(this.#bytes.subarray(0, Math.min(32, this.#bytes.byteLength)));
		if (!HEADER_PATTERN.test(header))
			throw fail('invalid_header', 'PDF header is not %PDF-1.x or %PDF-2.0');
	}

	#findStartXref(): number {
		const scan: number = Math.min(this.#bytes.byteLength, 2048);
		const tail: Uint8Array = this.#bytes.subarray(this.#bytes.byteLength - scan);
		const text: string = ascii(tail);
		const eof: number = text.lastIndexOf('%%EOF');
		if (eof < 0) throw fail('damaged_xref', 'PDF is missing %%EOF');
		const before: string = text.slice(0, eof);
		const startxref: number = before.lastIndexOf('startxref');
		if (startxref < 0) throw fail('damaged_xref', 'PDF is missing startxref');
		const rest: string = before.slice(startxref + 'startxref'.length);
		const match: RegExpExecArray | null = /^\s*(\d+)\s*$/.exec(rest);
		if (match === null) throw fail('damaged_xref', 'PDF startxref offset is invalid');
		const offset: number = Number(match[1]);
		if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.#bytes.byteLength) {
			throw fail('damaged_xref', 'PDF startxref offset is out of range');
		}
		return offset;
	}

	#loadXrefChain(startOffset: number): TrailerInfo {
		let offset: number | null = startOffset;
		let root: PdfRef | null = null;
		let encrypt: boolean = false;
		const visited: Set<number> = new Set();
		let chain: number = 0;
		while (offset !== null) {
			if (visited.has(offset)) throw fail('prev_cycle', 'PDF xref /Prev chain contains a cycle');
			visited.add(offset);
			chain += 1;
			if (chain > MAX_PDF_PREV_CHAIN) {
				throw fail('prev_chain_too_long', 'PDF xref /Prev chain is too long');
			}
			const section = this.#parseXrefSection(offset);
			for (const [objectNumber, entry] of section.entries) {
				if (!this.#xref.has(objectNumber)) this.#xref.set(objectNumber, entry);
			}
			if (section.trailer.encrypt) encrypt = true;
			if (root === null) root = section.trailer.root;
			offset = section.trailer.prev;
		}
		if (root === null) throw fail('damaged_xref', 'PDF trailer is missing /Root');
		return { root, prev: null, encrypt };
	}

	#parseXrefSection(offset: number): { entries: Map<number, XrefEntry>; trailer: TrailerInfo } {
		this.#pos = offset;
		this.#skipWhitespaceAndComments();
		if (this.#startsWith('xref')) {
			this.#pos += 4;
			return this.#parseClassicXref();
		}
		return this.#parseXrefStream(offset);
	}

	#parseClassicXref(): { entries: Map<number, XrefEntry>; trailer: TrailerInfo } {
		const entries: Map<number, XrefEntry> = new Map();
		this.#skipWhitespaceAndComments();
		while (this.#pos < this.#bytes.byteLength && !this.#startsWith('trailer')) {
			const first: PdfValue = this.#parseValue(0);
			this.#skipWhitespaceAndComments();
			if (typeof first !== 'number' || !Number.isSafeInteger(first) || first < 0) {
				throw fail('damaged_xref', 'PDF xref subsection is invalid');
			}
			const countValue: PdfValue = this.#parseValue(0);
			if (typeof countValue !== 'number' || !Number.isSafeInteger(countValue) || countValue < 0) {
				throw fail('damaged_xref', 'PDF xref subsection is invalid');
			}
			this.#skipWhitespaceAndComments();
			for (let index = 0; index < countValue; index += 1) {
				this.#consumeToken();
				const line: string = this.#readXrefLine();
				const match: RegExpExecArray | null = /^(\d{10}) (\d{5}) ([nf])(?:\s*)$/.exec(line);
				if (match === null) throw fail('damaged_xref', 'PDF xref entry is damaged');
				const objectNumber: number = first + index;
				if (match[3] === 'n' && !entries.has(objectNumber) && !this.#xref.has(objectNumber)) {
					entries.set(objectNumber, {
						type: 1,
						field2: Number(match[1]),
						field3: Number(match[2])
					});
				} else if (
					match[3] === 'f' &&
					!entries.has(objectNumber) &&
					!this.#xref.has(objectNumber)
				) {
					entries.set(objectNumber, {
						type: 0,
						field2: Number(match[1]),
						field3: Number(match[2])
					});
				}
			}
			this.#skipWhitespaceAndComments();
		}
		if (!this.#startsWith('trailer')) throw fail('damaged_xref', 'PDF xref is missing a trailer');
		this.#pos += 7;
		this.#skipWhitespaceAndComments();
		const trailerValue: PdfValue = this.#parseValue(0);
		const trailer: PdfDict = this.#asDict(trailerValue, 'damaged_xref');
		return { entries, trailer: this.#trailerFromDict(trailer) };
	}

	#readXrefLine(): string {
		const start: number = this.#pos;
		while (
			this.#pos < this.#bytes.byteLength &&
			this.#bytes[this.#pos] !== 0x0a &&
			this.#bytes[this.#pos] !== 0x0d
		) {
			this.#pos += 1;
		}
		const line: string = ascii(this.#bytes.subarray(start, this.#pos)).trimEnd();
		if (this.#pos < this.#bytes.byteLength && this.#bytes[this.#pos] === 0x0d) this.#pos += 1;
		if (this.#pos < this.#bytes.byteLength && this.#bytes[this.#pos] === 0x0a) this.#pos += 1;
		return line;
	}

	#parseXrefStream(offset: number): { entries: Map<number, XrefEntry>; trailer: TrailerInfo } {
		this.#pos = offset;
		const object = this.#parseIndirectObjectAt(offset, true);
		if (object.stream === null) throw fail('damaged_xref', 'PDF xref stream is missing its stream');
		const dict: PdfDict = object.dict;
		const type: PdfValue | undefined = dict.entries.get('Type');
		if (!isName(type, 'XRef')) throw fail('damaged_xref', 'PDF xref stream /Type is not /XRef');
		const decoded: Uint8Array = this.#decodeStream(dict, object.stream);
		const sizeValue: PdfValue | undefined = dict.entries.get('Size');
		if (typeof sizeValue !== 'number' || !Number.isSafeInteger(sizeValue) || sizeValue < 1) {
			throw fail('damaged_xref', 'PDF xref stream /Size is invalid');
		}
		const widths: readonly number[] = this.#xrefWidths(dict.entries.get('W'));
		const indexPairs: readonly number[] = this.#xrefIndex(dict.entries.get('Index'), sizeValue);
		const entrySize: number = widths[0] + widths[1] + widths[2];
		if (entrySize <= 0) throw fail('damaged_xref', 'PDF xref stream /W is invalid');
		const entries: Map<number, XrefEntry> = new Map();
		let cursor: number = 0;
		for (let pair = 0; pair < indexPairs.length; pair += 2) {
			const start: number = indexPairs[pair];
			const count: number = indexPairs[pair + 1];
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0) {
				throw fail('damaged_xref', 'PDF xref stream /Index is invalid');
			}
			for (let index = 0; index < count; index += 1) {
				if (cursor + entrySize > decoded.byteLength) {
					throw fail('damaged_xref', 'PDF xref stream is truncated');
				}
				const type: number = widths[0] === 0 ? 1 : readUnsigned(decoded, cursor, widths[0]);
				const field2: number = readUnsigned(decoded, cursor + widths[0], widths[1]);
				const field3: number = readUnsigned(decoded, cursor + widths[0] + widths[1], widths[2]);
				cursor += entrySize;
				if (type !== 0 && type !== 1 && type !== 2) {
					throw fail('damaged_xref', 'PDF xref stream entry type is invalid');
				}
				const objectNumber: number = start + index;
				if (!entries.has(objectNumber)) {
					entries.set(objectNumber, { type, field2, field3 });
				}
			}
		}
		return { entries, trailer: this.#trailerFromDict(dict) };
	}

	#xrefWidths(value: PdfValue | undefined): readonly [number, number, number] {
		if (
			value === undefined ||
			value === null ||
			typeof value !== 'object' ||
			value.kind !== 'array'
		) {
			throw fail('damaged_xref', 'PDF xref stream /W is invalid');
		}
		if (value.items.length !== 3) throw fail('damaged_xref', 'PDF xref stream /W is invalid');
		const widths: number[] = [];
		for (const item of value.items) {
			if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0 || item > 8) {
				throw fail('damaged_xref', 'PDF xref stream /W is invalid');
			}
			widths.push(item);
		}
		return [widths[0], widths[1], widths[2]];
	}

	#xrefIndex(value: PdfValue | undefined, size: number): readonly number[] {
		if (value === undefined) return [0, size];
		if (
			value === null ||
			typeof value !== 'object' ||
			value.kind !== 'array' ||
			value.items.length < 2
		) {
			throw fail('damaged_xref', 'PDF xref stream /Index is invalid');
		}
		if (value.items.length % 2 !== 0)
			throw fail('damaged_xref', 'PDF xref stream /Index is invalid');
		const pairs: number[] = [];
		for (const item of value.items) {
			if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) {
				throw fail('damaged_xref', 'PDF xref stream /Index is invalid');
			}
			pairs.push(item);
		}
		return pairs;
	}

	#trailerFromDict(dict: PdfDict): TrailerInfo {
		const rootValue: PdfValue | undefined = dict.entries.get('Root');
		if (rootValue === undefined || !isRef(rootValue)) {
			throw fail('damaged_xref', 'PDF trailer is missing /Root');
		}
		const prevValue: PdfValue | undefined = dict.entries.get('Prev');
		let prev: number | null = null;
		if (prevValue !== undefined) {
			if (typeof prevValue !== 'number' || !Number.isSafeInteger(prevValue) || prevValue < 0) {
				throw fail('damaged_xref', 'PDF trailer /Prev is invalid');
			}
			prev = prevValue;
		}
		return {
			root: rootValue,
			prev,
			encrypt: dict.entries.has('Encrypt')
		};
	}

	#assertCatalogSafe(catalog: PdfDict): void {
		if (catalog.entries.has('OpenAction')) {
			throw fail('active_content_open_action', 'PDFs with catalog /OpenAction are not accepted');
		}
		if (catalog.entries.has('AA')) {
			throw fail('active_content_aa', 'PDFs with catalog additional actions are not accepted');
		}
		const namesValue: PdfValue | undefined = catalog.entries.get('Names');
		if (namesValue === undefined) return;
		const names: PdfDict = this.#asDict(this.#resolve(namesValue), 'damaged_xref');
		if (names.entries.has('JavaScript')) {
			throw fail(
				'active_content_javascript',
				'PDFs with catalog /Names /JavaScript are not accepted'
			);
		}
		if (names.entries.has('EmbeddedFiles')) {
			throw fail(
				'active_content_embedded_files',
				'PDFs with catalog /Names /EmbeddedFiles are not accepted'
			);
		}
	}

	#walkPageTree(
		nodeValue: PdfValue,
		inheritedMediaBox: PdfArray | null,
		inheritedCropBox: PdfArray | null,
		inheritedRotate: number | null,
		inheritedResources: PdfValue | null,
		depth: number,
		visited: Set<number>,
		pages: PdfPageNode[]
	): void {
		if (depth > MAX_PDF_PAGE_TREE_DEPTH) {
			throw fail('page_tree_too_deep', 'PDF page tree is too deep');
		}
		this.#countNode();
		const resolved: PdfValue = this.#resolve(nodeValue);
		const dict: PdfDict = this.#asDict(resolved, 'damaged_xref');
		if (isRef(nodeValue)) {
			if (visited.has(nodeValue.objectNumber)) {
				throw fail('page_tree_cycle', 'PDF page tree contains a cycle');
			}
			visited.add(nodeValue.objectNumber);
		}
		const type: PdfValue | undefined = dict.entries.get('Type');
		const mediaBox: PdfArray | null =
			this.#optionalMediaBox(dict.entries.get('MediaBox')) ?? inheritedMediaBox;
		const cropBox: PdfArray | null =
			this.#optionalPageBox(dict.entries.get('CropBox'), 'CropBox') ?? inheritedCropBox;
		const rotate: number | null =
			this.#optionalRotate(dict.entries.get('Rotate')) ?? inheritedRotate;
		const resources: PdfValue | null = dict.entries.get('Resources') ?? inheritedResources;
		if (isName(type, 'Page')) {
			const mediaBoxNumbers: readonly [number, number, number, number] =
				this.#mediaBoxNumbers(mediaBox);
			if (cropBox !== null) {
				const cropBoxNumbers: readonly [number, number, number, number] = this.#pageBoxNumbers(
					cropBox,
					'CropBox'
				);
				if (!samePageBox(mediaBoxNumbers, cropBoxNumbers)) {
					throw fail(
						'unsupported_page_geometry',
						'PDF pages whose /CropBox differs from /MediaBox are not accepted'
					);
				}
			}
			this.#assertDefaultUserUnit(dict.entries.get('UserUnit'));
			pages.push({
				dict,
				mediaBox: mediaBoxNumbers,
				rotate: normalizeRotation(rotate),
				resources,
				contents: dict.entries.get('Contents')
			});
			if (isRef(nodeValue)) visited.delete(nodeValue.objectNumber);
			return;
		}
		if (!isName(type, 'Pages') && type !== undefined) {
			if (isRef(nodeValue)) visited.delete(nodeValue.objectNumber);
			return;
		}
		const kidsValue: PdfValue | undefined = dict.entries.get('Kids');
		if (kidsValue === undefined) {
			if (isRef(nodeValue)) visited.delete(nodeValue.objectNumber);
			return;
		}
		const kids: PdfArray = this.#asArray(this.#resolve(kidsValue), 'damaged_xref');
		for (const kid of kids.items) {
			this.#walkPageTree(kid, mediaBox, cropBox, rotate, resources, depth + 1, visited, pages);
		}
		if (isRef(nodeValue)) visited.delete(nodeValue.objectNumber);
	}

	#mediaBoxNumbers(mediaBox: PdfArray | null): readonly [number, number, number, number] {
		if (mediaBox === null) throw fail('damaged_xref', 'PDF page is missing /MediaBox');
		if (mediaBox.items.length !== 4) throw fail('damaged_xref', 'PDF /MediaBox is invalid');
		const numbers: number[] = [];
		for (const item of mediaBox.items) {
			const resolved: PdfValue = this.#resolve(item);
			if (typeof resolved !== 'number' || !Number.isFinite(resolved)) {
				throw fail('damaged_xref', 'PDF /MediaBox is invalid');
			}
			numbers.push(resolved);
		}
		const width: number = Math.abs(numbers[2] - numbers[0]);
		const height: number = Math.abs(numbers[3] - numbers[1]);
		if (!(
			width > 0 &&
			width <= MAX_UPLOADED_PDF_PAGE_DIMENSION &&
			height > 0 &&
			height <= MAX_UPLOADED_PDF_PAGE_DIMENSION
		)) {
			throw fail('oversized_page', 'PDF page dimensions are outside the supported range');
		}
		return [
			Math.min(numbers[0], numbers[2]),
			Math.min(numbers[1], numbers[3]),
			Math.max(numbers[0], numbers[2]),
			Math.max(numbers[1], numbers[3])
		];
	}

	#optionalMediaBox(value: PdfValue | undefined): PdfArray | null {
		if (value === undefined) return null;
		return this.#asArray(this.#resolve(value), 'damaged_xref');
	}

	#optionalPageBox(value: PdfValue | undefined, name: 'CropBox'): PdfArray | null {
		if (value === undefined) return null;
		const resolved: PdfValue = this.#resolve(value);
		if (!isArray(resolved)) throw fail('damaged_xref', `PDF /${name} is invalid`);
		return resolved;
	}

	#pageBoxNumbers(box: PdfArray, name: 'CropBox'): readonly [number, number, number, number] {
		if (box.items.length !== 4) throw fail('damaged_xref', `PDF /${name} is invalid`);
		const numbers: number[] = [];
		for (const item of box.items) {
			const resolved: PdfValue = this.#resolve(item);
			if (typeof resolved !== 'number' || !Number.isFinite(resolved)) {
				throw fail('damaged_xref', `PDF /${name} is invalid`);
			}
			numbers.push(resolved);
		}
		return [
			Math.min(numbers[0], numbers[2]),
			Math.min(numbers[1], numbers[3]),
			Math.max(numbers[0], numbers[2]),
			Math.max(numbers[1], numbers[3])
		];
	}

	#assertDefaultUserUnit(value: PdfValue | undefined): void {
		if (value === undefined) return;
		const resolved: PdfValue = this.#resolve(value);
		if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved <= 0) {
			throw fail('damaged_xref', 'PDF /UserUnit is invalid');
		}
		if (resolved !== 1) {
			throw fail(
				'unsupported_page_geometry',
				'PDF pages with a non-default /UserUnit are not accepted'
			);
		}
	}

	#optionalRotate(value: PdfValue | undefined): number | null {
		if (value === undefined) return null;
		const resolved: PdfValue = this.#resolve(value);
		if (typeof resolved !== 'number' || !Number.isFinite(resolved)) {
			throw fail('damaged_xref', 'PDF /Rotate is invalid');
		}
		return resolved;
	}

	#resolve(value: PdfValue): PdfValue {
		if (!isRef(value)) return value;
		return this.#loadObject(value.objectNumber, value.generation);
	}

	#loadObject(objectNumber: number, generation: number): PdfValue {
		const cacheKey: string = `${objectNumber}:${generation}`;
		const cached: PdfValue | undefined = this.#objectCache.get(cacheKey);
		if (cached !== undefined) return cached;
		const entry: XrefEntry | undefined = this.#xref.get(objectNumber);
		if (entry === undefined || entry.type === 0) {
			throw fail('damaged_xref', 'PDF object reference is missing from the xref');
		}
		let loaded: PdfValue;
		if (entry.type === 1) {
			if (entry.field3 !== generation && generation !== 0 && entry.field3 !== 0) {
				throw fail('damaged_xref', 'PDF object generation does not match its xref entry');
			}
			loaded = this.#parseIndirectObjectAt(entry.field2, false).value;
		} else {
			loaded = this.#loadCompressedObject(entry.field2, entry.field3);
		}
		this.#objectCache.set(cacheKey, loaded);
		return loaded;
	}

	#loadCompressedObject(streamObjectNumber: number, index: number): PdfValue {
		const streamObject = this.#parseStreamObject(streamObjectNumber);
		if (index < 0 || index >= streamObject.length) {
			throw fail('damaged_xref', 'PDF object stream index is out of range');
		}
		return streamObject[index];
	}

	#parseStreamObject(streamObjectNumber: number): readonly PdfValue[] {
		const cached: readonly PdfValue[] | undefined = this.#objectStreams.get(streamObjectNumber);
		if (cached !== undefined) return cached;
		const entry: XrefEntry | undefined = this.#xref.get(streamObjectNumber);
		if (entry === undefined || entry.type !== 1) {
			throw fail('damaged_xref', 'PDF object stream is not an uncompressed object');
		}
		const parsed = this.#parseIndirectObjectAt(entry.field2, true);
		if (parsed.stream === null)
			throw fail('damaged_xref', 'PDF object stream is missing its stream');
		const type: PdfValue | undefined = parsed.dict.entries.get('Type');
		if (!isName(type, 'ObjStm'))
			throw fail('damaged_xref', 'PDF object stream /Type is not /ObjStm');
		const nValue: PdfValue | undefined = parsed.dict.entries.get('N');
		const firstValue: PdfValue | undefined = parsed.dict.entries.get('First');
		if (
			typeof nValue !== 'number' ||
			!Number.isSafeInteger(nValue) ||
			nValue < 1 ||
			typeof firstValue !== 'number' ||
			!Number.isSafeInteger(firstValue) ||
			firstValue < 0
		) {
			throw fail('damaged_xref', 'PDF object stream dictionary is invalid');
		}
		const decoded: Uint8Array = this.#decodeStream(parsed.dict, parsed.stream);
		if (firstValue > decoded.byteLength) {
			throw fail('damaged_xref', 'PDF object stream /First is invalid');
		}
		const parser: PdfObjectReader = new PdfObjectReader(decoded);
		parser.#tokenBudget = this.#tokenBudget;
		parser.#inflateUsed = this.#inflateUsed;
		for (let index = 0; index < nValue; index += 1) {
			parser.#skipWhitespaceAndComments();
			const objectNumber: PdfValue = parser.#parseValue(0);
			parser.#skipWhitespaceAndComments();
			const offset: PdfValue = parser.#parseValue(0);
			if (
				typeof objectNumber !== 'number' ||
				typeof offset !== 'number' ||
				!Number.isSafeInteger(objectNumber) ||
				!Number.isSafeInteger(offset) ||
				offset < 0
			) {
				throw fail('damaged_xref', 'PDF object stream header is invalid');
			}
		}
		parser.#pos = firstValue;
		const objects: PdfValue[] = [];
		for (let index = 0; index < nValue; index += 1) {
			parser.#skipWhitespaceAndComments();
			objects.push(parser.#parseValue(0));
		}
		this.#tokenBudget = parser.#tokenBudget;
		this.#inflateUsed = parser.#inflateUsed;
		this.#objectStreams.set(streamObjectNumber, objects);
		return objects;
	}

	#parseIndirectObjectAt(
		offset: number,
		withStream: boolean
	): { value: PdfValue; dict: PdfDict; stream: Uint8Array | null } {
		if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.#bytes.byteLength) {
			throw fail('damaged_xref', 'PDF object offset is out of range');
		}
		this.#pos = offset;
		this.#skipWhitespaceAndComments();
		const objectNumber: PdfValue = this.#parseValue(0);
		this.#skipWhitespaceAndComments();
		const generation: PdfValue = this.#parseValue(0);
		this.#skipWhitespaceAndComments();
		if (typeof objectNumber !== 'number' || typeof generation !== 'number') {
			throw fail('damaged_xref', 'PDF object header is invalid');
		}
		if (!this.#startsWith('obj')) throw fail('damaged_xref', 'PDF object is missing obj');
		this.#pos += 3;
		this.#skipWhitespaceAndComments();
		const value: PdfValue = this.#parseValue(0);
		this.#skipWhitespaceAndComments();
		let stream: Uint8Array | null = null;
		let dict: PdfDict =
			value !== null && typeof value === 'object' && value.kind === 'dict'
				? value
				: { kind: 'dict', entries: new Map() };
		if (withStream && this.#startsWith('stream')) {
			if (value === null || typeof value !== 'object' || value.kind !== 'dict') {
				throw fail('damaged_xref', 'PDF stream object is missing a dictionary');
			}
			dict = value;
			this.#pos += 6;
			if (this.#pos < this.#bytes.byteLength && this.#bytes[this.#pos] === 0x0d) this.#pos += 1;
			if (this.#pos < this.#bytes.byteLength && this.#bytes[this.#pos] === 0x0a) this.#pos += 1;
			else throw fail('damaged_xref', 'PDF stream keyword is not followed by a newline');
			const lengthValue: PdfValue | undefined = dict.entries.get('Length');
			let length: number;
			if (
				typeof lengthValue === 'number' &&
				Number.isSafeInteger(lengthValue) &&
				lengthValue >= 0
			) {
				length = lengthValue;
			} else if (isRef(lengthValue)) {
				const resolved: PdfValue = this.#loadObject(
					lengthValue.objectNumber,
					lengthValue.generation
				);
				if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < 0) {
					throw fail('damaged_xref', 'PDF stream /Length is invalid');
				}
				length = resolved;
			} else {
				throw fail('damaged_xref', 'PDF stream /Length is missing');
			}
			if (this.#pos + length > this.#bytes.byteLength) {
				throw fail('damaged_xref', 'PDF stream is truncated');
			}
			stream = this.#bytes.subarray(this.#pos, this.#pos + length);
			this.#pos += length;
			this.#skipWhitespaceAndComments();
			if (!this.#startsWith('endstream'))
				throw fail('damaged_xref', 'PDF stream is missing endstream');
			this.#pos += 9;
			this.#skipWhitespaceAndComments();
		}
		if (this.#startsWith('endobj')) this.#pos += 6;
		return { value, dict, stream };
	}

	#decodeStream(dict: PdfDict, data: Uint8Array): Uint8Array {
		const filter: PdfValue | undefined = dict.entries.get('Filter');
		if (filter === undefined) return this.#applyPredictor(dict, data);
		const filters: PdfValue[] =
			filter !== null && typeof filter === 'object' && filter.kind === 'array'
				? [...filter.items]
				: [filter];
		let current: Uint8Array = data;
		for (const item of filters) {
			if (!isName(item, 'FlateDecode')) {
				throw fail('damaged_xref', 'PDF stream uses an unsupported filter');
			}
			current = this.#inflate(current);
		}
		return this.#applyPredictor(dict, current);
	}

	#inflate(data: Uint8Array): Uint8Array {
		let inflated: Uint8Array;
		try {
			inflated = unzlibSync(data);
		} catch {
			try {
				inflated = inflateSync(data);
			} catch (error: unknown) {
				throw new PdfPageMetadataError('damaged_xref', 'PDF FlateDecode stream is damaged', {
					cause: error
				});
			}
		}
		this.#inflateUsed += inflated.byteLength;
		if (this.#inflateUsed > MAX_PDF_INFLATE_BYTES) {
			throw fail('inflate_bomb', 'PDF inflated streams exceed the decode budget');
		}
		return inflated;
	}

	#applyPredictor(dict: PdfDict, data: Uint8Array): Uint8Array {
		const parmsValue: PdfValue | undefined =
			dict.entries.get('DecodeParms') ?? dict.entries.get('DP');
		if (parmsValue === undefined) return data;
		const parms: PdfDict = this.#asDict(this.#resolve(parmsValue), 'damaged_xref');
		const predictorValue: PdfValue | undefined = parms.entries.get('Predictor');
		if (predictorValue === undefined || predictorValue === 1) return data;
		if (typeof predictorValue !== 'number' || predictorValue !== 12) {
			throw fail('damaged_xref', 'PDF stream predictor is unsupported');
		}
		const columnsValue: PdfValue | undefined = parms.entries.get('Columns');
		if (
			typeof columnsValue !== 'number' ||
			!Number.isSafeInteger(columnsValue) ||
			columnsValue < 1
		) {
			throw fail('damaged_xref', 'PDF stream predictor columns are invalid');
		}
		return pngUp(data, columnsValue);
	}

	#parseValue(depth: number): PdfValue {
		if (depth > MAX_PDF_NESTING) throw fail('nesting_overflow', 'PDF object nesting is too deep');
		this.#skipWhitespaceAndComments();
		this.#consumeToken();
		if (this.#pos >= this.#bytes.byteLength)
			throw fail('damaged_xref', 'PDF ended inside an object');
		const byte: number = this.#bytes[this.#pos];
		if (byte === 0x3c) {
			if (this.#pos + 1 < this.#bytes.byteLength && this.#bytes[this.#pos + 1] === 0x3c) {
				return this.#parseDict(depth + 1);
			}
			return this.#parseHexString();
		}
		if (byte === 0x5b) return this.#parseArray(depth + 1);
		if (byte === 0x28) return this.#parseLiteralString();
		if (byte === 0x2f) return this.#parseName();
		if (byte === 0x2b || byte === 0x2d || byte === 0x2e || (byte >= 0x30 && byte <= 0x39)) {
			return this.#parseNumberOrRef();
		}
		if (this.#startsWith('true')) {
			this.#pos += 4;
			return true;
		}
		if (this.#startsWith('false')) {
			this.#pos += 5;
			return false;
		}
		if (this.#startsWith('null')) {
			this.#pos += 4;
			return null;
		}
		throw fail('damaged_xref', 'PDF token is invalid');
	}

	#parseDict(depth: number): PdfDict {
		this.#pos += 2;
		const entries: Map<string, PdfValue> = new Map();
		for (;;) {
			this.#skipWhitespaceAndComments();
			if (this.#startsWith('>>')) {
				this.#pos += 2;
				return { kind: 'dict', entries };
			}
			const key: PdfValue = this.#parseValue(depth);
			if (!isNameValue(key)) throw fail('damaged_xref', 'PDF dictionary key is not a name');
			this.#skipWhitespaceAndComments();
			if (this.#startsWith('>>')) throw fail('damaged_xref', 'PDF dictionary is missing a value');
			const value: PdfValue = this.#parseValue(depth);
			entries.set(key.value, value);
		}
	}

	#parseArray(depth: number): PdfArray {
		this.#pos += 1;
		const items: PdfValue[] = [];
		for (;;) {
			this.#skipWhitespaceAndComments();
			if (this.#startsWith(']')) {
				this.#pos += 1;
				return { kind: 'array', items };
			}
			items.push(this.#parseValue(depth));
		}
	}

	#parseName(): PdfName {
		this.#pos += 1;
		const chars: number[] = [];
		while (this.#pos < this.#bytes.byteLength) {
			const byte: number = this.#bytes[this.#pos];
			if (WHITESPACE.has(byte) || DELIMITER.has(byte)) break;
			this.#pos += 1;
			if (byte === 0x23) {
				if (this.#pos + 1 >= this.#bytes.byteLength)
					throw fail('damaged_xref', 'PDF name hex escape is truncated');
				const hi: number = fromHex(this.#bytes[this.#pos]);
				const lo: number = fromHex(this.#bytes[this.#pos + 1]);
				if (hi < 0 || lo < 0) throw fail('damaged_xref', 'PDF name hex escape is invalid');
				this.#pos += 2;
				chars.push((hi << 4) | lo);
			} else {
				chars.push(byte);
			}
		}
		return { kind: 'name', value: ascii(Uint8Array.from(chars)) };
	}

	#parseNumberOrRef(): PdfValue {
		const first: number = this.#parseNumber();
		const saved: number = this.#pos;
		this.#skipWhitespaceAndComments();
		if (
			this.#pos < this.#bytes.byteLength &&
			this.#bytes[this.#pos] >= 0x30 &&
			this.#bytes[this.#pos] <= 0x39
		) {
			const second: number = this.#parseNumber();
			this.#skipWhitespaceAndComments();
			if (
				this.#startsWith('R') &&
				(this.#pos + 1 >= this.#bytes.byteLength || isTokenEnd(this.#bytes[this.#pos + 1]))
			) {
				this.#pos += 1;
				if (
					!Number.isSafeInteger(first) ||
					first < 0 ||
					!Number.isSafeInteger(second) ||
					second < 0
				) {
					throw fail('damaged_xref', 'PDF object reference is invalid');
				}
				return { kind: 'ref', objectNumber: first, generation: second };
			}
			this.#pos = saved;
		} else {
			this.#pos = saved;
		}
		return first;
	}

	#parseNumber(): number {
		const start: number = this.#pos;
		if (this.#bytes[this.#pos] === 0x2b || this.#bytes[this.#pos] === 0x2d) this.#pos += 1;
		let sawDigit: boolean = false;
		while (
			this.#pos < this.#bytes.byteLength &&
			this.#bytes[this.#pos] >= 0x30 &&
			this.#bytes[this.#pos] <= 0x39
		) {
			sawDigit = true;
			this.#pos += 1;
		}
		if (this.#pos < this.#bytes.byteLength && this.#bytes[this.#pos] === 0x2e) {
			this.#pos += 1;
			while (
				this.#pos < this.#bytes.byteLength &&
				this.#bytes[this.#pos] >= 0x30 &&
				this.#bytes[this.#pos] <= 0x39
			) {
				sawDigit = true;
				this.#pos += 1;
			}
		}
		if (!sawDigit) throw fail('damaged_xref', 'PDF number is invalid');
		const value: number = Number(ascii(this.#bytes.subarray(start, this.#pos)));
		if (!Number.isFinite(value)) throw fail('damaged_xref', 'PDF number is invalid');
		return value;
	}

	#parseLiteralString(): string {
		this.#pos += 1;
		const chars: number[] = [];
		let nesting: number = 1;
		while (this.#pos < this.#bytes.byteLength && nesting > 0) {
			const byte: number = this.#bytes[this.#pos];
			this.#pos += 1;
			if (byte === 0x5c) {
				if (this.#pos >= this.#bytes.byteLength) break;
				const next: number = this.#bytes[this.#pos];
				this.#pos += 1;
				if (next === 0x6e) chars.push(0x0a);
				else if (next === 0x72) chars.push(0x0d);
				else if (next === 0x74) chars.push(0x09);
				else if (next === 0x62) chars.push(0x08);
				else if (next === 0x66) chars.push(0x0c);
				else if (next === 0x28 || next === 0x29 || next === 0x5c) chars.push(next);
				else if (next >= 0x30 && next <= 0x37) {
					let octal: string = String.fromCharCode(next);
					for (let count = 0; count < 2 && this.#pos < this.#bytes.byteLength; count += 1) {
						const digit: number = this.#bytes[this.#pos];
						if (digit < 0x30 || digit > 0x37) break;
						octal += String.fromCharCode(digit);
						this.#pos += 1;
					}
					chars.push(Number.parseInt(octal, 8) & 0xff);
				} else if (next === 0x0d) {
					if (this.#pos < this.#bytes.byteLength && this.#bytes[this.#pos] === 0x0a) this.#pos += 1;
				} else if (next !== 0x0a) {
					chars.push(next);
				}
			} else if (byte === 0x28) {
				nesting += 1;
				chars.push(byte);
			} else if (byte === 0x29) {
				nesting -= 1;
				if (nesting > 0) chars.push(byte);
			} else {
				chars.push(byte);
			}
		}
		if (nesting !== 0) throw fail('damaged_xref', 'PDF literal string is unterminated');
		return ascii(Uint8Array.from(chars));
	}

	#parseHexString(): string {
		this.#pos += 1;
		const hex: number[] = [];
		while (this.#pos < this.#bytes.byteLength && this.#bytes[this.#pos] !== 0x3e) {
			const byte: number = this.#bytes[this.#pos];
			this.#pos += 1;
			if (WHITESPACE.has(byte)) continue;
			hex.push(byte);
		}
		if (this.#pos >= this.#bytes.byteLength || this.#bytes[this.#pos] !== 0x3e) {
			throw fail('damaged_xref', 'PDF hex string is unterminated');
		}
		this.#pos += 1;
		if (hex.length % 2 === 1) hex.push(0x30);
		const chars: number[] = [];
		for (let index = 0; index < hex.length; index += 2) {
			const hi: number = fromHex(hex[index]);
			const lo: number = fromHex(hex[index + 1]);
			if (hi < 0 || lo < 0) throw fail('damaged_xref', 'PDF hex string is invalid');
			chars.push((hi << 4) | lo);
		}
		return ascii(Uint8Array.from(chars));
	}

	#skipWhitespaceAndComments(): void {
		while (this.#pos < this.#bytes.byteLength) {
			const byte: number = this.#bytes[this.#pos];
			if (WHITESPACE.has(byte)) {
				this.#pos += 1;
				continue;
			}
			if (byte === 0x25) {
				this.#pos += 1;
				while (
					this.#pos < this.#bytes.byteLength &&
					this.#bytes[this.#pos] !== 0x0a &&
					this.#bytes[this.#pos] !== 0x0d
				) {
					this.#pos += 1;
				}
				continue;
			}
			return;
		}
	}

	#startsWith(text: string): boolean {
		if (this.#pos + text.length > this.#bytes.byteLength) return false;
		for (let index = 0; index < text.length; index += 1) {
			if (this.#bytes[this.#pos + index] !== text.charCodeAt(index)) return false;
		}
		return true;
	}

	#consumeToken(): void {
		this.#tokenBudget -= 1;
		if (this.#tokenBudget < 0) throw fail('token_budget_exceeded', 'PDF token budget exceeded');
	}

	#countNode(): void {
		this.#nodeCount += 1;
		if (this.#nodeCount > MAX_PDF_NODE_BUDGET) {
			throw fail('node_budget_exceeded', 'PDF page tree exceeds the node budget');
		}
	}

	#asDict(value: PdfValue, reason: PdfPageMetadataReason): PdfDict {
		if (value === null || typeof value !== 'object' || value.kind !== 'dict') {
			throw fail(reason, 'PDF dictionary is required');
		}
		return value;
	}

	#asArray(value: PdfValue, reason: PdfPageMetadataReason): PdfArray {
		if (value === null || typeof value !== 'object' || value.kind !== 'array') {
			throw fail(reason, 'PDF array is required');
		}
		return value;
	}
}

export function pdfFail(reason: PdfPageMetadataReason, message: string): PdfPageMetadataError {
	return new PdfPageMetadataError(reason, message);
}

function fail(reason: PdfPageMetadataReason, message: string): PdfPageMetadataError {
	return new PdfPageMetadataError(reason, message);
}

export function isRef(value: PdfValue | undefined): value is PdfRef {
	return value !== undefined && value !== null && typeof value === 'object' && value.kind === 'ref';
}

export function isNameValue(value: PdfValue | undefined): value is PdfName {
	return (
		value !== undefined && value !== null && typeof value === 'object' && value.kind === 'name'
	);
}

export function isName(value: PdfValue | undefined, expected: string): boolean {
	return isNameValue(value) && value.value === expected;
}

export function isDict(value: PdfValue | undefined): value is PdfDict {
	return (
		value !== undefined && value !== null && typeof value === 'object' && value.kind === 'dict'
	);
}

export function isArray(value: PdfValue | undefined): value is PdfArray {
	return (
		value !== undefined && value !== null && typeof value === 'object' && value.kind === 'array'
	);
}

/**
 * `/Rotate` must be a multiple of 90. A viewer is free to ignore anything
 * else, and so do we: an off-axis value is treated as an upright page rather
 * than guessing a quadrant that would silently move every overlay.
 */
export function normalizeRotation(rotate: number | null): number {
	const angle: number = (((rotate ?? 0) % 360) + 360) % 360;
	if (angle === 90 || angle === 180 || angle === 270) return angle;
	return 0;
}

function samePageBox(
	left: readonly [number, number, number, number],
	right: readonly [number, number, number, number]
): boolean {
	return left.every((value: number, index: number): boolean => value === right[index]);
}

function asDictOrEmpty(value: PdfValue): PdfDict {
	return isDict(value) ? value : { kind: 'dict', entries: new Map() };
}

function ascii(bytes: Uint8Array): string {
	let text: string = '';
	for (let index = 0; index < bytes.byteLength; index += 1) {
		text += String.fromCharCode(bytes[index]);
	}
	return text;
}

function fromHex(byte: number): number {
	if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
	if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
	if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
	return -1;
}

function isTokenEnd(byte: number): boolean {
	return WHITESPACE.has(byte) || DELIMITER.has(byte);
}

function readUnsigned(bytes: Uint8Array, offset: number, width: number): number {
	let value: number = 0;
	for (let index = 0; index < width; index += 1) {
		value = (value << 8) | bytes[offset + index];
	}
	return value >>> 0;
}

function pngUp(data: Uint8Array, columns: number): Uint8Array {
	const rowSize: number = columns + 1;
	if (rowSize <= 1 || data.byteLength % rowSize !== 0) {
		throw fail('damaged_xref', 'PDF PNG predictor rows are invalid');
	}
	const rows: number = data.byteLength / rowSize;
	const output: Uint8Array = new Uint8Array(rows * columns);
	for (let row = 0; row < rows; row += 1) {
		const filter: number = data[row * rowSize];
		if (filter !== 0 && filter !== 2) {
			throw fail('damaged_xref', 'PDF PNG predictor filter is unsupported');
		}
		for (let column = 0; column < columns; column += 1) {
			const raw: number = data[row * rowSize + 1 + column];
			const up: number = filter === 2 && row > 0 ? output[(row - 1) * columns + column] : 0;
			output[row * columns + column] = (raw + up) & 0xff;
		}
	}
	return output;
}
