import { describe, expect, it } from 'vitest';
import { localePreferenceRedirect, preferredRedirectLocale } from './locale-redirect';

describe('preferred redirect language', () => {
	it.each([
		['ja', 'en-US,en;q=0.9', 'ja'],
		['en', 'ja-JP,ja;q=0.9', 'en'],
		[undefined, 'ja-JP,en;q=0.9', 'ja'],
		[undefined, 'en-AU,ja;q=0.9', 'en'],
		[undefined, 'ja;q=0.4,en;q=0.8', 'en'],
		[undefined, 'fr-FR;q=1,ja;q=0.7', 'ja'],
		[undefined, 'ja;q=0.8,en;q=0.8', 'ja'],
		[undefined, 'JA-jp ; q=0.9, en;q=0.7', 'ja'],
		[undefined, 'ja;q=0,fr-FR', 'en'],
		[undefined, 'en;q=0,ja;q=0.5', 'ja'],
		[undefined, 'ja;q=1.1,en;q=0.8', 'en'],
		[undefined, 'ja;q=invalid,en;q=0.8', 'en'],
		[undefined, 'fr-FR,de-DE', 'en'],
		[undefined, '*', 'en'],
		[undefined, null, 'en'],
		['fr', 'ja-JP', 'ja']
	])('uses saved=%s and browser=%s → %s', (saved, browser, expected) => {
		expect(preferredRedirectLocale(saved, browser)).toBe(expected);
	});
});

function redirect(
	path: string,
	options: { method?: string; headers?: HeadersInit; saved?: string } = {}
) {
	const url = new URL(path, 'https://signkit.example');
	const request = new Request(url, {
		method: options.method ?? 'GET',
		headers: options.headers ?? { 'sec-fetch-dest': 'document', 'accept-language': 'ja-JP' }
	});
	return localePreferenceRedirect(url, request, options.saved);
}

describe('locale-less document redirect', () => {
	it('keeps paths, queries and encoded OAuth return targets', () => {
		const path = '/auth/login?return=%2Fen%2Fsettings%3Ftab%3Dmembers&state=opaque';
		const response = redirect(path);
		expect(response?.status).toBe(307);
		expect(response?.headers.get('location')).toBe(`/ja${path}`);
		expect(response?.headers.get('cache-control')).toBe('private, no-store');
		expect(response?.headers.get('vary')).toBe('Cookie, Accept-Language');
	});

	it('redirects the root without an extra trailing-slash hop', () => {
		expect(redirect('/?view=waiting')?.headers.get('location')).toBe('/ja?view=waiting');
	});

	it('accepts HEAD HTML navigation without Fetch Metadata headers', () => {
		expect(
			redirect('/', {
				method: 'HEAD',
				headers: { accept: 'text/html', 'accept-language': 'ja-JP' }
			})?.headers.get('location')
		).toBe('/ja');
	});

	it.each([
		'/en',
		'/ja/settings',
		'/s/opaque',
		'/sign/envelope-id',
		'/c/opaque',
		'/_app/chunk.js',
		'/favicon.svg',
		'/settings/__data.json'
	])('leaves explicit language, recipient and asset URL %s untouched', (path) => {
		expect(redirect(path)).toBeNull();
	});

	it.each(['POST', 'PUT', 'DELETE'])('does not redirect %s mutations', (method) => {
		expect(redirect('/settings', { method })).toBeNull();
	});

	const nonNavigationHeaders: Record<string, string>[] = [
		{},
		{ accept: 'application/json' },
		{ 'sec-fetch-dest': 'empty', accept: 'text/html' },
		{ 'sec-fetch-dest': 'script' }
	];
	it.each(nonNavigationHeaders)('does not redirect non-navigation requests: %j', (headers) => {
		expect(redirect('/settings', { headers })).toBeNull();
	});
});
