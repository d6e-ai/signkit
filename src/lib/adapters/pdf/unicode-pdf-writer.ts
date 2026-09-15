import type { TrueTypeFont } from './truetype-font';
import {
	assemblePdf,
	buildFontObjects,
	deflatePdfStream,
	formatNumber,
	hexGlyphs,
	latin1Bytes,
	type PdfObject
} from './pdf-writer-primitives';

export { formatNumber };

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

	for (const { id, object } of buildFontObjects(program, {
		font: fontId,
		descendantFont: descendantFontId,
		descriptor: descriptorId,
		fontFile: fontFileId,
		toUnicode: toUnicodeId
	})) {
		set(id, object);
	}

	pages.forEach((page: PdfPage, index: number): void => {
		set(pageIds[index], {
			body:
				`<< /Type /Page /Parent ${pagesId} 0 R ` +
				`/Resources << /Font << /F1 ${fontId} 0 R >> >> ` +
				`/MediaBox [0 0 ${formatNumber(page.width)} ${formatNumber(page.height)}] ` +
				`/Contents ${contentIds[index]} 0 R >>`
		});
		const content: Uint8Array = deflatePdfStream(latin1Bytes(buildContentStream(page)));
		set(contentIds[index], {
			body: `<< /Length ${content.byteLength} /Filter /FlateDecode >>`,
			stream: content
		});
	});

	return assemblePdf(objects);
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

function colorOperands(color: PdfColor): string {
	return `${formatNumber(color.red)} ${formatNumber(color.green)} ${formatNumber(color.blue)}`;
}
