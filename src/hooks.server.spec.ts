import { describe, expect, it } from 'vitest';
import { isLocaleExcludedPath } from './hooks.server';

describe('locale exclusions', () => {
	it.each(['/api', '/api/v1/envelopes', '/.well-known/jwks.json', '/health', '/webhooks/sign'])(
		'excludes machine path %s',
		(pathname) => {
			expect(isLocaleExcludedPath(pathname)).toBe(true);
		}
	);

	it.each(['/', '/en', '/ja/agreements', '/templates'])('localizes human path %s', (pathname) => {
		expect(isLocaleExcludedPath(pathname)).toBe(false);
	});
});
