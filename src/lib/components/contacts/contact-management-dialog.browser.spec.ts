import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ContactManagementDialog from './contact-management-dialog.svelte';

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = (): void => undefined;
	const promise: Promise<T> = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function openCreateForm(
	dialog: ReturnType<Awaited<ReturnType<typeof render>>['getByRole']>
): Promise<void> {
	await dialog.getByRole('button', { name: 'Add contact' }).click();
	await expect.element(dialog.getByRole('heading', { name: 'Add contact' })).toBeVisible();
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
		await openCreateForm(dialog);
		await dialog.getByLabelText('Name').fill('Alice Example');
		await dialog.getByLabelText('Email').fill('alice@example.com');
		expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);

		await dialog.getByRole('button', { name: 'Create contact' }).click();

		await expect.element(dialog.getByRole('heading', { name: 'Manage contacts' })).toBeVisible();
		await expect.element(dialog.getByRole('cell', { name: 'Alice Example' })).toBeVisible();
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
	});

	it('opens a titled edit subview and returns to the list without stacking another dialog', async () => {
		const contact = {
			id: '01900000-0000-7000-8000-000000000001',
			name: 'Alice Example',
			email: 'alice@example.com',
			locale: 'en',
			version: 1,
			createdAt: '2026-09-17T00:00:00.000Z',
			updatedAt: '2026-09-17T00:00:00.000Z'
		};
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof globalThis.fetch>(async () =>
				jsonResponse({ items: [contact], nextCursor: null })
			)
		);

		const screen = await render(ContactManagementDialog, { props: { open: true } });
		const dialog = screen.getByRole('dialog');
		await expect.element(dialog.getByRole('cell', { name: 'Alice Example' })).toBeVisible();
		await dialog.getByRole('button', { name: 'Edit contact' }).click();
		await expect.element(dialog.getByRole('heading', { name: 'Edit contact' })).toBeVisible();
		await expect.element(dialog.getByLabelText('Name')).toHaveValue('Alice Example');
		expect(screen.getByRole('dialog').all()).toHaveLength(1);

		await dialog.getByRole('button', { name: 'Back to list' }).click();
		await expect.element(dialog.getByRole('heading', { name: 'Manage contacts' })).toBeVisible();
		await expect.element(dialog.getByRole('cell', { name: 'Alice Example' })).toBeVisible();
		expect(dialog.getByLabelText('Name').query()).toBeNull();
	});

	it('keeps entered values after a failed save and does not mark inputs invalid for a generic error', async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
			if (String(url) === '/api/v1/contacts' && init?.method === 'POST') {
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
			return jsonResponse({ items: [], nextCursor: null });
		});
		vi.stubGlobal('fetch', fetchMock);

		const screen = await render(ContactManagementDialog, { props: { open: true } });
		const dialog = screen.getByRole('dialog');
		await openCreateForm(dialog);
		await dialog.getByLabelText('Name').fill('Kept Name');
		await dialog.getByLabelText('Email').fill('kept@example.com');
		await dialog.getByRole('button', { name: 'Create contact' }).click();
		const formError = dialog.getByRole('alert');
		await expect.element(formError).toHaveTextContent('The result is not known.');
		expect(formError.element().closest('[data-slot="field"]')).toBeNull();
		await expect.element(dialog.getByLabelText('Name')).toHaveValue('Kept Name');
		await expect.element(dialog.getByLabelText('Email')).toHaveValue('kept@example.com');
		expect(dialog.getByLabelText('Name').element().getAttribute('aria-invalid')).not.toBe('true');
	});

	it('ignores Escape and the close control while a save is pending', async () => {
		const created = {
			id: '01900000-0000-7000-8000-000000000009',
			name: 'Pending',
			email: 'pending@example.com',
			locale: 'en',
			version: 1,
			createdAt: '2026-09-17T00:00:00.000Z',
			updatedAt: '2026-09-17T00:00:00.000Z'
		};
		const saveGate = deferred<Response>();
		let saved = false;
		const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
			if (String(url) === '/api/v1/contacts' && init?.method === 'POST') {
				saved = true;
				return saveGate.promise;
			}
			return jsonResponse({ items: saved ? [created] : [], nextCursor: null });
		});
		vi.stubGlobal('fetch', fetchMock);

		const screen = await render(ContactManagementDialog, { props: { open: true } });
		const dialog = screen.getByRole('dialog');
		await openCreateForm(dialog);
		await dialog.getByLabelText('Name').fill('Pending');
		await dialog.getByLabelText('Email').fill('pending@example.com');
		await dialog.getByRole('button', { name: 'Create contact' }).click();
		await expect.element(dialog.getByRole('button', { name: 'Create contact' })).toBeDisabled();
		await expect.element(dialog.getByRole('button', { name: 'Back to list' })).toBeDisabled();

		await userEvent.keyboard('{Escape}');
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog.getByRole('heading', { name: 'Add contact' })).toBeVisible();
		expect(dialog.element().querySelector('[data-slot="dialog-close"]')).toBeNull();
		await expect.element(dialog.getByLabelText('Name')).toHaveValue('Pending');

		saveGate.resolve(jsonResponse({ contact: created }, 201));
		await expect.element(dialog.getByRole('heading', { name: 'Manage contacts' })).toBeVisible();
		await expect.element(dialog.getByRole('cell', { name: 'Pending', exact: true })).toBeVisible();
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

	it('ignores Escape on the confirmation while a delete is pending and keeps the management Dialog open', async () => {
		const contact = {
			id: '01900000-0000-7000-8000-000000000001',
			name: 'Alice Example',
			email: 'alice@example.com',
			locale: 'en',
			version: 1,
			createdAt: '2026-09-17T00:00:00.000Z',
			updatedAt: '2026-09-17T00:00:00.000Z'
		};
		const deleteGate = deferred<Response>();
		let deleted = false;
		const fetchMock = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			if (init?.method === 'DELETE') {
				deleted = true;
				return deleteGate.promise;
			}
			return jsonResponse({ items: deleted ? [] : [contact], nextCursor: null });
		});
		vi.stubGlobal('fetch', fetchMock);

		const screen = await render(ContactManagementDialog, { props: { open: true } });
		const dialog = screen.getByRole('dialog');
		await expect.element(dialog.getByRole('cell', { name: 'Alice Example' })).toBeVisible();
		await dialog.getByRole('button', { name: 'Delete contact' }).click();
		const confirmation = screen.getByRole('alertdialog');
		await confirmation.getByRole('button', { name: 'Delete contact' }).click();
		await expect
			.element(confirmation.getByRole('button', { name: 'Delete contact' }))
			.toBeDisabled();

		await userEvent.keyboard('{Escape}');
		await expect.element(confirmation).toBeVisible();
		await expect.element(dialog).toBeVisible();

		deleteGate.resolve(
			jsonResponse({ deleted: { id: contact.id, deletedAt: '2026-09-17T00:01:00.000Z' } })
		);
		await expect
			.element(dialog.getByRole('cell', { name: 'Alice Example' }))
			.not.toBeInTheDocument();
	});

	it('ignores an older load-more response after a successful save reloads the list', async () => {
		const original = {
			id: '01900000-0000-7000-8000-000000000001',
			name: 'Original',
			email: 'original@example.com',
			locale: 'en',
			version: 1,
			createdAt: '2026-09-17T00:00:00.000Z',
			updatedAt: '2026-09-17T00:00:00.000Z'
		};
		const created = {
			...original,
			id: '01900000-0000-7000-8000-000000000002',
			name: 'Created',
			email: 'created@example.com'
		};
		const stale = {
			...original,
			id: '01900000-0000-7000-8000-000000000003',
			name: 'Stale page',
			email: 'stale@example.com'
		};
		const stalePage = deferred<Response>();
		let rootLists = 0;
		const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
			const href = String(url);
			if (href.includes('cursor=cursor-1')) return stalePage.promise;
			if (href === '/api/v1/contacts' && init?.method === 'POST') {
				return jsonResponse({ contact: created }, 201);
			}
			rootLists += 1;
			return rootLists === 1
				? jsonResponse({ items: [original], nextCursor: 'cursor-1' })
				: jsonResponse({ items: [original, created], nextCursor: null });
		});
		vi.stubGlobal('fetch', fetchMock);

		const screen = await render(ContactManagementDialog, { props: { open: true } });
		const dialog = screen.getByRole('dialog');
		await expect.element(dialog.getByRole('cell', { name: 'Original', exact: true })).toBeVisible();
		await dialog.getByRole('button', { name: 'Load more' }).click();
		await openCreateForm(dialog);
		await dialog.getByLabelText('Name').fill('Created');
		await dialog.getByLabelText('Email').fill('created@example.com');
		await dialog.getByRole('button', { name: 'Create contact' }).click();
		await expect.element(dialog.getByRole('cell', { name: 'Created', exact: true })).toBeVisible();

		stalePage.resolve(jsonResponse({ items: [stale], nextCursor: null }));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(dialog.element().textContent).not.toContain('Stale page');
	});

	it('does not restore a deleted contact from an older load-more response', async () => {
		const deleted = {
			id: '01900000-0000-7000-8000-000000000001',
			name: 'Delete me',
			email: 'delete@example.com',
			locale: 'en',
			version: 1,
			createdAt: '2026-09-17T00:00:00.000Z',
			updatedAt: '2026-09-17T00:00:00.000Z'
		};
		const retained = {
			...deleted,
			id: '01900000-0000-7000-8000-000000000002',
			name: 'Keep me',
			email: 'keep@example.com'
		};
		const stalePage = deferred<Response>();
		let rootLists = 0;
		const fetchMock = vi.fn<typeof globalThis.fetch>(async (url, init) => {
			const href = String(url);
			if (href.includes('cursor=cursor-1')) return stalePage.promise;
			if (init?.method === 'DELETE') {
				return jsonResponse({ deleted: { id: deleted.id, deletedAt: '2026-09-17T00:01:00.000Z' } });
			}
			rootLists += 1;
			return rootLists === 1
				? jsonResponse({ items: [deleted, retained], nextCursor: 'cursor-1' })
				: jsonResponse({ items: [retained], nextCursor: null });
		});
		vi.stubGlobal('fetch', fetchMock);

		const screen = await render(ContactManagementDialog, { props: { open: true } });
		const dialog = screen.getByRole('dialog');
		await expect
			.element(dialog.getByRole('cell', { name: 'Delete me', exact: true }))
			.toBeVisible();
		await dialog.getByRole('button', { name: 'Load more' }).click();
		await dialog.getByRole('button', { name: 'Delete contact' }).first().click();
		await screen.getByRole('alertdialog').getByRole('button', { name: 'Delete contact' }).click();
		await expect.element(dialog.getByRole('cell', { name: 'Keep me', exact: true })).toBeVisible();
		await expect
			.element(dialog.getByRole('cell', { name: 'Delete me', exact: true }))
			.not.toBeInTheDocument();

		stalePage.resolve(jsonResponse({ items: [deleted], nextCursor: null }));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(dialog.element().textContent).not.toContain('Delete me');
	});
});
