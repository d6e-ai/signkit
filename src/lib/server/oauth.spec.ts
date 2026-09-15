import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './oauth';

describe('safeReturnPath', () => {
	it('accepts same-origin paths', () =>
		expect(safeReturnPath('/ja/agreements?draft=1')).toBe('/ja/agreements?draft=1'));

	it('accepts a bare slash', () => expect(safeReturnPath('/')).toBe('/'));

	it('accepts a path with a hash fragment', () =>
		expect(safeReturnPath('/envelopes/123#section')).toBe('/envelopes/123#section'));

	it.each([undefined, null, ''])('rejects empty/nullish input %s', (value) =>
		expect(safeReturnPath(value)).toBeNull()
	);

	it.each([
		'https://evil.test',
		'http://evil.test',
		'//evil.test',
		'///evil.test',
		'not-a-path',
		'evil.test/path'
	])('rejects absolute/protocol-relative/scheme-less values: %s', (value) =>
		expect(safeReturnPath(value)).toBeNull()
	);

	describe('backslash smuggling', () => {
		it.each([
			'/\\attacker.example',
			'/\\/attacker.example',
			'\\/attacker.example',
			'\\\\attacker.example',
			'/foo\\@attacker.example',
			'/%5cattacker.example',
			'/%5Cattacker.example',
			'/foo/%5c%5cattacker.example'
		])('rejects backslash-based host smuggling: %s', (value) =>
			expect(safeReturnPath(value)).toBeNull()
		);
	});

	describe('control character smuggling', () => {
		it.each([
			'/\t/attacker.example',
			'/\n/attacker.example',
			'/\r\n/attacker.example',
			'/\x00/attacker.example',
			'//attacker.example',
			'/%09/attacker.example',
			'/%0d%0a/attacker.example',
			'/%00/attacker.example',
			'/%1f/attacker.example',
			'/%7f/attacker.example'
		])('rejects raw and percent-encoded control characters: %s', (value) =>
			expect(safeReturnPath(value)).toBeNull()
		);
	});

	describe('encoded ambiguity', () => {
		it.each(['/%2e%2e/attacker.example', '/%252f%252fattacker.example', '/..%2f..%2fetc'])(
			'still resolves to a same-origin path (no cross-origin escape): %s',
			(value) => {
				const result = safeReturnPath(value);
				expect(result).not.toBeNull();
				expect(result?.startsWith('/')).toBe(true);
				expect(result?.startsWith('//')).toBe(false);
			}
		);
	});

	it('canonicalizes an equivalent path+query+hash', () => {
		expect(safeReturnPath('/a/b?x=1&y=2#top')).toBe('/a/b?x=1&y=2#top');
	});
});
