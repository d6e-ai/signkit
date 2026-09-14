/**
 * A minimal, dependency-free TrueType (`glyf`-based) reader and subsetter.
 *
 * SignKit embeds the glyphs an agreement actually uses into the PDF it hands
 * to a recipient, rather than the whole typeface: a Japanese contract touches
 * a few hundred of the font's ~7,700 glyphs, so subsetting is the difference
 * between a ~100 KB artifact and a ~2.3 MB one. It also keeps the renderer
 * honest about its bound -- every glyph in the output is one the document
 * asked for.
 *
 * The output is a valid standalone sfnt suitable for a PDF `FontFile2`
 * stream: glyphs are renumbered densely, composite glyph component indices
 * are rewritten, and `loca` is always emitted in the long format so the
 * writer never has to reason about the 16-bit variant's word-offset rule.
 *
 * Deliberately not implemented: shaping (`GSUB`/`GPOS`), variable-font
 * instancing (`gvar`), and CFF outlines. The bundled font is a static,
 * layout-table-free `glyf` font precisely so none of those are needed --
 * see scripts/build-pdf-font.mjs.
 */

const SFNT_TRUETYPE_VERSION: number = 0x00010000;
/** Composite glyph flags, per the OpenType `glyf` table specification. */
const ARG_1_AND_2_ARE_WORDS: number = 0x0001;
const WE_HAVE_A_SCALE: number = 0x0008;
const MORE_COMPONENTS: number = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE: number = 0x0040;
const WE_HAVE_A_TWO_BY_TWO: number = 0x0080;
/** Bounds a malformed or hostile composite glyph graph. */
const MAX_COMPOSITE_DEPTH: number = 8;

export class TrueTypeFontError extends Error {
	readonly code = 'TRUETYPE_FONT_ERROR';

	constructor(message: string) {
		super(message);
		this.name = 'TrueTypeFontError';
	}
}

interface TableRecord {
	offset: number;
	length: number;
}

export interface TrueTypeMetrics {
	unitsPerEm: number;
	ascender: number;
	descender: number;
	capHeight: number;
	xMin: number;
	yMin: number;
	xMax: number;
	yMax: number;
	italicAngle: number;
	stemV: number;
}

export class TrueTypeFont {
	readonly #bytes: Uint8Array;
	readonly #view: DataView;
	readonly #tables: ReadonlyMap<string, TableRecord>;
	readonly #locaOffsets: Uint32Array;
	readonly #glyfRecord: TableRecord;
	readonly #numberOfHMetrics: number;
	readonly #hmtxRecord: TableRecord;
	readonly #cmap: ReadonlyMap<number, number>;

	readonly numGlyphs: number;
	readonly metrics: TrueTypeMetrics;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (bytes.byteLength < 12 || this.#view.getUint32(0) !== SFNT_TRUETYPE_VERSION) {
			throw new TrueTypeFontError('Not a glyf-based TrueType font');
		}
		this.#tables = readTableDirectory(this.#bytes, this.#view);

		const head: TableRecord = this.#require('head');
		const hhea: TableRecord = this.#require('hhea');
		const maxp: TableRecord = this.#require('maxp');
		const os2: TableRecord | undefined = this.#tables.get('OS/2');
		this.#glyfRecord = this.#require('glyf');
		this.#hmtxRecord = this.#require('hmtx');

		this.numGlyphs = this.#view.getUint16(maxp.offset + 4);
		if (this.numGlyphs === 0) throw new TrueTypeFontError('Font declares no glyphs');
		this.#numberOfHMetrics = this.#view.getUint16(hhea.offset + 34);
		if (this.#numberOfHMetrics === 0) throw new TrueTypeFontError('Font declares no h-metrics');

		const unitsPerEm: number = this.#view.getUint16(head.offset + 18);
		if (unitsPerEm === 0) throw new TrueTypeFontError('Font declares unitsPerEm of zero');
		this.metrics = {
			unitsPerEm,
			ascender: this.#view.getInt16(hhea.offset + 4),
			descender: this.#view.getInt16(hhea.offset + 6),
			capHeight:
				os2 !== undefined && this.#view.getUint16(os2.offset) >= 2 && os2.length >= 90
					? this.#view.getInt16(os2.offset + 88)
					: Math.round(this.#view.getInt16(hhea.offset + 4) * 0.7),
			xMin: this.#view.getInt16(head.offset + 36),
			yMin: this.#view.getInt16(head.offset + 38),
			xMax: this.#view.getInt16(head.offset + 40),
			yMax: this.#view.getInt16(head.offset + 42),
			italicAngle: 0,
			// No `post` italic angle or `OS/2` panose weight is consulted: the
			// bundled face is upright and regular, and a PDF viewer only uses
			// StemV as a synthetic-font hint we never want it to act on.
			stemV: 80
		};

		const indexToLocFormat: number = this.#view.getInt16(head.offset + 50);
		this.#locaOffsets = readLoca(
			this.#view,
			this.#require('loca'),
			this.numGlyphs,
			indexToLocFormat
		);
		this.#cmap = readCmap(this.#view, this.#require('cmap'));
	}

	/** Glyph for one Unicode code point, or 0 (`.notdef`) when unmapped. */
	glyphIdForCodePoint(codePoint: number): number {
		const glyphId: number | undefined = this.#cmap.get(codePoint);
		if (glyphId === undefined || glyphId >= this.numGlyphs) return 0;
		return glyphId;
	}

	/** Horizontal advance in font design units. */
	advanceWidth(glyphId: number): number {
		const index: number = Math.min(glyphId, this.#numberOfHMetrics - 1);
		if (index < 0) return 0;
		const offset: number = this.#hmtxRecord.offset + index * 4;
		if (offset + 2 > this.#hmtxRecord.offset + this.#hmtxRecord.length) return 0;
		return this.#view.getUint16(offset);
	}

	#leftSideBearing(glyphId: number): number {
		if (glyphId < this.#numberOfHMetrics) {
			return this.#view.getInt16(this.#hmtxRecord.offset + glyphId * 4 + 2);
		}
		const offset: number =
			this.#hmtxRecord.offset + this.#numberOfHMetrics * 4 + (glyphId - this.#numberOfHMetrics) * 2;
		if (offset + 2 > this.#hmtxRecord.offset + this.#hmtxRecord.length) return 0;
		return this.#view.getInt16(offset);
	}

	#glyphData(glyphId: number): Uint8Array {
		const start: number = this.#locaOffsets[glyphId];
		const end: number = this.#locaOffsets[glyphId + 1];
		if (end <= start) return new Uint8Array(0);
		if (end > this.#glyfRecord.length)
			throw new TrueTypeFontError('Glyph runs past the glyf table');
		return this.#bytes.subarray(this.#glyfRecord.offset + start, this.#glyfRecord.offset + end);
	}

	#require(tag: string): TableRecord {
		const record: TableRecord | undefined = this.#tables.get(tag);
		if (record === undefined) throw new TrueTypeFontError(`Font is missing the ${tag} table`);
		return record;
	}

	/**
	 * Expands `glyphIds` over composite components and returns the full set the
	 * subset must carry. `.notdef` is always included so a PDF viewer has
	 * something to draw for an unmapped code.
	 */
	closeOverComposites(glyphIds: Iterable<number>): Set<number> {
		const closed: Set<number> = new Set<number>([0]);
		const pending: number[] = [];
		for (const glyphId of glyphIds) {
			if (glyphId < 0 || glyphId >= this.numGlyphs) continue;
			if (!closed.has(glyphId)) closed.add(glyphId);
			pending.push(glyphId);
		}
		let depth: number = 0;
		while (pending.length > 0 && depth < MAX_COMPOSITE_DEPTH) {
			const batch: number[] = pending.splice(0, pending.length);
			for (const glyphId of batch) {
				for (const component of this.#componentGlyphs(glyphId)) {
					if (closed.has(component)) continue;
					closed.add(component);
					pending.push(component);
				}
			}
			depth += 1;
		}
		if (pending.length > 0) throw new TrueTypeFontError('Composite glyph nesting is too deep');
		return closed;
	}

	#componentGlyphs(glyphId: number): number[] {
		const data: Uint8Array = this.#glyphData(glyphId);
		if (data.byteLength < 10) return [];
		const view: DataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
		if (view.getInt16(0) >= 0) return [];
		const components: number[] = [];
		let cursor: number = 10;
		for (;;) {
			if (cursor + 4 > data.byteLength) break;
			const flags: number = view.getUint16(cursor);
			components.push(view.getUint16(cursor + 2));
			cursor += 4;
			cursor += (flags & ARG_1_AND_2_ARE_WORDS) !== 0 ? 4 : 2;
			if ((flags & WE_HAVE_A_SCALE) !== 0) cursor += 2;
			else if ((flags & WE_HAVE_AN_X_AND_Y_SCALE) !== 0) cursor += 4;
			else if ((flags & WE_HAVE_A_TWO_BY_TWO) !== 0) cursor += 8;
			if ((flags & MORE_COMPONENTS) === 0) break;
		}
		return components;
	}

	/**
	 * Builds a standalone sfnt containing only `glyphIds` (plus composite
	 * components and `.notdef`), renumbered densely in ascending original
	 * order. The returned mapping is old glyph id -> new glyph id; callers use
	 * it to write the PDF content stream and the CID-to-GID identity mapping.
	 */
	subset(glyphIds: Iterable<number>): {
		font: Uint8Array;
		glyphIdMap: ReadonlyMap<number, number>;
	} {
		const closed: Set<number> = this.closeOverComposites(glyphIds);
		const ordered: number[] = [...closed].sort(
			(left: number, right: number): number => left - right
		);
		const glyphIdMap: Map<number, number> = new Map<number, number>();
		ordered.forEach((oldGlyphId: number, newGlyphId: number): void => {
			glyphIdMap.set(oldGlyphId, newGlyphId);
		});

		const glyphs: Uint8Array[] = ordered.map((oldGlyphId: number): Uint8Array =>
			remapCompositeComponents(this.#glyphData(oldGlyphId), glyphIdMap)
		);
		const glyfLength: number = glyphs.reduce(
			(total: number, glyph: Uint8Array): number => total + align4(glyph.byteLength),
			0
		);
		const glyf: Uint8Array = new Uint8Array(glyfLength);
		const loca: Uint8Array = new Uint8Array((ordered.length + 1) * 4);
		const locaView: DataView = new DataView(loca.buffer);
		let glyphOffset: number = 0;
		glyphs.forEach((glyph: Uint8Array, index: number): void => {
			locaView.setUint32(index * 4, glyphOffset);
			glyf.set(glyph, glyphOffset);
			glyphOffset += align4(glyph.byteLength);
		});
		locaView.setUint32(ordered.length * 4, glyphOffset);

		const hmtx: Uint8Array = new Uint8Array(ordered.length * 4);
		const hmtxView: DataView = new DataView(hmtx.buffer);
		ordered.forEach((oldGlyphId: number, index: number): void => {
			hmtxView.setUint16(index * 4, this.advanceWidth(oldGlyphId));
			hmtxView.setInt16(index * 4 + 2, this.#leftSideBearing(oldGlyphId));
		});

		const head: Uint8Array = this.#copyTable('head');
		new DataView(head.buffer, head.byteOffset, head.byteLength).setInt16(50, 1);
		// checkSumAdjustment is a whole-file checksum; leaving a stale value is
		// worse than declaring none, and PDF viewers do not verify it.
		new DataView(head.buffer, head.byteOffset, head.byteLength).setUint32(8, 0);
		const hhea: Uint8Array = this.#copyTable('hhea');
		new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).setUint16(34, ordered.length);
		const maxp: Uint8Array = this.#copyTable('maxp');
		new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).setUint16(4, ordered.length);

		const tables: { tag: string; data: Uint8Array }[] = [
			{ tag: 'cmap', data: buildIdentityCmap(this.#cmap, glyphIdMap) },
			{ tag: 'glyf', data: glyf },
			{ tag: 'head', data: head },
			{ tag: 'hhea', data: hhea },
			{ tag: 'hmtx', data: hmtx },
			{ tag: 'loca', data: loca },
			{ tag: 'maxp', data: maxp }
		];
		const os2: TableRecord | undefined = this.#tables.get('OS/2');
		if (os2 !== undefined) tables.push({ tag: 'OS/2', data: this.#copyTable('OS/2') });
		const postTable: Uint8Array = new Uint8Array(32);
		new DataView(postTable.buffer).setUint32(0, 0x00030000);
		tables.push({ tag: 'post', data: postTable });
		tables.sort((left, right): number => (left.tag < right.tag ? -1 : 1));

		return { font: assembleSfnt(tables), glyphIdMap };
	}

	#copyTable(tag: string): Uint8Array {
		const record: TableRecord = this.#require(tag);
		return Uint8Array.from(this.#bytes.subarray(record.offset, record.offset + record.length));
	}
}

function readTableDirectory(bytes: Uint8Array, view: DataView): Map<string, TableRecord> {
	const tableCount: number = view.getUint16(4);
	const tables: Map<string, TableRecord> = new Map<string, TableRecord>();
	for (let index: number = 0; index < tableCount; index += 1) {
		const record: number = 12 + index * 16;
		if (record + 16 > bytes.byteLength) throw new TrueTypeFontError('Truncated table directory');
		const tag: string = String.fromCharCode(
			bytes[record],
			bytes[record + 1],
			bytes[record + 2],
			bytes[record + 3]
		);
		const offset: number = view.getUint32(record + 8);
		const length: number = view.getUint32(record + 12);
		if (offset + length > bytes.byteLength) {
			throw new TrueTypeFontError(`Table ${tag} runs past the end of the font`);
		}
		tables.set(tag, { offset, length });
	}
	return tables;
}

function readLoca(
	view: DataView,
	loca: TableRecord,
	numGlyphs: number,
	indexToLocFormat: number
): Uint32Array {
	const offsets: Uint32Array = new Uint32Array(numGlyphs + 1);
	if (indexToLocFormat === 0) {
		if (loca.length < (numGlyphs + 1) * 2) throw new TrueTypeFontError('Truncated short loca');
		for (let index: number = 0; index <= numGlyphs; index += 1) {
			offsets[index] = view.getUint16(loca.offset + index * 2) * 2;
		}
		return offsets;
	}
	if (loca.length < (numGlyphs + 1) * 4) throw new TrueTypeFontError('Truncated long loca');
	for (let index: number = 0; index <= numGlyphs; index += 1) {
		offsets[index] = view.getUint32(loca.offset + index * 4);
	}
	return offsets;
}

function readCmap(view: DataView, cmap: TableRecord): Map<number, number> {
	const subtableCount: number = view.getUint16(cmap.offset + 2);
	let chosen: { offset: number; format: number } | null = null;
	for (let index: number = 0; index < subtableCount; index += 1) {
		const record: number = cmap.offset + 4 + index * 8;
		const platformId: number = view.getUint16(record);
		const encodingId: number = view.getUint16(record + 2);
		const subtableOffset: number = cmap.offset + view.getUint32(record + 4);
		const format: number = view.getUint16(subtableOffset);
		const unicode: boolean =
			platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
		if (!unicode) continue;
		if (format !== 4 && format !== 12) continue;
		// Format 12 covers the full Unicode range, so it always wins.
		if (chosen === null || format === 12) chosen = { offset: subtableOffset, format };
	}
	if (chosen === null) throw new TrueTypeFontError('Font has no usable Unicode cmap subtable');
	return chosen.format === 12
		? readCmapFormat12(view, chosen.offset)
		: readCmapFormat4(view, chosen.offset);
}

function readCmapFormat4(view: DataView, offset: number): Map<number, number> {
	const mapping: Map<number, number> = new Map<number, number>();
	const segCountX2: number = view.getUint16(offset + 6);
	const segCount: number = segCountX2 / 2;
	const endOffset: number = offset + 14;
	const startOffset: number = endOffset + segCountX2 + 2;
	const deltaOffset: number = startOffset + segCountX2;
	const rangeOffset: number = deltaOffset + segCountX2;
	for (let segment: number = 0; segment < segCount; segment += 1) {
		const end: number = view.getUint16(endOffset + segment * 2);
		const start: number = view.getUint16(startOffset + segment * 2);
		if (start > end) continue;
		const idDelta: number = view.getInt16(deltaOffset + segment * 2);
		const idRangeOffset: number = view.getUint16(rangeOffset + segment * 2);
		for (let codePoint: number = start; codePoint <= end && codePoint !== 0xffff; codePoint += 1) {
			let glyphId: number;
			if (idRangeOffset === 0) {
				glyphId = (codePoint + idDelta) & 0xffff;
			} else {
				const glyphOffset: number =
					rangeOffset + segment * 2 + idRangeOffset + (codePoint - start) * 2;
				glyphId = view.getUint16(glyphOffset);
				if (glyphId !== 0) glyphId = (glyphId + idDelta) & 0xffff;
			}
			if (glyphId !== 0) mapping.set(codePoint, glyphId);
		}
	}
	return mapping;
}

function readCmapFormat12(view: DataView, offset: number): Map<number, number> {
	const mapping: Map<number, number> = new Map<number, number>();
	const groupCount: number = view.getUint32(offset + 12);
	for (let group: number = 0; group < groupCount; group += 1) {
		const record: number = offset + 16 + group * 12;
		const start: number = view.getUint32(record);
		const end: number = view.getUint32(record + 4);
		const startGlyph: number = view.getUint32(record + 8);
		for (let codePoint: number = start; codePoint <= end; codePoint += 1) {
			mapping.set(codePoint, startGlyph + (codePoint - start));
		}
	}
	return mapping;
}

/**
 * Emits a format-12 `cmap` restricted to the retained glyphs. A PDF
 * CIDFontType2 with an identity CID-to-GID map never consults this table, but
 * keeping a truthful one means the subset is still a usable standalone font
 * and tools that do look (validators, extractors) see a consistent picture.
 */
function buildIdentityCmap(
	source: ReadonlyMap<number, number>,
	glyphIdMap: ReadonlyMap<number, number>
): Uint8Array {
	const entries: [number, number][] = [];
	for (const [codePoint, oldGlyphId] of source) {
		const newGlyphId: number | undefined = glyphIdMap.get(oldGlyphId);
		if (newGlyphId !== undefined) entries.push([codePoint, newGlyphId]);
	}
	entries.sort((left, right): number => left[0] - right[0]);

	const groups: { start: number; end: number; glyph: number }[] = [];
	for (const [codePoint, glyphId] of entries) {
		const last = groups[groups.length - 1];
		if (
			last !== undefined &&
			codePoint === last.end + 1 &&
			glyphId === last.glyph + (last.end + 1 - last.start)
		) {
			last.end = codePoint;
			continue;
		}
		groups.push({ start: codePoint, end: codePoint, glyph: glyphId });
	}

	const subtableLength: number = 16 + groups.length * 12;
	const bytes: Uint8Array = new Uint8Array(12 + subtableLength);
	const view: DataView = new DataView(bytes.buffer);
	view.setUint16(0, 0);
	view.setUint16(2, 1);
	view.setUint16(4, 3);
	view.setUint16(6, 10);
	view.setUint32(8, 12);
	view.setUint16(12, 12);
	view.setUint32(12 + 4, subtableLength);
	view.setUint32(12 + 8, 0);
	view.setUint32(12 + 12, groups.length);
	groups.forEach((group, index: number): void => {
		const record: number = 12 + 16 + index * 12;
		view.setUint32(record, group.start);
		view.setUint32(record + 4, group.end);
		view.setUint32(record + 8, group.glyph);
	});
	return bytes;
}

function remapCompositeComponents(
	glyph: Uint8Array,
	glyphIdMap: ReadonlyMap<number, number>
): Uint8Array {
	if (glyph.byteLength < 10) return glyph;
	const copy: Uint8Array = Uint8Array.from(glyph);
	const view: DataView = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
	if (view.getInt16(0) >= 0) return copy;
	let cursor: number = 10;
	for (;;) {
		if (cursor + 4 > copy.byteLength) break;
		const flags: number = view.getUint16(cursor);
		const component: number = view.getUint16(cursor + 2);
		const remapped: number | undefined = glyphIdMap.get(component);
		// A component outside the subset cannot happen after closure; mapping it
		// to `.notdef` keeps the table structurally valid if it ever does.
		view.setUint16(cursor + 2, remapped ?? 0);
		cursor += 4;
		cursor += (flags & ARG_1_AND_2_ARE_WORDS) !== 0 ? 4 : 2;
		if ((flags & WE_HAVE_A_SCALE) !== 0) cursor += 2;
		else if ((flags & WE_HAVE_AN_X_AND_Y_SCALE) !== 0) cursor += 4;
		else if ((flags & WE_HAVE_A_TWO_BY_TWO) !== 0) cursor += 8;
		if ((flags & MORE_COMPONENTS) === 0) break;
	}
	return copy;
}

function assembleSfnt(tables: readonly { tag: string; data: Uint8Array }[]): Uint8Array {
	const directoryLength: number = 12 + tables.length * 16;
	let total: number = directoryLength;
	const offsets: number[] = [];
	for (const table of tables) {
		offsets.push(total);
		total += align4(table.data.byteLength);
	}
	const bytes: Uint8Array = new Uint8Array(total);
	const view: DataView = new DataView(bytes.buffer);
	view.setUint32(0, SFNT_TRUETYPE_VERSION);
	view.setUint16(4, tables.length);
	const entrySelector: number = Math.floor(Math.log2(tables.length));
	view.setUint16(6, 16 * 2 ** entrySelector);
	view.setUint16(8, entrySelector);
	view.setUint16(10, tables.length * 16 - 16 * 2 ** entrySelector);
	tables.forEach((table, index: number): void => {
		const record: number = 12 + index * 16;
		for (let position: number = 0; position < 4; position += 1) {
			bytes[record + position] = table.tag.charCodeAt(position);
		}
		view.setUint32(record + 4, tableChecksum(table.data));
		view.setUint32(record + 8, offsets[index]);
		view.setUint32(record + 12, table.data.byteLength);
		bytes.set(table.data, offsets[index]);
	});
	return bytes;
}

function tableChecksum(data: Uint8Array): number {
	let sum: number = 0;
	for (let offset: number = 0; offset < data.byteLength; offset += 4) {
		const word: number =
			((data[offset] ?? 0) << 24) |
			((data[offset + 1] ?? 0) << 16) |
			((data[offset + 2] ?? 0) << 8) |
			(data[offset + 3] ?? 0);
		sum = (sum + word) >>> 0;
	}
	return sum;
}

function align4(value: number): number {
	return (value + 3) & ~3;
}
