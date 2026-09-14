import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SetupPage from './+page.svelte';

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

function problemResponse(status: number, detail: string): Response {
	return new Response(
		JSON.stringify({
			type: 'urn:signkit:problem:test',
			title: 'Error',
			status,
			detail,
			instance: '/test'
		}),
		{ status, headers: { 'content-type': 'application/problem+json' } }
	);
}

describe('setup first-admin page in browser', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('shows the claim form once the instance is confirmed unbootstrapped', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			if (String(url).includes('/api/v1/instance/members/me')) {
				return jsonResponse({ bootstrapped: false, member: null });
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SetupPage);

		await expect.element(screen.getByRole('button', { name: 'Claim owner role' })).toBeVisible();
		expect(screen.getByText('Checking instance status…').query()).toBeNull();
	});

	it('never presents a bootstrap-secret field anywhere on the page', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () => jsonResponse({ bootstrapped: false, member: null }));
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SetupPage);
		await expect.element(screen.getByRole('button', { name: 'Claim owner role' })).toBeVisible();
		expect(screen.getByLabelText('Bootstrap secret').query()).toBeNull();
	});

	it('surfaces a retryable claim failure without navigating away', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.includes('/api/v1/instance/members/me')) {
					return jsonResponse({ bootstrapped: false, member: null });
				}
				if (urlStr.includes('/api/v1/instance/bootstrap') && init?.method === 'POST') {
					return problemResponse(503, 'The bootstrap operation could not be completed.');
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SetupPage);
		await screen.getByRole('button', { name: 'Claim owner role' }).click();

		await expect
			.element(screen.getByText('The bootstrap operation could not be completed.'))
			.toBeVisible();
		// A non-409 failure must never navigate away: the claim form has to stay
		// on screen so the caller can retry.
		await expect.element(screen.getByRole('button', { name: 'Claim owner role' })).toBeVisible();
	});
});
