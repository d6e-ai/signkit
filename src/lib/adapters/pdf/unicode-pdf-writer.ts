import { zlibSync } from 'fflate';
import type { TrueTypeFont } from './truetype-font';

/**
 * A deterministic PDF 1.7 writer with one embedded, subsetted TrueType font
 * addressed through an Identity-H CID mapping.
 *
 * This exists because the older {@link
 * import('./deterministic-pdf-writer').renderDeterministicTextPdf} writer
 * draws with the non-embedded base-14 Courier face, which has no CJK glyphs
 * at all and substitutes `?` for every one -- acceptable for an internal
 * evidence dump, never acceptable for the document a Japanese signer is being
 * asked to agree to. Here every glyph the document uses is carried in the
 * file, so the rendering is identical on any viewer and needs no font from
 * the reader's machine or from the network.
 *
 * Output is a pure function of its input: no timestamps, no document ID, no
 * wall-clock metadata. Identical pages therefore hash identically, which is
 * what lets the sent artifact be content-addressed and integrity-pinned.
 *
 * The resource dictionary is built per page from the operations it contains,
 * so adding an `/XObject` entry later (an embedded logo, a rasterized seal)
 * is a local change here rather than a redesign.
 */

export const PDF_POINTS_PER_INCH: number = 72;
/** ISO A4 in points, the default for Japanese and most international agreements. */
export const A4_WIDTH_POINTS: number = 595.28;
export const A4_HEIGHT_POINTS: number = 841.89;

export interface PdfColor {
	red: number;
	green: number;
	blue: number;
}

export type PdfOperation =
	| {
			kind: 'text';
			/** Left edge of the first glyph, in points from the page's left edge. */
			x: number;
			/** Text baseline, in points measured downward from the page's top edge. */
			baselineFromTop: number;
			size: number;
			glyphIds: readonly number[];
			color: PdfColor;
			/**
			 * Synthesized emphasis. The bundled family ships a single regular
			 * face -- a second weight would roughly double an already large
			 * bundled artifact -- so bold is drawn as fill-plus-stroke and
			 * italic as a text-matrix skew.
			 */
			bold: boolean;
			italic: boolean;
	  }
	| {
			kind: 'rectangle';
			x: number;
			/** Top edge, in points measured downward from the page's top edge. */
			yFromTop: number;
			width: number;
			height: number;
			fill: PdfColor | null;
			stroke: PdfColor | null;
			lineWidth: number;
	  };

export interface PdfPage {
	width: number;
	height: number;
	operations: readonly PdfOperation[];
}

export interface PdfFontProgram {
	/** The subsetted sfnt bytes to embed as `FontFile2`. */
	bytes: Uint8Array;
	/** New glyph id -> advance width in 1/1000 em units. */
	widths: ReadonlyMap<number, number>;
	/** New glyph id -> the code points it renders, for `ToUnicode`. */
	toUnicode: ReadonlyMap<number, readonly number[]>;
	/** PostScript name for the embedded subset, without the `ABCDEF+` tag. */
	baseFontName: string;
	metrics: {
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
	};
}

/**
 * Builds the embeddable font program for exactly the glyphs in `glyphIds`.
 * `toUnicodeByGlyph` is supplied by the caller because the mapping from a
 * glyph back to text is a property of how the text was shaped, not of the
 * font file.
 */
export function buildFontProgram(
	font: TrueTypeFont,
	glyphIds: Iterable<number>,
	toUnicodeByGlyph: ReadonlyMap<number, readonly number[]>,
	baseFontName: string
): { program: PdfFontProgram; glyphIdMap: ReadonlyMap<number, number> } {
	const { font: bytes, glyphIdMap } = font.subset(glyphIds);
	const widths: Map<number, number> = new Map<number, number>();
	const toUnicode: Map<number, readonly number[]> = new Map<number, readonly number[]>();
	for (const [oldGlyphId, newGlyphId] of glyphIdMap) {
		widths.set(
			newGlyphId,
			Math.round((font.advanceWidth(oldGlyphId) * 1000) / font.metrics.unitsPerEm)
		);
		const codePoints: readonly number[] | undefined = toUnicodeByGlyph.get(oldGlyphId);
		if (codePoints !== undefined && codePoints.length > 0) toUnicode.set(newGlyphId, codePoints);
	}
	return {
		program: { bytes, widths, toUnicode, baseFontName, metrics: font.metrics },
		glyphIdMap
	};
}

interface PdfObject {
	/** Dictionary or other object body, already serialized. */
	body: string;
	/** Optional raw stream payload appended after the dictionary. */
	stream?: Uint8Array;
}

export function renderUnicodePdf(pages: readonly PdfPage[], program: PdfFontProgram): Uint8Array {
	if (pages.length === 0) throw new Error('A PDF needs at least one page');
	const objects: PdfObject[] = [];
	const reserve = (): number => {
		objects.push({ body: '' });
		return objects.length;
	};
	const set = (id: number, object: PdfObject): void => {
		objects[id - 1] = object;
	};

	const catalogId: number = reserve();
	const pagesId: number = reserve();
	const fontId: number = reserve();
	const descendantFontId: number = reserve();
	const descriptorId: number = reserve();
	const fontFileId: number = reserve();
	const toUnicodeId: number = reserve();

	const pageIds: number[] = [];
	const contentIds: number[] = [];
	for (let index: number = 0; index < pages.length; index += 1) {
		pageIds.push(reserve());
		contentIds.push(reserve());
	}

	set(catalogId, { body: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` });
	set(pagesId, {
		body: `<< /Type /Pages /Kids [${pageIds.map((id: number): string => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
	});

	const subsetTag: string = subsetTagFor(program.bytes);
	const fullName: string = `${subsetTag}+${program.baseFontName}`;
	set(fontId, {
		body: `<< /Type /Font /Subtype /Type0 /BaseFont /${fullName} /Encoding /Identity-H /DescendantFonts [${descendantFontId} 0 R] /ToUnicode ${toUnicodeId} 0 R >>`
	});
	set(descendantFontId, {
		body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${fullName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptorId} 0 R /DW 1000 /W ${widthArray(program.widths)} /CIDToGIDMap /Identity >>`
	});
	const scale = (value: number): number => Math.round((value * 1000) / program.metrics.unitsPerEm);
	set(descriptorId, {
		body:
			`<< /Type /FontDescriptor /FontName /${fullName} /Flags 4 ` +
			`/FontBBox [${scale(program.metrics.xMin)} ${scale(program.metrics.yMin)} ${scale(program.metrics.xMax)} ${scale(program.metrics.yMax)}] ` +
			`/ItalicAngle ${program.metrics.italicAngle} /Ascent ${scale(program.metrics.ascender)} ` +
			`/Descent ${scale(program.metrics.descender)} /CapHeight ${scale(program.metrics.capHeight)} ` +
			`/StemV ${program.metrics.stemV} /FontFile2 ${fontFileId} 0 R >>`
	});
	const compressedFont: Uint8Array = zlibSync(program.bytes, { level: 9 });
	set(fontFileId, {
		body: `<< /Length ${compressedFont.byteLength} /Length1 ${program.bytes.byteLength} /Filter /FlateDecode >>`,
		stream: compressedFont
	});
	const toUnicodeStream: Uint8Array = zlibSync(buildToUnicodeCMap(program.toUnicode), { level: 9 });
	set(toUnicodeId, {
		body: `<< /Length ${toUnicodeStream.byteLength} /Filter /FlateDecode >>`,
		stream: toUnicodeStream
	});

	pages.forEach((page: PdfPage, index: number): void => {
		set(pageIds[index], {
			body:
				`<< /Type /Page /Parent ${pagesId} 0 R ` +
				`/Resources << /Font << /F1 ${fontId} 0 R >> >> ` +
				`/MediaBox [0 0 ${formatNumber(page.width)} ${formatNumber(page.height)}] ` +
				`/Contents ${contentIds[index]} 0 R >>`
		});
		const content: Uint8Array = zlibSync(latin1Bytes(buildContentStream(page)), { level: 9 });
		set(contentIds[index], {
			body: `<< /Length ${content.byteLength} /Filter /FlateDecode >>`,
			stream: content
		});
	});

	return assemble(objects);
}

function buildContentStream(page: PdfPage): string {
	const parts: string[] = [];
	for (const operation of page.operations) {
		if (operation.kind === 'rectangle') {
			const y: number = page.height - operation.yFromTop - operation.height;
			parts.push('q');
			if (operation.fill !== null) parts.push(`${colorOperands(operation.fill)} rg`);
			if (operation.stroke !== null) {
				parts.push(`${colorOperands(operation.stroke)} RG`);
				parts.push(`${formatNumber(operation.lineWidth)} w`);
			}
			parts.push(
				`${formatNumber(operation.x)} ${formatNumber(y)} ${formatNumber(operation.width)} ${formatNumber(operation.height)} re`
			);
			if (operation.fill !== null && operation.stroke !== null) parts.push('B');
			else if (operation.fill !== null) parts.push('f');
			else if (operation.stroke !== null) parts.push('S');
			else parts.push('n');
			parts.push('Q');
			continue;
		}
		if (operation.glyphIds.length === 0) continue;
		const baseline: number = page.height - operation.baselineFromTop;
		const skew: number = operation.italic ? 0.2 : 0;
		parts.push('BT');
		parts.push(`${colorOperands(operation.color)} rg`);
		if (operation.bold) {
			parts.push(`${colorOperands(operation.color)} RG`);
			parts.push(`${formatNumber(operation.size * 0.03)} w`);
		}
		parts.push(`${operation.bold ? 2 : 0} Tr`);
		parts.push(`/F1 ${formatNumber(operation.size)} Tf`);
		parts.push(
			`1 0 ${formatNumber(skew)} 1 ${formatNumber(operation.x)} ${formatNumber(baseline)} Tm`
		);
		parts.push(`<${hexGlyphs(operation.glyphIds)}> Tj`);
		parts.push('ET');
	}
	return parts.join('\n');
}

function hexGlyphs(glyphIds: readonly number[]): string {
	let hex: string = '';
	for (const glyphId of glyphIds) hex += (glyphId & 0xffff).toString(16).padStart(4, '0');
	return hex;
}

function colorOperands(color: PdfColor): string {
	return `${formatNumber(color.red)} ${formatNumber(color.green)} ${formatNumber(color.blue)}`;
}

function widthArray(widths: ReadonlyMap<number, number>): string {
	const glyphIds: number[] = [...widths.keys()].sort((left, right): number => left - right);
	const runs: string[] = [];
	let index: number = 0;
	while (index < glyphIds.length) {
		const start: number = glyphIds[index];
		const values: number[] = [widths.get(start) ?? 1000];
		let next: number = index + 1;
		while (next < glyphIds.length && glyphIds[next] === glyphIds[next - 1] + 1) {
			values.push(widths.get(glyphIds[next]) ?? 1000);
			next += 1;
		}
		runs.push(`${start} [${values.join(' ')}]`);
		index = next;
	}
	return `[${runs.join(' ')}]`;
}

function buildToUnicodeCMap(toUnicode: ReadonlyMap<number, readonly number[]>): Uint8Array {
	const entries: [number, readonly number[]][] = [...toUnicode.entries()].sort(
		(left, right): number => left[0] - right[0]
	);
	const lines: string[] = [
		'/CIDInit /ProcSet findresource begin',
		'12 dict begin',
		'begincmap',
		'/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
		'/CMapName /Adobe-Identity-UCS def',
		'/CMapType 2 def',
		'1 begincodespacerange',
		'<0000> <FFFF>',
		'endcodespacerange'
	];
	// PDF caps a single bfchar block at 100 entries.
	for (let offset: number = 0; offset < entries.length; offset += 100) {
		const chunk: [number, readonly number[]][] = entries.slice(offset, offset + 100);
		lines.push(`${chunk.length} beginbfchar`);
		for (const [glyphId, codePoints] of chunk) {
			lines.push(`<${glyphId.toString(16).padStart(4, '0')}> <${utf16BigEndianHex(codePoints)}>`);
		}
		lines.push('endbfchar');
	}
	lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
	return latin1Bytes(lines.join('\n'));
}

function utf16BigEndianHex(codePoints: readonly number[]): string {
	let hex: string = '';
	for (const codePoint of codePoints) {
		for (const unit of String.fromCodePoint(codePoint)) {
			for (let index: number = 0; index < unit.length; index += 1) {
				hex += unit.charCodeAt(index).toString(16).padStart(4, '0');
			}
		}
	}
	return hex.toUpperCase();
}

/**
 * The six-letter subset tag PDF requires for an embedded subset. Derived from
 * the subset bytes so it stays deterministic and distinguishes two different
 * subsets of the same typeface, which is exactly what the tag is for.
 */
function subsetTagFor(bytes: Uint8Array): string {
	let hash: number = 0x811c9dc5;
	for (let index: number = 0; index < bytes.byteLength; index += 1) {
		hash ^= bytes[index];
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	let tag: string = '';
	for (let position: number = 0; position < 6; position += 1) {
		tag += String.fromCharCode(65 + (hash % 26));
		hash = Math.floor(hash / 26);
	}
	return tag;
}

function assemble(objects: readonly PdfObject[]): Uint8Array {
	const chunks: Uint8Array[] = [];
	let cursor: number = 0;
	const push = (bytes: Uint8Array): void => {
		chunks.push(bytes);
		cursor += bytes.byteLength;
	};

	push(latin1Bytes('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'));
	const offsets: number[] = [];
	objects.forEach((object: PdfObject, index: number): void => {
		offsets.push(cursor);
		push(latin1Bytes(`${index + 1} 0 obj\n${object.body}\n`));
		if (object.stream !== undefined) {
			push(latin1Bytes('stream\n'));
			push(object.stream);
			push(latin1Bytes('\nendstream\n'));
		}
		push(latin1Bytes('endobj\n'));
	});

	const xrefOffset: number = cursor;
	const xrefLines: string[] = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
	for (const offset of offsets) xrefLines.push(`${offset.toString().padStart(10, '0')} 00000 n `);
	push(latin1Bytes(`${xrefLines.join('\n')}\n`));
	push(
		latin1Bytes(
			`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
		)
	);

	const total: number = chunks.reduce(
		(sum: number, chunk: Uint8Array): number => sum + chunk.byteLength,
		0
	);
	const bytes: Uint8Array = new Uint8Array(total);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * PDF syntax outside streams is byte-oriented, not UTF-8: every character the
 * writer emits is already ASCII or an explicitly chosen high byte in the
 * binary comment, so one character must map to exactly one byte.
 */
function latin1Bytes(value: string): Uint8Array {
	const bytes: Uint8Array = new Uint8Array(value.length);
	for (let index: number = 0; index < value.length; index += 1) {
		bytes[index] = value.charCodeAt(index) & 0xff;
	}
	return bytes;
}

export function formatNumber(value: number): string {
	if (!Number.isFinite(value)) throw new Error('PDF numbers must be finite');
	const rounded: number = Math.round(value * 1000) / 1000;
	return Object.is(rounded, -0) ? '0' : String(rounded);
}
