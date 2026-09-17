import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ApiKeysPage from './+page.svelte';

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

describe('settings api-keys page in the browser', () => {
	beforeEach(() => {
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

		await screen.getByLabelText('Key name').fill('My Key');
		await screen.getByLabelText('Expires in (days, optional)').fill('');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();

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

		await screen.getByLabelText('Key name').fill('Max Expiry Key');
		await screen.getByLabelText('Expires in (days, optional)').fill('365');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();

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

		await screen.getByLabelText('Key name').fill('My Key');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();

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

		await screen.getByLabelText('Key name').fill('First Key');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();
		await expect.element(screen.getByText('signkit_plaintext_secret_1')).toBeVisible();

		await screen.getByRole('button', { name: 'Copy secret' }).click();
		await expect.element(screen.getByRole('button', { name: 'Copied!' })).toBeVisible();

		await screen.getByLabelText('Key name').fill('Second Key');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();
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

		await screen.getByLabelText('Key name').fill('First Key');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();
		await expect.element(screen.getByText('signkit_plaintext_secret_1')).toBeVisible();
		await expect.element(screen.getByText('For “First Key” — key key-1')).toBeVisible();

		await screen.getByLabelText('Key name').fill('Second Key');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();
		await expect
			.element(screen.getByText('The API key operation could not be completed.'))
			.toBeVisible();
		await expect.element(screen.getByText('signkit_plaintext_secret_1')).toBeVisible();
		await expect.element(screen.getByText('For “First Key” — key key-1')).toBeVisible();

		await screen.getByRole('button', { name: 'Create key' }).click();
		await expect.element(screen.getByText('signkit_plaintext_secret_1')).toBeVisible();
		await expect.element(screen.getByText('For “First Key” — key key-1')).toBeVisible();
		expect(createCount).toBe(3);
	});

	it('associates a create failure FieldError inside its invalid Field with data-invalid and aria-invalid', async () => {
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

		await screen.getByLabelText('Key name').fill('Dup Key');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();
		const fieldError = screen.getByText('Key name already in use.');
		await expect.element(fieldError).toBeVisible();
		const field = fieldError.element().closest('[data-slot="field"]');
		expect(field).not.toBeNull();
		expect(field?.getAttribute('data-invalid')).not.toBeNull();
		const nameInput = screen.getByLabelText('Key name');
		expect(nameInput.element().getAttribute('aria-invalid')).toBe('true');
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

		await screen.getByLabelText('Key name').fill('Dismiss Key');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();
		await expect.element(screen.getByText('signkit_dismiss_me')).toBeVisible();

		await screen.getByRole('alert').getByRole('button').first().click();
		expect(screen.getByText('signkit_dismiss_me').query()).toBeNull();
	});
});
