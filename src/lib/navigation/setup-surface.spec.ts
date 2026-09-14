import { describe, expect, it } from 'vitest';
import { isSetupSurfacePath } from './setup-surface';

describe('setup surface route classification', () => {
	it.each(['/setup', '/en/setup', '/ja/setup'])('classifies %s as the setup surface', (pathname) =>
		expect(isSetupSurfacePath(pathname)).toBe(true)
	);

	it.each(['/', '/en', '/settings', '/api/v1/instance/bootstrap', '/sign'])(
		'keeps %s out of the setup surface',
		(pathname) => expect(isSetupSurfacePath(pathname)).toBe(false)
	);
});
