import { describe, expect, it } from 'vitest';
import { isRecipientSurfacePath } from './recipient-surface';

describe('recipient surface route classification', () => {
	it.each([
		'/s/token',
		'/sign',
		'/en/sign',
		'/ja/sign',
		'/en/s/token',
		'/sign/01910000-0000-7000-8000-000000000001',
		'/en/sign/01910000-0000-7000-8000-000000000001',
		'/sign/01910000-0000-7000-8000-000000000001/agreement.pdf'
	])('classifies %s as a recipient surface', (pathname) =>
		expect(isRecipientSurfacePath(pathname)).toBe(true)
	);

	it.each(['/', '/en', '/api/v1/signing/context', '/agreements/signatures'])(
		'keeps %s in the operator shell',
		(pathname) => expect(isRecipientSurfacePath(pathname)).toBe(false)
	);
});
