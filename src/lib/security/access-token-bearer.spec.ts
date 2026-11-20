import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_BEARER_MAX_LENGTH, parseBearerAccessToken } from './access-token-bearer';

const JWT: string = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl';

describe('parseBearerAccessToken', () => {
	it('extracts a compact JWS presented with the exact Bearer scheme', () => {
		expect(parseBearerAccessToken(`Bearer ${JWT}`)).toBe(JWT);
	});

	/**
	 * Every other credential family stays with the handling it had before access
	 * tokens were accepted: none of them contains a dot, and anything starting
	 * with `signkit_` belongs to the API key parser.
	 */
	it.each([
		['no header', null],
		['an empty header', ''],
		['an API key', `Bearer signkit_${'a'.repeat(43)}`],
		['a signkit_-prefixed dotted value', 'Bearer signkit_a.b.c'],
		['a recipient capability', `Bearer skr1_${'a'.repeat(43)}`],
		['a completion access grant', `Bearer skca1_${'a'.repeat(43)}`],
		['an instance invitation token', `Bearer ski1_${'a'.repeat(43)}`],
		['a worker secret', `Bearer ${'x'.repeat(48)}`],
		['a lowercase scheme', `bearer ${JWT}`],
		['a Basic credential', 'Basic dXNlcjpwYXNz'],
		['two segments', 'Bearer eyJhbGciOiJSUzI1NiJ9.e30'],
		['an unsigned JWS', 'Bearer eyJhbGciOiJub25lIn0.e30.'],
		['four segments', `Bearer ${JWT}.extra`],
		['padding characters', 'Bearer eyJh=.e30=.c2ln'],
		['a joined duplicate header', `Bearer ${JWT}, Bearer ${JWT}`],
		['surrounding whitespace', `Bearer  ${JWT}`],
		['an oversized value', `Bearer ${'a'.repeat(ACCESS_TOKEN_BEARER_MAX_LENGTH)}.e30.c2ln`]
	])('returns null for %s', (_name, header) => {
		expect(parseBearerAccessToken(header)).toBeNull();
	});
});
