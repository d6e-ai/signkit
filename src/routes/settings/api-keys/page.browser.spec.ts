import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ApiKeysPage from './+page.svelte';
import '../../layout.css';

const { gotoMock } = vi.hoisted(() => ({ gotoMock: vi.fn() }));

vi.mock('$app/navigation', () => ({
	goto: gotoMock
}));

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

interface MemberFixture {
	userId: string;
	role: 'owner' | 'admin' | 'member';
	status: 'active' | 'suspended';
}

function member(overrides: Partial<MemberFixture> = {}): MemberFixture & {
	createdAt: string;
	updatedAt: string;
} {
	return {
		userId: 'user-1',
		role: 'owner',
		status: 'active',
		createdAt: '2026-09-01T00:00:00.000Z',
		updatedAt: '2026-09-01T00:00:00.000Z',
		...overrides
	};
}

function meResponse(memberData: ReturnType<typeof member> | null): Response {
	return jsonResponse({ bootstrapped: true, member: memberData });
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> | undefined {
	if (typeof init?.body !== 'string') return undefined;
	try {
		return JSON.parse(init.body) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = (): void => undefined;
	const promise: Promise<T> = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function openCreateKeyDialog(
	screen: Awaited<ReturnType<typeof render>>
): Promise<ReturnType<Awaited<ReturnType<typeof render>>['getByRole']>> {
	await screen.getByRole('button', { name: 'Create API key' }).click();
	const dialog = screen.getByRole('dialog');
	await expect.element(dialog).toBeVisible();
	return dialog;
}

describe('settings api-keys page in the browser', () => {
	beforeEach(async () => {
		await page.viewport(1280, 844);
		vi.restoreAllMocks();
		gotoMock.mockReset();
	});

	it('gives an active plain member their own API keys, without redirecting away', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'plain-member', role: 'member' }));
			}
			if (urlStr.includes('/api/v1/api-keys')) {
				return jsonResponse({ page: { items: [], nextCursor: null } });
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(ApiKeysPage);
		await expect.element(screen.getByText('Your API keys')).toBeVisible();
		expect(gotoMock).not.toHaveBeenCalled();
	});

	it('redirects a suspended member back to /settings', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () =>
				meResponse(member({ userId: 'suspended-user', role: 'member', status: 'suspended' }))
			);
		vi.stubGlobal('fetch', mockFetch);

		await render(ApiKeysPage);
		await vi.waitFor(() =>
			expect(gotoMock).toHaveBeenCalledWith(expect.stringMatching(/\/settings$/))
		);
	});

	it('renders an unrevoked but past-expiry API key as Expired', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
			}
			if (urlStr.includes('/api/v1/api-keys')) {
				return jsonResponse({
					page: {
						items: [
							{
								id: 'key-expired',
								name: 'Old Key',
								keyPrefix: 'signkit_old_',
								scopes: ['envelopes:read'],
								createdAt: '1999-01-01T00:00:00.000Z',
								expiresAt: '2000-01-01T00:00:00.000Z',
								lastUsedAt: null,
								revokedAt: null
							}
						],
						nextCursor: null
					}
				});
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(ApiKeysPage);
		await expect.element(screen.getByText('Old Key')).toBeVisible();
		await expect.element(screen.getByText('Expired', { exact: true })).toBeVisible();
	});

	it('omits expiresAt from the create request when the expiry field is left blank', async () => {
		let createBody: Record<string, unknown> | undefined;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.includes('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/api-keys') && init?.method === 'POST') {
					createBody = parseBody(init);
					return jsonResponse(
						{
							apiKey: {
								id: 'key-1',
								name: (createBody?.name as string) ?? 'Key',
								keyPrefix: 'signkit_abc_',
								scopes: createBody?.scopes ?? [],
								createdAt: '2026-09-04T00:00:00.000Z',
								expiresAt: '2026-12-04T00:00:00.000Z',
								lastUsedAt: null,
								revokedAt: null
							},
							token: 'signkit_plaintext_secret'
						},
						201
					);
				}
				if (urlStr.includes('/api/v1/api-keys')) {
					return jsonResponse({ page: { items: [], nextCursor: null } });
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(ApiKeysPage);
		const dialog = await openCreateKeyDialog(screen);

		await dialog.getByLabelText('Key name').fill('My Key');
		await dialog.getByLabelText('Expires in (days, optional)').fill('');
		await dialog.getByRole('checkbox').first().click();
		await dialog.getByRole('button', { name: 'Create key' }).click();

		await expect.element(screen.getByText('One-time API key secret')).toBeVisible();
		expect(createBody).toBeDefined();
		expect(createBody).not.toHaveProperty('expiresAt');
	});

	it('applies a clock-skew safety buffer so a max-length expiry never exceeds the server bound', async () => {
		let createBody: Record<string, unknown> | undefined;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.includes('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/api-keys') && init?.method === 'POST') {
					createBody = parseBody(init);
					return jsonResponse(
						{
							apiKey: {
								id: 'key-1',
								name: (createBody?.name as string) ?? 'Key',
								keyPrefix: 'signkit_abc_',
								scopes: createBody?.scopes ?? [],
								createdAt: '2026-09-04T00:00:00.000Z',
								expiresAt: (createBody?.expiresAt as string) ?? '2026-12-04T00:00:00.000Z',
								lastUsedAt: null,
								revokedAt: null
							},
							token: 'signkit_plaintext_secret'
						},
						201
					);
				}
				if (urlStr.includes('/api/v1/api-keys')) {
					return jsonResponse({ page: { items: [], nextCursor: null } });
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(ApiKeysPage);
		const dialog = await openCreateKeyDialog(screen);

		await dialog.getByLabelText('Key name').fill('Max Expiry Key');
		await dialog.getByLabelText('Expires in (days, optional)').fill('365');
		await dialog.getByRole('checkbox').first().click();
		await dialog.getByRole('button', { name: 'Create key' }).click();

		await expect.element(screen.getByText('One-time API key secret')).toBeVisible();
		expect(createBody?.expiresAt).toBeTypeOf('string');
		const maxAllowedMs = Date.now() + 365 * 24 * 60 * 60 * 1000;
		const requestedMs = Date.parse(createBody!.expiresAt as string);
		expect(requestedMs).toBeLessThan(maxAllowedMs);
		expect(maxAllowedMs - requestedMs).toBeLessThan(10 * 60 * 1000);
		expect(maxAllowedMs - requestedMs).toBeGreaterThan(0);
	});

	it('shows feedback when copying the revealed secret to the clipboard fails', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.includes('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/api-keys') && init?.method === 'POST') {
					return jsonResponse(
						{
							apiKey: {
								id: 'key-1',
								name: 'My Key',
								keyPrefix: 'signkit_abc_',
								scopes: ['envelopes:read'],
								createdAt: '2026-09-04T00:00:00.000Z',
								expiresAt: '2026-12-04T00:00:00.000Z',
								lastUsedAt: null,
								revokedAt: null
							},
							token: 'signkit_plaintext_secret'
						},
						201
					);
				}
				if (urlStr.includes('/api/v1/api-keys')) {
					return jsonResponse({ page: { items: [], nextCursor: null } });
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);
		vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

		const screen = await render(ApiKeysPage);
		const dialog = await openCreateKeyDialog(screen);

		await dialog.getByLabelText('Key name').fill('My Key');
		await dialog.getByRole('checkbox').first().click();
		await dialog.getByRole('button', { name: 'Create key' }).click();

		await expect.element(screen.getByText('One-time API key secret')).toBeVisible();
		await screen.getByRole('button', { name: 'Copy secret' }).click();
		await expect
			.element(screen.getByText('Could not copy to clipboard. Copy the value manually.'))
			.toBeVisible();
	});

	it('never carries a stale “Copied!” indicator onto a newly revealed API key secret', async () => {
		let createCount = 0;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.includes('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/api-keys') && init?.method === 'POST') {
					createCount += 1;
					const body = parseBody(init);
					return jsonResponse(
						{
							apiKey: {
								id: `key-${createCount}`,
								name: (body?.name as string) ?? 'Key',
								keyPrefix: 'signkit_abc_',
								scopes: body?.scopes ?? [],
								createdAt: '2026-09-04T00:00:00.000Z',
								expiresAt: '2026-12-04T00:00:00.000Z',
								lastUsedAt: null,
								revokedAt: null
							},
							token: `signkit_plaintext_secret_${createCount}`
						},
						201
					);
				}
				if (urlStr.includes('/api/v1/api-keys')) {
					return jsonResponse({ page: { items: [], nextCursor: null } });
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);
		vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

		const screen = await render(ApiKeysPage);
		let dialog = await openCreateKeyDialog(screen);

		await dialog.getByLabelText('Key name').fill('First Key');
		await dialog.getByRole('checkbox').first().click();
		await dialog.getByRole('button', { name: 'Create key' }).click();
		await expect.element(screen.getByText('signkit_plaintext_secret_1')).toBeVisible();

		await screen.getByRole('button', { name: 'Copy secret' }).click();
		await expect.element(screen.getByRole('button', { name: 'Copied!' })).toBeVisible();

		dialog = await openCreateKeyDialog(screen);
		await dialog.getByLabelText('Key name').fill('Second Key');
		await dialog.getByRole('checkbox').first().click();
		await dialog.getByRole('button', { name: 'Create key' }).click();
		await expect.element(screen.getByText('signkit_plaintext_secret_2')).toBeVisible();

		expect(screen.getByRole('button', { name: 'Copied!' }).query()).toBeNull();
		await expect.element(screen.getByRole('button', { name: 'Copy secret' })).toBeVisible();
	});

	it('keeps the revealed API key secret intact when a follow-up create fails or discloses no secret', async () => {
		let createCount = 0;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/api-keys') && init?.method === 'POST') {
					createCount += 1;
					if (createCount === 2) {
						return problemResponse(503, 'The API key operation could not be completed.');
					}
					const body = parseBody(init);
					const apiKey = {
						id: `key-${createCount}`,
						name: (body?.name as string) ?? 'Key',
						keyPrefix: 'signkit_abc_',
						scopes: body?.scopes ?? [],
						createdAt: '2026-09-04T00:00:00.000Z',
						expiresAt: '2026-12-04T00:00:00.000Z',
						lastUsedAt: null,
						revokedAt: null
					};
					return createCount === 3
						? jsonResponse({ apiKey }, 200, { 'idempotency-replayed': 'true' })
						: jsonResponse({ apiKey, token: `signkit_plaintext_secret_${createCount}` }, 201);
				}
				if (urlStr.includes('/api/v1/api-keys')) {
					return jsonResponse({ page: { items: [], nextCursor: null } });
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(ApiKeysPage);
		let dialog = await openCreateKeyDialog(screen);

		await dialog.getByLabelText('Key name').fill('First Key');
		await dialog.getByRole('checkbox').first().click();
		await dialog.getByRole('button', { name: 'Create key' }).click();
		await expect.element(screen.getByText('signkit_plaintext_secret_1')).toBeVisible();
		await expect.element(screen.getByText('For “First Key” — key key-1')).toBeVisible();
		await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();

		dialog = await openCreateKeyDialog(screen);
		await dialog.getByLabelText('Key name').fill('Second Key');
		await dialog.getByRole('checkbox').first().click();
		await dialog.getByRole('button', { name: 'Create key' }).click();
		await expect
			.element(dialog.getByText('The API key operation could not be completed.'))
			.toBeVisible();
		await expect.element(screen.getByText('signkit_plaintext_secret_1')).toBeVisible();
		await expect.element(screen.getByText('For “First Key” — key key-1')).toBeVisible();
		await expect.element(dialog.getByLabelText('Key name')).toHaveValue('Second Key');

		await dialog.getByRole('button', { name: 'Create key' }).click();
		await expect.element(screen.getByText('signkit_plaintext_secret_1')).toBeVisible();
		await expect.element(screen.getByText('For “First Key” — key key-1')).toBeVisible();
		expect(createCount).toBe(3);
	});

	it('surfaces a generic create failure as a form-level Alert and does not mark the key name invalid', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.includes('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/api-keys') && init?.method === 'POST') {
					return problemResponse(400, 'Key name already in use.');
				}
				if (urlStr.includes('/api/v1/api-keys')) {
					return jsonResponse({ page: { items: [], nextCursor: null } });
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(ApiKeysPage);
		const dialog = await openCreateKeyDialog(screen);

		await dialog.getByLabelText('Key name').fill('Dup Key');
		await dialog.getByRole('checkbox').first().click();
		await dialog.getByRole('button', { name: 'Create key' }).click();
		const formError = dialog.getByRole('alert');
		await expect.element(formError).toHaveTextContent('Key name already in use.');
		expect(formError.element().closest('[data-slot="field"]')).toBeNull();
		const nameInput = dialog.getByLabelText('Key name');
		expect(nameInput.element().getAttribute('aria-invalid')).not.toBe('true');
		await expect.element(nameInput).toHaveValue('Dup Key');
		await userEvent.keyboard('{Escape}');
		await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
		const reopened = await openCreateKeyDialog(screen);
		await expect.element(reopened.getByLabelText('Key name')).toHaveValue('');
		await expect.element(reopened.getByRole('alert')).not.toBeInTheDocument();
		await expect.element(reopened.getByRole('checkbox').first()).not.toBeChecked();
	});

	it('dismisses the revealed API-key secret via its dismiss action', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.includes('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/api-keys') && init?.method === 'POST') {
					return jsonResponse(
						{
							apiKey: {
								id: 'key-dismiss',
								name: 'Dismiss Key',
								keyPrefix: 'signkit_abc_',
								scopes: ['envelopes:read'],
								createdAt: '2026-09-04T00:00:00.000Z',
								expiresAt: '2026-12-04T00:00:00.000Z',
								lastUsedAt: null,
								revokedAt: null
							},
							token: 'signkit_dismiss_me'
						},
						201
					);
				}
				if (urlStr.includes('/api/v1/api-keys')) {
					return jsonResponse({ page: { items: [], nextCursor: null } });
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(ApiKeysPage);
		const dialog = await openCreateKeyDialog(screen);

		await dialog.getByLabelText('Key name').fill('Dismiss Key');
		await dialog.getByRole('checkbox').first().click();
		await dialog.getByRole('button', { name: 'Create key' }).click();
		await expect.element(screen.getByText('signkit_dismiss_me')).toBeVisible();
		await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();

		await screen.getByRole('button', { name: 'Done' }).click();
		expect(screen.getByText('signkit_dismiss_me').query()).toBeNull();
	});

	it('keeps the revealed secret readable at 390px after the create Dialog closes', async () => {
		await page.viewport(390, 844);
		const secret = `signkit_${'a'.repeat(64)}`;
		const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.includes('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/api-keys') && init?.method === 'POST') {
					return jsonResponse(
						{
							apiKey: {
								id: 'key-retain',
								name: 'Retain Key',
								keyPrefix: 'signkit_abc_',
								scopes: ['envelopes:read'],
								createdAt: '2026-09-04T00:00:00.000Z',
								expiresAt: '2026-12-04T00:00:00.000Z',
								lastUsedAt: null,
								revokedAt: null
							},
							token: secret
						},
						201
					);
				}
				if (urlStr.includes('/api/v1/api-keys')) {
					return jsonResponse({ page: { items: [], nextCursor: null } });
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(ApiKeysPage);
		const dialog = await openCreateKeyDialog(screen);
		await dialog.getByLabelText('Key name').fill('Retain Key');
		await dialog.getByRole('checkbox').first().click();
		await dialog.getByRole('button', { name: 'Create key' }).click();
		await expect.element(screen.getByText(secret, { exact: true })).toBeVisible();
		await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
		await expect.element(screen.getByText('One-time API key secret')).toBeVisible();
		const metadata = screen.getByText('For “Retain Key” — key key-retain').element();
		expect(metadata.getBoundingClientRect().width).toBeGreaterThan(200);
		expect(metadata.getBoundingClientRect().right).toBeLessThanOrEqual(390);
		const value = screen.getByText(secret, { exact: true }).element();
		expect(value.getBoundingClientRect().width).toBeGreaterThan(200);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
		await screen.getByRole('button', { name: 'Copy secret' }).click();
		expect(copy).toHaveBeenCalledWith(secret);
		await page.screenshot({ fullPage: true });
	});

	it('keeps complete API-key metadata readable in a scrollable details overlay at 390px', async () => {
		await page.viewport(390, 844);
		const keyName = 'MobileKey'.repeat(12);
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
			}
			if (urlStr.includes('/api/v1/api-keys')) {
				return jsonResponse({
					page: {
						items: [
							{
								id: 'key-details',
								name: keyName,
								keyPrefix: 'signkit_mob_',
								scopes: ['envelopes:read', 'drafts:write'],
								createdAt: '2026-09-04T00:00:00.000Z',
								expiresAt: '2026-12-04T00:00:00.000Z',
								lastUsedAt: null,
								revokedAt: null
							}
						],
						nextCursor: null
					}
				});
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(ApiKeysPage);
		await expect.element(screen.getByText(keyName)).toBeVisible();
		await screen.getByRole('button', { name: 'Details' }).click();
		const details = screen.getByRole('dialog');
		await expect.element(details.getByRole('heading', { name: 'API key details' })).toBeVisible();
		await expect.element(details.getByText('key-details')).toBeVisible();
		await expect.element(details.getByText('envelopes:read')).toBeVisible();
		await expect.element(details.getByText('drafts:write')).toBeVisible();
		await expect.element(details.getByText('Never')).toBeVisible();
		const expiry = details.element().querySelector('time[datetime="2026-12-04T00:00:00.000Z"]');
		expect(expiry?.textContent).toBe(
			new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
				new Date('2026-12-04T00:00:00.000Z')
			)
		);
		const overlay = details.element() as HTMLElement;
		expect(window.getComputedStyle(overlay).overflowY).toBe('auto');
		expect(overlay.scrollWidth).toBeLessThanOrEqual(overlay.clientWidth);
		await expect
			.poll(() => details.getByText(keyName).element().getBoundingClientRect().left)
			.toBeGreaterThanOrEqual(0);
		await expect
			.poll(() => details.getByText(keyName).element().getBoundingClientRect().right)
			.toBeLessThanOrEqual(390);
		details.getByText('Never').element().scrollIntoView({ block: 'nearest' });
		await page.screenshot({ fullPage: true });
	});

	it('ignores Escape and the close control while API-key creation is pending', async () => {
		const createGate = deferred<Response>();
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.includes('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/api-keys') && init?.method === 'POST') {
					return createGate.promise;
				}
				if (urlStr.includes('/api/v1/api-keys')) {
					return jsonResponse({ page: { items: [], nextCursor: null } });
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(ApiKeysPage);
		const dialog = await openCreateKeyDialog(screen);
		await dialog.getByLabelText('Key name').fill('Pending Key');
		await dialog.getByRole('checkbox').first().click();
		await dialog.getByRole('button', { name: 'Create key' }).click();
		await expect.element(dialog.getByRole('button', { name: 'Creating key…' })).toBeDisabled();

		await userEvent.keyboard('{Escape}');
		await expect.element(dialog).toBeVisible();
		expect(dialog.element().querySelector('[data-slot="dialog-close"]')).toBeNull();
		await expect.element(dialog.getByLabelText('Key name')).toHaveValue('Pending Key');

		createGate.resolve(
			jsonResponse(
				{
					apiKey: {
						id: 'key-pending',
						name: 'Pending Key',
						keyPrefix: 'signkit_abc_',
						scopes: ['envelopes:read'],
						createdAt: '2026-09-04T00:00:00.000Z',
						expiresAt: '2026-12-04T00:00:00.000Z',
						lastUsedAt: null,
						revokedAt: null
					},
					token: 'signkit_pending_secret'
				},
				201
			)
		);
		await expect.element(screen.getByText('signkit_pending_secret')).toBeVisible();
	});
});
