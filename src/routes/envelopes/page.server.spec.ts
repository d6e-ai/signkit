import { isRedirect, redirect } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import { load } from './+page.server';

afterEach(() => overwriteGetLocale(() => 'en'));

describe('legacy envelope collection redirect', () => {
	it.each(['en', 'ja'] as const)(
		'preserves %s locale and the complete worklist query',
		async (locale) => {
			overwriteGetLocale(() => locale);
			const url = new URL(
				`https://signkit.example/${locale}/envelopes?view=waiting&q=%E7%94%B0%E4%B8%AD%2B%25&cursor=abc_123&limit=25`
			);
			const parent = vi.fn(async () => ({}));
			const setHeaders = vi.fn();
			const event = { parent, setHeaders, url } as unknown as Parameters<typeof load>[0];
			await expect(load(event)).rejects.toMatchObject({
				status: 308,
				location: `/${locale}/${url.search}`
			});
			expect(parent).toHaveBeenCalledOnce();
			expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
		}
	);

	it('keeps query validation with the canonical loader rather than dropping unknown arguments', async () => {
		overwriteGetLocale(() => 'en');
		const url = new URL(
			'https://signkit.example/envelopes?q=first&q=second&return=https://other.example'
		);
		try {
			await load({ parent: async () => ({}), setHeaders: vi.fn(), url } as unknown as Parameters<
				typeof load
			>[0]);
			throw new Error('Expected a redirect');
		} catch (error) {
			if (!isRedirect(error)) throw error;
			const destination = new URL(error.location, url);
			expect(destination.origin).toBe(url.origin);
			expect(destination.pathname).toBe('/en/');
			expect(destination.search).toBe(url.search);
		}
	});

	it('lets a layout authorization failure win before producing a collection redirect', async () => {
		const setHeaders = vi.fn();
		const event = {
			parent: async () => redirect(302, '/en/auth/login'),
			setHeaders,
			url: new URL('https://signkit.example/envelopes')
		} as unknown as Parameters<typeof load>[0];
		await expect(load(event)).rejects.toMatchObject({ status: 302, location: '/en/auth/login' });
		expect(setHeaders).not.toHaveBeenCalled();
	});
});
