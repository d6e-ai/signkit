import { describe, expect, it } from 'vitest';
import {
	PDF_CHARS_PER_LINE,
	PDF_LINES_PER_PAGE,
	paginateLines,
	renderDeterministicTextPdf,
	toPdfSafeText,
	wrapPlainTextLines
} from './deterministic-pdf-writer';

describe('renderDeterministicTextPdf', () => {
	it('produces byte-identical output for identical input across separate calls', () => {
		const pages: readonly (readonly string[])[] = [
			['Title page', 'Envelope: 01900000-0000-7000-8000-000000000001'],
			['Second page', 'more content']
		];
		const first: Uint8Array = renderDeterministicTextPdf(pages);
		const second: Uint8Array = renderDeterministicTextPdf(pages);
		expect(Array.from(first)).toEqual(Array.from(second));
	});

	it('produces a well-formed PDF header, one object per page/content pair plus catalog/pages/font, and a trailer', () => {
		const bytes: Uint8Array = renderDeterministicTextPdf([['line one'], ['line two']]);
		const text: string = new TextDecoder('latin1').decode(bytes);
		expect(text.startsWith('%PDF-1.4')).toBe(true);
		expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
		expect(text).toContain('/Type /Catalog');
		expect(text).toContain('/Type /Pages');
		expect(text).toContain('/BaseFont /Courier');
		// catalog + pages + font + 2 pages + 2 content streams = 7 objects
		expect((text.match(/\d+ 0 obj/g) ?? []).length).toBe(7);
		expect(text).toContain('/Count 2');
	});

	it('escapes PDF string literal special characters', () => {
		const bytes: Uint8Array = renderDeterministicTextPdf([
			['a (parenthetical) and a \\ backslash']
		]);
		const text: string = new TextDecoder('latin1').decode(bytes);
		expect(text).toContain('a \\(parenthetical\\) and a \\\\ backslash');
	});

	it('renders a single empty page for no input rather than an invalid empty document', () => {
		const bytes: Uint8Array = renderDeterministicTextPdf([]);
		const text: string = new TextDecoder('latin1').decode(bytes);
		expect(text).toContain('/Count 1');
	});

	it('encodes WinAnsi accented characters as single-byte PDF octal escapes, not raw UTF-8', () => {
		const bytes: Uint8Array = renderDeterministicTextPdf([['café vs café in Zürich']]);
		const text: string = new TextDecoder('latin1').decode(bytes);
		// 0x00E9 (é) is WinAnsi/Latin-1 byte 0xE9, i.e. octal 351; 0x00FC (ü) is 0xFC, octal 374.
		expect(text).toContain('caf\\351 in Z\\374rich');
		// The historical bug encoded each accented character as its two-byte
		// UTF-8 sequence (0xC3 0xA9 for é) instead of one WinAnsi byte.
		const utf8OfE: Uint8Array = new TextEncoder().encode('é');
		expect(containsSubsequence(bytes, utf8OfE)).toBe(false);
	});

	it('round-trips an accented literal through PDF literal-string escape rules to its WinAnsi byte value', () => {
		// Callers always pass text through toPdfSafeText first (see completion-pdf.ts); it
		// replaces "—" (em dash), which is outside the writer's declared WinAnsi/Latin-1
		// contract, with the unsupported-character placeholder before it ever reaches here.
		const line: string = toPdfSafeText('Résumé — naïve');
		const bytes: Uint8Array = renderDeterministicTextPdf([[line]]);
		const text: string = new TextDecoder('latin1').decode(bytes);
		const literal: string = extractFirstLiteral(text);
		const decodedBytes: number[] = decodePdfLiteral(literal);
		expect(decodedBytes).toEqual([...line].map((c) => c.codePointAt(0)));
	});

	it('keeps ASCII literal escaping intact alongside octal-escaped accented characters', () => {
		const bytes: Uint8Array = renderDeterministicTextPdf([['(café) and \\ done']]);
		const text: string = new TextDecoder('latin1').decode(bytes);
		expect(text).toContain('\\(caf\\351\\) and \\\\ done');
	});

	it('keeps the content stream /Length accurate when the stream contains octal escapes', () => {
		const bytes: Uint8Array = renderDeterministicTextPdf([['café in Zürich, naïve résumé']]);
		const text: string = new TextDecoder('latin1').decode(bytes);
		const match: RegExpMatchArray | null = text.match(
			/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/
		);
		expect(match).not.toBeNull();
		const [, declaredLength, stream] = match as RegExpMatchArray;
		expect(new TextEncoder().encode(stream).byteLength).toBe(Number(declaredLength));
	});

	it('keeps xref offsets pointing at the correct object even with octal-escaped content', () => {
		const bytes: Uint8Array = renderDeterministicTextPdf([['café title'], ['Zürich office']]);
		const text: string = new TextDecoder('latin1').decode(bytes);
		const xrefMatch: RegExpMatchArray | null = text.match(/xref\n0 (\d+)\n([\s\S]*?)\ntrailer/);
		expect(xrefMatch).not.toBeNull();
		const [, , entriesBlock] = xrefMatch as RegExpMatchArray;
		const entries: string[] = entriesBlock.split('\n').slice(1); // drop the free-list head entry
		for (let index: number = 0; index < entries.length; index += 1) {
			const offset: number = Number(entries[index].slice(0, 10));
			const objectNumber: number = index + 1;
			expect(text.slice(offset, offset + `${objectNumber} 0 obj`.length)).toBe(
				`${objectNumber} 0 obj`
			);
		}
	});
});

describe('toPdfSafeText', () => {
	it('passes through printable ASCII and common whitespace unchanged', () => {
		expect(toPdfSafeText('Hello, World! 123.')).toBe('Hello, World! 123.');
	});

	it('substitutes characters outside WinAnsiEncoding one-for-one', () => {
		expect(toPdfSafeText('契約書')).toBe('???');
		expect(toPdfSafeText('a契b')).toBe('a?b');
	});

	it('preserves string length under substitution so downstream wrapping stays exact', () => {
		const original: string = 'signed by 山田太郎 on 2026-09-13';
		expect(toPdfSafeText(original)).toHaveLength(original.length);
	});
});

/** Extracts the byte content of the first `(...) Tj` literal in a decoded content stream. */
function extractFirstLiteral(text: string): string {
	const match: RegExpMatchArray | null = text.match(/\(((?:\\.|[^()\\])*)\) Tj/);
	if (match === null) throw new Error('no literal string found');
	return match[1];
}

/** Minimal PDF literal-string decoder (ISO 32000-1 §7.3.4.2) for octal escapes and the three escaped delimiters. */
function decodePdfLiteral(literal: string): number[] {
	const bytes: number[] = [];
	for (let index: number = 0; index < literal.length; index += 1) {
		const character: string = literal[index];
		if (character !== '\\') {
			bytes.push(character.codePointAt(0) ?? 0);
			continue;
		}
		const next: string = literal[index + 1];
		if (next === '\\' || next === '(' || next === ')') {
			bytes.push(next.codePointAt(0) ?? 0);
			index += 1;
			continue;
		}
		const octal: string = literal.slice(index + 1, index + 4);
		bytes.push(Number.parseInt(octal, 8));
		index += 3;
	}
	return bytes;
}

function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
	if (needle.length === 0) return true;
	for (let start: number = 0; start <= haystack.length - needle.length; start += 1) {
		let matches: boolean = true;
		for (let offset: number = 0; offset < needle.length; offset += 1) {
			if (haystack[start + offset] !== needle[offset]) {
				matches = false;
				break;
			}
		}
		if (matches) return true;
	}
	return false;
}

describe('wrapPlainTextLines', () => {
	it('wraps on whitespace without dropping or reordering non-whitespace characters', () => {
		const text: string = 'the quick brown fox jumps over the lazy dog';
		const wrapped: string[] = wrapPlainTextLines(text, 10);
		expect(wrapped.join(' ').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
		for (const line of wrapped) expect(line.length).toBeLessThanOrEqual(10);
	});

	it('hard-breaks a single token longer than the line width', () => {
		const wrapped: string[] = wrapPlainTextLines('a'.repeat(25), 10);
		expect(wrapped).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
	});

	it('preserves blank lines and explicit newlines', () => {
		expect(wrapPlainTextLines('line one\n\nline two', 20)).toEqual(['line one', '', 'line two']);
	});

	it('is deterministic for repeated calls with the same input', () => {
		const text: string = 'repeatable wrapping behavior across calls';
		expect(wrapPlainTextLines(text, 12)).toEqual(wrapPlainTextLines(text, 12));
	});
});

describe('paginateLines', () => {
	it('chunks lines into fixed-size pages', () => {
		const lines: string[] = Array.from(
			{ length: 5 },
			(_, index: number): string => `line ${index}`
		);
		expect(paginateLines(lines, 2)).toEqual([
			['line 0', 'line 1'],
			['line 2', 'line 3'],
			['line 4']
		]);
	});

	it('returns a single empty page for no lines', () => {
		expect(paginateLines([], 10)).toEqual([[]]);
	});

	it('uses the default page geometry to produce a sane chars/lines-per-page bound', () => {
		expect(PDF_CHARS_PER_LINE).toBeGreaterThan(60);
		expect(PDF_LINES_PER_PAGE).toBeGreaterThan(40);
	});
});
