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
