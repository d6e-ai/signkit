import { zlibSync } from 'fflate';
import type { PdfFontProgram } from './unicode-pdf-writer';

/**
 * The byte-level pieces every SignKit PDF writer shares: object assembly, the
 * embedded-subset font dictionaries, and number/string serialization.
 *
 * Both writers that produce a whole document — the Markdown renderer's
 * {@link import('./unicode-pdf-writer').renderUnicodePdf} and the executed
 * agreement's {@link import('./pdf-composer').composePdf} — emit the same
 * structures, so they live here once. Everything is deterministic: no
 * timestamps, no document ID, no randomness.
 */

export interface PdfObject {
	/** Dictionary or other object body, already serialized. */
	body: string;
	/** Optional raw stream payload appended after the dictionary. */
	stream?: Uint8Array;
}

/** Fixed compression level so identical input always deflates to identical bytes. */
export function deflatePdfStream(bytes: Uint8Array): Uint8Array {
	return zlibSync(bytes, { level: 9 });
}

export function assemblePdf(objects: readonly PdfObject[]): Uint8Array {
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

export interface EmbeddedFontObjectIds {
	font: number;
	descendantFont: number;
	descriptor: number;
	fontFile: number;
	toUnicode: number;
}

/**
 * The five objects a subsetted TrueType face needs to render through an
 * Identity-H CID mapping, keyed by the caller's pre-reserved object numbers.
 */
export function buildFontObjects(
	program: PdfFontProgram,
	ids: EmbeddedFontObjectIds
): readonly { id: number; object: PdfObject }[] {
	const subsetTag: string = subsetTagFor(program.bytes);
	const fullName: string = `${subsetTag}+${program.baseFontName}`;
	const scale = (value: number): number => Math.round((value * 1000) / program.metrics.unitsPerEm);
	const compressedFont: Uint8Array = deflatePdfStream(program.bytes);
	const toUnicodeStream: Uint8Array = deflatePdfStream(buildToUnicodeCMap(program.toUnicode));
	return [
		{
			id: ids.font,
			object: {
				body: `<< /Type /Font /Subtype /Type0 /BaseFont /${fullName} /Encoding /Identity-H /DescendantFonts [${ids.descendantFont} 0 R] /ToUnicode ${ids.toUnicode} 0 R >>`
			}
		},
		{
			id: ids.descendantFont,
			object: {
				body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${fullName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ids.descriptor} 0 R /DW 1000 /W ${widthArray(program.widths)} /CIDToGIDMap /Identity >>`
			}
		},
		{
			id: ids.descriptor,
			object: {
				body:
					`<< /Type /FontDescriptor /FontName /${fullName} /Flags 4 ` +
					`/FontBBox [${scale(program.metrics.xMin)} ${scale(program.metrics.yMin)} ${scale(program.metrics.xMax)} ${scale(program.metrics.yMax)}] ` +
					`/ItalicAngle ${program.metrics.italicAngle} /Ascent ${scale(program.metrics.ascender)} ` +
					`/Descent ${scale(program.metrics.descender)} /CapHeight ${scale(program.metrics.capHeight)} ` +
					`/StemV ${program.metrics.stemV} /FontFile2 ${ids.fontFile} 0 R >>`
			}
		},
		{
			id: ids.fontFile,
			object: {
				body: `<< /Length ${compressedFont.byteLength} /Length1 ${program.bytes.byteLength} /Filter /FlateDecode >>`,
				stream: compressedFont
			}
		},
		{
			id: ids.toUnicode,
			object: {
				body: `<< /Length ${toUnicodeStream.byteLength} /Filter /FlateDecode >>`,
				stream: toUnicodeStream
			}
		}
	];
}

export function hexGlyphs(glyphIds: readonly number[]): string {
	let hex: string = '';
	for (const glyphId of glyphIds) hex += (glyphId & 0xffff).toString(16).padStart(4, '0');
	return hex;
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

/**
 * PDF syntax outside streams is byte-oriented, not UTF-8: every character the
 * writer emits is already ASCII or an explicitly chosen high byte in the
 * binary comment, so one character must map to exactly one byte.
 */
export function latin1Bytes(value: string): Uint8Array {
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
