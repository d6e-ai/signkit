import { describe, expect, it } from 'vitest';
import { consoleCorsSurface, isOperatorApiPath } from './operator-api-surface';

describe('operator API surface', () => {
	it.each([
		'/api/v1/api-keys',
		'/api/v1/api-keys/01900000-0000-7000-8000-000000000201/revoke',
		'/api/v1/contacts/search',
		'/api/v1/dashboard',
		'/api/v1/envelopes',
		'/api/v1/envelopes/01900000-0000-7000-8000-000000000001/completion-artifact/pdf',
		'/api/v1/envelopes/01900000-0000-7000-8000-000000000001/recipients/r/reissue',
		'/api/v1/instance/bootstrap',
		'/api/v1/instance/members/me',
		'/api/v1/instance/invitations/accept',
		'/api/v1/webhooks/01900000-0000-7000-8000-000000000201/deliveries'
	])('includes %s', (pathname) => {
		expect(isOperatorApiPath(pathname)).toBe(true);
		expect(consoleCorsSurface(pathname)).toBe('operator');
	});

	it.each([
		'/api/v1/signing/context',
		'/api/v1/signing/signature-assets',
		'/api/v1/recipient/context',
		'/api/v1/recipient/documents/01900000-0000-7000-8000-000000000001.pdf',
		'/api/v1/completion-artifacts',
		'/api/v1/system/deliveries/drain',
		'/api/v1/system/maintenance/health',
		'/api/v1/system/capabilities/extra',
		'/api/v1/envelopesx',
		'/api/v1',
		'/s/skr1_token',
		'/c/skca1_token',
		'/envelopes',
		'/settings/api-keys',
		'/auth/login'
	])('excludes %s from bearer verification and console CORS', (pathname) => {
		expect(isOperatorApiPath(pathname)).toBe(false);
		expect(consoleCorsSurface(pathname)).toBeNull();
	});

	it.each(['/api/v1/system/capabilities', '/api/v1/openapi.json'])(
		'opens %s as public discovery only',
		(pathname) => {
			expect(isOperatorApiPath(pathname)).toBe(false);
			expect(consoleCorsSurface(pathname)).toBe('discovery');
		}
	);
});
