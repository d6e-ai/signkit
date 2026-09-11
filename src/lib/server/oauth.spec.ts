import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './oauth';

describe('safeReturnPath', () => {
	it('accepts same-origin paths', () =>
		expect(safeReturnPath('/ja/agreements?draft=1')).toBe('/ja/agreements?draft=1'));
	it.each(['https://evil.test', '//evil.test', null])('rejects external return %s', (value) =>
		expect(safeReturnPath(value)).toBeNull()
	);
});
