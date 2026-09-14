import { describe, expect, it } from 'vitest';
import { isSignedOutSurfacePath } from './signed-out-surface';

describe('signed-out surface route classification', () => {
	it.each(['/signed-out', '/en/signed-out', '/ja/signed-out'])(
		'classifies %s as the signed-out surface',
		(pathname) => expect(isSignedOutSurfacePath(pathname)).toBe(true)
	);

	it.each(['/', '/en', '/settings', '/setup', '/sign', '/auth/login'])(
		'keeps %s out of the signed-out surface',
		(pathname) => expect(isSignedOutSurfacePath(pathname)).toBe(false)
	);
});
