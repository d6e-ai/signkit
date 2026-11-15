import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { cookieName } from '$lib/paraglide/runtime';
import { handleLocale } from './hooks.server';

function event(path: string, saved?: string): RequestEvent {
	const url = new URL(path, 'https://signkit.example');
	return {
		url,
		request: new Request(url, {
			headers: { 'sec-fetch-dest': 'document', 'accept-language': 'ja-JP' }
		}),
		cookies: { get: (name: string) => (name === cookieName ? saved : undefined) }
	} as unknown as RequestEvent;
}

describe('application locale redirect hook', () => {
	it('chooses the browser language before invoking Paraglide for a locale-less page', async () => {
		const resolve = vi.fn(async () => new Response('resolved'));
		const response = await handleLocale({ event: event('/settings?tab=members'), resolve });
		expect(response.status).toBe(307);
		expect(response.headers.get('location')).toBe('/ja/settings?tab=members');
		expect(resolve).not.toHaveBeenCalled();
	});

	it('uses the existing SignKit language cookie ahead of the browser', async () => {
		const resolve = vi.fn(async () => new Response('resolved'));
		const response = await handleLocale({ event: event('/', 'en'), resolve });
		expect(response.headers.get('location')).toBe('/en');
	});

	it.each(['/en/settings', '/ja/settings'])(
		'passes an explicitly localized page through the existing middleware: %s',
		async (path) => {
			const resolve = vi.fn(async () => new Response('resolved'));
			const response = await handleLocale({ event: event(path, 'en'), resolve });
			expect(response.status).toBe(200);
			expect(resolve).toHaveBeenCalledOnce();
		}
	);

	it.each([
		'/api/v1/instance/members',
		'/.well-known/openid-configuration',
		'/health',
		'/ready',
		'/webhooks/receive',
		'/agent/tasks'
	])('keeps machine route %s outside locale preference handling', async (path) => {
		const resolve = vi.fn(async () => new Response('resolved'));
		const response = await handleLocale({ event: event(path, 'ja'), resolve });
		expect(response.status).toBe(200);
		expect(response.headers.has('location')).toBe(false);
		expect(resolve).toHaveBeenCalledOnce();
	});
});
