import { describe, expect, it } from 'vitest';
import { isLocaleExcludedPath, isSessionExcludedPath } from './hooks.server';

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

describe('session exclusions', () => {
	it('keeps recipient capability routes independent from d6e-auth browser sessions', () => {
		expect(isSessionExcludedPath('/api/v1/signing/context')).toBe(true);
		expect(isSessionExcludedPath('/s/capability')).toBe(true);
		expect(isSessionExcludedPath('/sign')).toBe(true);
		expect(isSessionExcludedPath('/ja/sign')).toBe(true);
		expect(isSessionExcludedPath('/api/v1/envelopes')).toBe(false);
		expect(isSessionExcludedPath('/signature')).toBe(false);
	});
});
