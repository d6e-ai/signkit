import { describe, expect, it } from 'vitest';
import { isApiKeyAuthenticatedPath, isApiKeyRejectedPath } from './api-key-surface';

describe('API key surface allowlist', () => {
	it.each([
		'/api/v1/envelopes',
		'/api/v1/envelopes/01900000-0000-7000-8000-000000000001',
		'/api/v1/envelopes/01900000-0000-7000-8000-000000000001/draft',
		'/api/v1/envelopes/01900000-0000-7000-8000-000000000001/deliveries',
		'/api/v1/envelopes/01900000-0000-7000-8000-000000000001/completion-artifact'
	])('resolves an API key on the operator envelope surface %s', (pathname) => {
		expect(isApiKeyAuthenticatedPath(pathname)).toBe(true);
	});

	/**
	 * Each of these protects a distinct authority an API key must never reach or
	 * impersonate: instance and key management (privilege escalation), the
	 * recipient capability family, the public completion grant family, and the
	 * deployment worker secret family.
	 */
	it.each([
		'/api/v1/api-keys',
		'/api/v1/api-keys/01900000-0000-7000-8000-000000000201/revoke',
		'/api/v1/api-keys/01900000-0000-7000-8000-000000000201/organization-grants',
		'/api/v1/instance/bootstrap',
		'/api/v1/instance/members',
		'/api/v1/instance/members/me',
		'/api/v1/instance/invitations',
		'/api/v1/instance/invitations/accept',
		'/api/v1/signing/context',
		'/api/v1/signing/documents',
		'/api/v1/signing/sign',
		'/api/v1/completion-artifacts',
		'/api/v1/system/capabilities',
		'/api/v1/system/deliveries/drain',
		'/api/v1/system/completion-artifacts/drain',
		'/api/v1/system/completion-deliveries/drain',
		'/s/skr1_token',
		'/c/skca1_token',
		'/settings',
		'/en/sign',
		'/'
	])('never resolves an API key on %s', (pathname) => {
		expect(isApiKeyAuthenticatedPath(pathname)).toBe(false);
	});

	it('does not match a path that merely starts with the allowlisted segment', () => {
		expect(isApiKeyAuthenticatedPath('/api/v1/envelopes-export')).toBe(false);
		expect(isApiKeyAuthenticatedPath('/api/v1/envelopesx')).toBe(false);
	});
});

describe('API key rejected surface', () => {
	/**
	 * These are the privilege-escalation targets: minting another key, granting an
	 * organization, revoking a grant, and administering instance members. On each,
	 * presenting a well-formed API key must be an error rather than something to
	 * ignore, because ignoring it would let an accompanying cookie authorize the
	 * request instead.
	 */
	it.each([
		'/api/v1/api-keys',
		'/api/v1/api-keys/01900000-0000-7000-8000-000000000201/revoke',
		'/api/v1/api-keys/01900000-0000-7000-8000-000000000201/organization-grants',
		'/api/v1/api-keys/01900000-0000-7000-8000-000000000201/organization-grants/01900000-0000-7000-8000-000000000301/revoke',
		'/api/v1/instance',
		'/api/v1/instance/members',
		'/api/v1/instance/members/me',
		'/api/v1/instance/members/user-2/role',
		'/api/v1/instance/members/user-2/status',
		'/api/v1/instance/invitations',
		'/api/v1/instance/invitations/accept',
		'/api/v1/instance/invitations/01900000-0000-7000-8000-000000000301/revoke',
		'/api/v1/webhooks',
		'/api/v1/webhooks/01900000-0000-7000-8000-000000000401',
		'/api/v1/webhooks/01900000-0000-7000-8000-000000000401/revoke'
	])('rejects an API key presented on %s', (pathname) => {
		expect(isApiKeyRejectedPath(pathname)).toBe(true);
	});

	/**
	 * Bootstrap is exempt because its `Authorization` header is not a
	 * credential-family selector: it carries `SIGNKIT_BOOTSTRAP_SECRET`, checked
	 * constant-time before identity, so an API-key-shaped value there is simply a
	 * wrong deployment secret and already fails closed with an opaque 404.
	 */
	it('exempts instance bootstrap so its deployment-secret flow is unchanged', () => {
		expect(isApiKeyRejectedPath('/api/v1/instance/bootstrap')).toBe(false);
	});

	/**
	 * The read surface is where keys belong, so it must never be in the rejected
	 * set -- the two lists have to stay disjoint or a key could be both resolved
	 * and refused.
	 */
	it.each([
		'/api/v1/envelopes',
		'/api/v1/envelopes/01900000-0000-7000-8000-000000000001',
		'/api/v1/envelopes/01900000-0000-7000-8000-000000000001/draft'
	])('never rejects on the API key read surface %s', (pathname) => {
		expect(isApiKeyRejectedPath(pathname)).toBe(false);
		expect(isApiKeyAuthenticatedPath(pathname)).toBe(true);
	});

	it.each([
		'/api/v1/signing/context',
		'/api/v1/completion-artifacts',
		'/api/v1/system/deliveries/drain',
		'/api/v1/system/capabilities',
		'/s/skr1_token',
		'/c/skca1_token',
		'/settings',
		'/'
	])('leaves %s outside both lists', (pathname) => {
		expect(isApiKeyRejectedPath(pathname)).toBe(false);
		expect(isApiKeyAuthenticatedPath(pathname)).toBe(false);
	});

	it('does not match a path that merely starts with a rejected segment', () => {
		expect(isApiKeyRejectedPath('/api/v1/api-keys-export')).toBe(false);
		expect(isApiKeyRejectedPath('/api/v1/instances')).toBe(false);
	});

	it('keeps the two lists disjoint', () => {
		const paths: readonly string[] = [
			'/api/v1/envelopes',
			'/api/v1/envelopes/01900000-0000-7000-8000-000000000001/draft',
			'/api/v1/api-keys',
			'/api/v1/instance/members',
			'/api/v1/instance/bootstrap',
			'/api/v1/signing/context'
		];
		for (const pathname of paths) {
			expect(isApiKeyAuthenticatedPath(pathname) && isApiKeyRejectedPath(pathname)).toBe(false);
		}
	});
});
