import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ContactManagementDialog from './contact-management-dialog.svelte';

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('contact management dialog', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('has an accessible title and creates only after the explicit submit action', async () => {
		const contact = {
			id: '01900000-0000-7000-8000-000000000001',
			name: 'Alice Example',
			email: 'alice@example.com',
			locale: 'en',
			version: 1,
			createdAt: '2026-09-17T00:00:00.000Z',
			updatedAt: '2026-09-17T00:00:00.000Z'
		};
		let saved = false;
		const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
			if (String(url) === '/api/v1/contacts' && init?.method === 'POST') {
				saved = true;
				return jsonResponse({ contact }, 201);
			}
			return jsonResponse({ items: saved ? [contact] : [], nextCursor: null });
		});
		vi.stubGlobal('fetch', fetchMock);

		const screen = await render(ContactManagementDialog, { props: { open: true } });
		const dialog = screen.getByRole('dialog');
		await expect.element(dialog.getByRole('heading', { name: 'Manage contacts' })).toBeVisible();
		expect(dialog.element().className).toContain('max-h-[calc(100svh-2rem)]');
		expect(dialog.element().className).toContain('overflow-y-auto');
		await dialog.getByLabelText('Name').fill('Alice Example');
		await dialog.getByLabelText('Email').fill('alice@example.com');
		expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

		await dialog.getByRole('button', { name: 'Create contact' }).click();

		await expect.element(dialog.getByRole('cell', { name: 'Alice Example' })).toBeVisible();
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
	});

	it('keeps delete errors inside the active confirmation and reuses its key until target change', async () => {
		const contact = {
			id: '01900000-0000-7000-8000-000000000001',
			name: 'Alice Example',
			email: 'alice@example.com',
			locale: 'en',
			version: 1,
			createdAt: '2026-09-17T00:00:00.000Z',
			updatedAt: '2026-09-17T00:00:00.000Z'
		};
		const deleteKeys: string[] = [];
		const fetchMock = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			if (init?.method === 'DELETE') {
				deleteKeys.push(new Headers(init.headers).get('idempotency-key') ?? '');
				return jsonResponse(
					{
						type: 'urn:signkit:problem:unavailable',
						title: 'Unavailable',
						status: 503,
						detail: 'The result is not known.'
					},
					503
				);
			}
			return jsonResponse({ items: [contact], nextCursor: null });
		});
		vi.stubGlobal('fetch', fetchMock);

		const screen = await render(ContactManagementDialog, { props: { open: true } });
		const dialog = screen.getByRole('dialog');
		await expect.element(dialog.getByRole('cell', { name: 'Alice Example' })).toBeVisible();
		await dialog.getByRole('button', { name: 'Delete contact' }).click();
		const confirmation = screen.getByRole('alertdialog');
		await confirmation.getByRole('button', { name: 'Delete contact' }).click();
		await expect
			.element(confirmation.getByRole('alert'))
			.toHaveTextContent('The result is not known.');
		await confirmation.getByRole('button', { name: 'Delete contact' }).click();

		expect(deleteKeys).toHaveLength(2);
		expect(deleteKeys[1]).toBe(deleteKeys[0]);

		await confirmation.getByRole('button', { name: 'Cancel' }).click();
		await dialog.getByRole('button', { name: 'Delete contact' }).click();
		await screen.getByRole('alertdialog').getByRole('button', { name: 'Delete contact' }).click();
		expect(deleteKeys).toHaveLength(3);
		expect(deleteKeys[2]).not.toBe(deleteKeys[0]);
	});
});
