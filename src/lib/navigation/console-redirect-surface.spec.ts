import { describe, expect, it } from 'vitest';
import { isConsoleRedirectedPagePath } from './console-redirect-surface';

describe('isConsoleRedirectedPagePath', () => {
	it('matches the operator pages with or without a locale', () => {
		for (const pathname of [
			'/',
			'',
			'/ja',
			'/en/',
			'/envelopes',
			'/envelopes/new',
			'/ja/envelopes/01900000-0000-7000-8000-000000000001',
			'/settings',
			'/settings/members',
			'/en/settings/api-keys',
			'/setup',
			'/signed-out',
			'/settings/__data.json'
		]) {
			expect(isConsoleRedirectedPagePath(pathname)).toBe(true);
		}
	});

	it('leaves recipient pages, invitation acceptance, sign-in, the API, and assets alone', () => {
		for (const pathname of [
			'/s/token',
			'/sign',
			'/ja/sign/01900000-0000-7000-8000-000000000001',
			'/c/token/view',
			'/invitations/accept',
			'/en/invitations/accept',
			'/auth/login',
			'/auth/callback',
			'/api/v1/dashboard',
			'/favicon.ico',
			'/_app/immutable/start.js',
			'/settingsx',
			'/no-such-page'
		]) {
			expect(isConsoleRedirectedPagePath(pathname)).toBe(false);
		}
	});
});
