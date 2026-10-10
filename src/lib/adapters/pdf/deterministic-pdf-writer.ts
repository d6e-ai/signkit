/**
 * Minimal, dependency-free, deterministic PDF/1.4 writer. No embedded fonts,
 * no external libraries, no wall-clock metadata: identical input pages
 * always produce byte-identical output, which is required for a completion
 * artifact whose own SHA-256 becomes part of the durable evidence record.
 *
 * Uses the standard (non-embedded) Courier base-14 font so page layout is a
 * simple, exact fixed-width character grid — no font metrics table is
 * needed for word wrap. Text is restricted to the WinAnsiEncoding subset
 * Courier actually has glyphs for; see {@link toPdfSafeText}.
 *
 * This is intentionally a plain text-grid renderer, not a layout engine: it
 * has no support for embedded images, custom fonts, or pixel-precise field
 * geometry. It is a Workers-compatible (no Node builtins, no native
 * bindings) evidence rendering, not a design-fidelity document converter.
 */

export const PDF_FONT_SIZE: number = 10;
export const PDF_LINE_HEIGHT: number = 12;
export const PDF_PAGE_WIDTH: number = 612; // US Letter, points
export const PDF_PAGE_HEIGHT: number = 792;
export const PDF_MARGIN: number = 54;
export const PDF_CHARS_PER_LINE: number = Math.floor(
	(PDF_PAGE_WIDTH - 2 * PDF_MARGIN) / (PDF_FONT_SIZE * 0.6)
);
export const PDF_LINES_PER_PAGE: number = Math.floor(
	(PDF_PAGE_HEIGHT - 2 * PDF_MARGIN) / PDF_LINE_HEIGHT
);
/** Substituted for any character Courier/WinAnsiEncoding cannot render (see module docstring). */
export const PDF_UNSUPPORTED_CHARACTER_PLACEHOLDER: string = '?';

/**
 * Renders one page per element of `pages`, each already split into lines
 * that fit {@link PDF_CHARS_PER_LINE} and {@link PDF_LINES_PER_PAGE}. Lines
 * are rendered verbatim (already PDF-safe) starting at the top margin.
 */
export function renderDeterministicTextPdf(pages: readonly (readonly string[])[]): Uint8Array {
	const effectivePages: readonly (readonly string[])[] = pages.length === 0 ? [[]] : pages;
	const objects: string[] = [];
	// Object 1: catalog, object 2: pages tree, object 3: font.
	const pageObjectIds: number[] = effectivePages.map((_, index: number): number => 4 + index * 2);
	const contentObjectIds: number[] = effectivePages.map(
		(_, index: number): number => 5 + index * 2
	);

	objects.push('<< /Type /Catalog /Pages 2 0 R >>');
	objects.push(
		`<< /Type /Pages /Kids [${pageObjectIds.map((id: number): string => `${id} 0 R`).join(' ')}] /Count ${effectivePages.length} >>`
	);
	objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');

	for (let index: number = 0; index < effectivePages.length; index += 1) {
		const pageObjectId: number = pageObjectIds[index];
		const contentObjectId: number = contentObjectIds[index];
		objects[pageObjectId - 1] =
			`<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] /Contents ${contentObjectId} 0 R >>`;
		const stream: string = buildContentStream(effectivePages[index]);
		const streamBytes: Uint8Array = new TextEncoder().encode(stream);
		objects[contentObjectId - 1] =
			`<< /Length ${streamBytes.byteLength} >>\nstream\n${stream}\nendstream`;
	}

	return assembleDocument(objects);
}

function buildContentStream(lines: readonly string[]): string {
	const startY: number = PDF_PAGE_HEIGHT - PDF_MARGIN;
	const parts: string[] = ['BT', `/F1 ${PDF_FONT_SIZE} Tf`, `${PDF_LINE_HEIGHT} TL`];
	parts.push(`${PDF_MARGIN} ${startY} Td`);
	for (let index: number = 0; index < lines.length; index += 1) {
		if (index > 0) parts.push('T*');
		parts.push(`(${escapePdfLiteral(lines[index])}) Tj`);
	}
	parts.push('ET');
	return parts.join('\n');
}

function assembleDocument(objects: readonly string[]): Uint8Array {
	const header: string = '%PDF-1.4\n%âãÏÓ\n';
	const chunks: string[] = [header];
	const offsets: number[] = [];
	let cursor: number = byteLength(header);
	for (let index: number = 0; index < objects.length; index += 1) {
		offsets.push(cursor);
		const objectText: string = `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
		chunks.push(objectText);
		cursor += byteLength(objectText);
	}
	const xrefOffset: number = cursor;
	const xrefLines: string[] = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
	for (const offset of offsets) {
		xrefLines.push(`${offset.toString().padStart(10, '0')} 00000 n `);
	}
	const xref: string = `${xrefLines.join('\n')}\n`;
	const trailer: string = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
	chunks.push(xref, trailer);
	return new TextEncoder().encode(chunks.join(''));
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

/**
 * PDF literal strings are byte sequences, not UTF-8 text: `TextEncoder`
 * would otherwise split every WinAnsi character above U+007E (already
 * verified renderable by {@link toPdfSafeText}) into multiple UTF-8 bytes,
 * which WinAnsiEncoding then renders as multiple mojibake glyphs instead of
 * the single intended one. WinAnsiEncoding's 0xA0-0xFF range is identical to
 * the Unicode code points it represents, so each such character is emitted
 * as a PDF octal escape (`\ddd`) for that single byte value, keeping the
 * whole content stream ASCII and therefore safe to run through
 * `TextEncoder` unchanged.
 */
function escapePdfLiteral(value: string): string {
	let result: string = '';
	for (const character of value) {
		if (character === '\\' || character === '(' || character === ')') {
			result += `\\${character}`;
			continue;
		}
		const codePoint: number = character.codePointAt(0) ?? 0;
		result += codePoint > 0x7e ? `\\${codePoint.toString(8).padStart(3, '0')}` : character;
	}
	return result;
}

/**
 * Courier/WinAnsiEncoding has no glyphs outside Latin-1-ish printable ASCII
 * plus a handful of accented characters. Anything else (CJK text in
 * documents authored in Japanese, for example) is replaced one-for-one with
 * {@link PDF_UNSUPPORTED_CHARACTER_PLACEHOLDER} rather than silently
 * dropped, corrupted, or crashing the renderer. The document's own SHA-256
 * (already present in the completion manifest) remains the authoritative,
 * full-fidelity evidence; this PDF is a human-readable rendering, not a
 * replacement for it.
 */
export function toPdfSafeText(value: string): string {
	let result: string = '';
	for (const character of value) {
		const codePoint: number = character.codePointAt(0) ?? 0;
		result += isRenderableInWinAnsi(codePoint) ? character : PDF_UNSUPPORTED_CHARACTER_PLACEHOLDER;
	}
	return result;
}

function isRenderableInWinAnsi(codePoint: number): boolean {
	if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return true;
	if (codePoint < 0x20) return false;
	if (codePoint <= 0x7e) return true;
	return codePoint >= 0xa0 && codePoint <= 0xff;
}

/**
 * Deterministic word wrap: breaks on runs of whitespace, hard-breaking any
 * single token longer than `maxCharsPerLine`. Never reorders or drops
 * characters; every input character (after {@link toPdfSafeText}) appears
 * in the output.
 */
export function wrapPlainTextLines(text: string, maxCharsPerLine: number): string[] {
	if (maxCharsPerLine < 1) throw new Error('maxCharsPerLine must be at least 1');
	const lines: string[] = [];
	for (const rawLine of text.split('\n')) {
		if (rawLine.length === 0) {
			lines.push('');
			continue;
		}
		let current: string = '';
		for (const word of rawLine.split(/(\s+)/)) {
			if (word.length === 0) continue;
			if (/^\s+$/.test(word)) {
				current += word;
				continue;
			}
			let remaining: string = word;
			while (current.length + remaining.length > maxCharsPerLine) {
				const spaceLeft: number = maxCharsPerLine - current.length;
				if (spaceLeft <= 0) {
					lines.push(current.trimEnd());
					current = '';
					continue;
				}
				current += remaining.slice(0, spaceLeft);
				remaining = remaining.slice(spaceLeft);
				lines.push(current.trimEnd());
				current = '';
			}
			current += remaining;
		}
		lines.push(current.trimEnd());
	}
	return lines;
}

/** Chunks a flat line list into fixed-size pages for {@link renderDeterministicTextPdf}. */
export function paginateLines(
	lines: readonly string[],
	linesPerPage: number = PDF_LINES_PER_PAGE
): string[][] {
	if (linesPerPage < 1) throw new Error('linesPerPage must be at least 1');
	const pages: string[][] = [];
	for (let offset: number = 0; offset < lines.length; offset += linesPerPage) {
		pages.push(lines.slice(offset, offset + linesPerPage));
	}
	return pages.length === 0 ? [[]] : pages;
}
