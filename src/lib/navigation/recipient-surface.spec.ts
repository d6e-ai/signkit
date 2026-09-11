import { describe, expect, it } from 'vitest';
import { isRecipientSurfacePath } from './recipient-surface';

describe('recipient surface route classification', () => {
	it.each(['/s/token', '/sign', '/en/sign', '/ja/sign', '/en/s/token'])(
		'classifies %s as a recipient surface',
		(pathname) => expect(isRecipientSurfacePath(pathname)).toBe(true)
	);

	it.each(['/', '/en', '/api/v1/signing/context', '/agreements/signatures'])(
		'keeps %s in the operator shell',
		(pathname) => expect(isRecipientSurfacePath(pathname)).toBe(false)
	);
});
