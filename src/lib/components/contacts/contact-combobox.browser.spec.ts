import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { userEvent } from 'vitest/browser';
import ContactCombobox from './contact-combobox.svelte';

const contact = {
	id: '01900000-0000-7000-8000-000000000001',
	name: 'Alice Example',
	email: 'alice@example.com',
	locale: 'ja' as const,
	version: 1,
	createdAt: '2026-09-17T00:00:00.000Z',
	updatedAt: '2026-09-17T00:00:00.000Z'
};

function jsonResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

describe('contact combobox', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('searches without putting personal text in the URL, supports selection, and restores focus', async () => {
		const selected = vi.fn();
		const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
			if (String(url) === '/api/v1/contacts/search' && init?.method === 'POST') {
				return jsonResponse({ items: [contact], nextCursor: null });
			}
			return jsonResponse({ items: [], nextCursor: null });
		});
		vi.stubGlobal('fetch', fetchMock);

		const screen = await render(ContactCombobox, {
			props: { label: 'Choose contact', onSelect: selected }
		});
		const trigger = screen.getByRole('combobox', { name: 'Choose contact' });
		await trigger.click();
		const search = screen.getByRole('combobox').nth(1);
		expect(search.element().getAttribute('aria-label')).toBe('Search contacts');
		await search.fill('alice@example.com');
		await expect.element(screen.getByText('Alice Example')).toBeVisible();
		await userEvent.keyboard('{ArrowDown}{Enter}');

		expect(selected).toHaveBeenCalledWith(contact);
		expect(document.activeElement).toBe(trigger.element());
		const searchCall = fetchMock.mock.calls.find(
			([url, init]) => String(url) === '/api/v1/contacts/search' && init?.method === 'POST'
		);
		expect(searchCall).toBeDefined();
		expect(String(searchCall?.[0])).not.toContain('alice');
		expect(JSON.parse(searchCall?.[1]?.body as string)).toEqual({
			query: 'alice@example.com',
			limit: 25
		});
	});
});
