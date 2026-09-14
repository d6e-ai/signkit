import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SettingsPage from './+page.svelte';

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

describe('settings instance-management page in browser', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('renders members, invitations, and API keys tabs for an active owner', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
			}
			if (urlStr.includes('/api/v1/instance/members')) {
				return jsonResponse({
					members: [
						member({ userId: 'owner-user-1', role: 'owner' }),
						member({ userId: 'member-user-2', role: 'member' })
					],
					nextCursor: null
				});
			}
			if (urlStr.includes('/api/v1/instance/invitations')) {
				return jsonResponse({
					invitations: [
						{
							id: '01910000-0000-7000-8000-000000000001',
							role: 'member',
							status: 'pending',
							invitedByUserId: 'owner-user-1',
							createdAt: '2026-09-03T00:00:00.000Z',
							expiresAt: '2026-09-10T00:00:00.000Z',
							acceptedAt: null,
							acceptedByUserId: null,
							revokedAt: null,
							revokedByUserId: null
						}
					],
					nextCursor: null
				});
			}
			if (urlStr.includes('/api/v1/api-keys')) {
				return jsonResponse({
					page: {
						items: [
							{
								id: '01910000-0000-7000-8000-000000000002',
								name: 'Test Deploy Key',
								keyPrefix: 'signkit_ci_',
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

		const screen = await render(SettingsPage);

		await expect.element(screen.getByRole('tab', { name: 'Members' })).toBeVisible();
		await expect.element(screen.getByRole('tab', { name: 'Invitations' })).toBeVisible();
		await expect.element(screen.getByRole('tab', { name: 'API keys' })).toBeVisible();
		await expect.element(screen.getByText('owner-user-1')).toBeVisible();
		await expect.element(screen.getByText('member-user-2')).toBeVisible();

		await screen.getByRole('tab', { name: 'Invitations' }).click();
		await expect.element(screen.getByText('01910000-0000-7000-8000-000000000001')).toBeVisible();

		await screen.getByRole('tab', { name: 'API keys' }).click();
		await expect.element(screen.getByText('Test Deploy Key')).toBeVisible();
		await expect.element(screen.getByText('signkit_ci_…')).toBeVisible();
	});

	it('renders auth required state with sign in action on 401', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () => problemResponse(401, 'Authentication required'));
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await expect.element(screen.getByText('Authentication required')).toBeVisible();
	});

	it('falls through to the invitation-accept card on the unreachable unbootstrapped state', async () => {
		// The root layout guard redirects an unbootstrapped instance to /setup
		// before this page can render, so this branch is dead in production. The
		// bootstrap claim card lives on /setup now, not here; member is always
		// null pre-bootstrap, so this page shows the same card as any non-member.
		const mockFetch = vi
			.fn()
			.mockImplementation(async () => jsonResponse({ bootstrapped: false, member: null }));
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await expect
			.element(
				screen.getByText(
					'You are not currently a member of this instance. Enter an invitation token to join.'
				)
			)
			.toBeVisible();
		expect(screen.getByText('Bootstrap instance owner').query()).toBeNull();
	});

	it('renders access restricted card for a suspended member, not the tabs', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () =>
				meResponse(member({ userId: 'suspended-user', role: 'member', status: 'suspended' }))
			);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await expect.element(screen.getByText('Access restricted')).toBeVisible();
		expect(screen.getByRole('tab', { name: 'API keys' }).query()).toBeNull();
	});

	it('gives an active plain member only their own API keys tab, never Members or Invitations', async () => {
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

		const screen = await render(SettingsPage);

		await expect.element(screen.getByRole('tab', { name: 'API keys' })).toBeVisible();
		await expect.element(screen.getByText('Your API keys')).toBeVisible();
		expect(screen.getByRole('tab', { name: 'Members' }).query()).toBeNull();
		expect(screen.getByRole('tab', { name: 'Invitations' }).query()).toBeNull();

		// A plain member is never asked for /instance/members or /instance/invitations.
		const calledUrls = mockFetch.mock.calls.map((call) => String(call[0]));
		expect(
			calledUrls.some((u) => u.includes('/api/v1/instance/members') && !u.endsWith('/me'))
		).toBe(false);
		expect(calledUrls.some((u) => u.includes('/api/v1/instance/invitations'))).toBe(false);
	});

	it('does not automatically retry a failed members list load; only explicit Retry does', async () => {
		let membersCallCount = 0;
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
			}
			if (urlStr.includes('/api/v1/instance/members')) {
				membersCallCount += 1;
				return problemResponse(500, 'Members unavailable');
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);

		await expect.element(screen.getByText('Members unavailable')).toBeVisible();
		expect(membersCallCount).toBe(1);

		// Give any latent auto-retry effect a chance to fire before asserting it never does.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(membersCallCount).toBe(1);

		// The banner action is labeled as a list refresh, never "Retry", because
		// this same banner also carries mutation failures.
		expect(screen.getByRole('button', { name: 'Retry' }).query()).toBeNull();
		await screen.getByRole('alert').getByRole('button', { name: 'Refresh members' }).click();
		await expect.element(screen.getByText('Members unavailable')).toBeVisible();
		expect(membersCallCount).toBe(2);
	});

	it('hides admin/owner role choices from an admin creating an invitation, but not from an owner', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'admin-user', role: 'admin' }));
			}
			if (urlStr.includes('/api/v1/instance/members')) {
				return jsonResponse({
					members: [member({ userId: 'admin-user', role: 'admin' })],
					nextCursor: null
				});
			}
			if (urlStr.includes('/api/v1/instance/invitations')) {
				return jsonResponse({ invitations: [], nextCursor: null });
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'Invitations' }).click();

		const roleSelect = screen.getByLabelText('Role');
		await expect.element(roleSelect).toBeVisible();
		const optionValues = Array.from(roleSelect.element().querySelectorAll('option')).map(
			(option) => (option as HTMLOptionElement).value
		);
		expect(optionValues).toEqual(['member']);
	});

	it('lets an owner choose admin and owner roles when creating an invitation', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
			}
			if (urlStr.includes('/api/v1/instance/members')) {
				return jsonResponse({
					members: [member({ userId: 'owner-user-1', role: 'owner' })],
					nextCursor: null
				});
			}
			if (urlStr.includes('/api/v1/instance/invitations')) {
				return jsonResponse({ invitations: [], nextCursor: null });
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'Invitations' }).click();

		const roleSelect = screen.getByLabelText('Role');
		await expect.element(roleSelect).toBeVisible();
		const optionValues = Array.from(roleSelect.element().querySelectorAll('option')).map(
			(option) => (option as HTMLOptionElement).value
		);
		expect(optionValues).toEqual(['member', 'admin', 'owner']);
	});

	it('lets an admin revoke a member-role invitation but not an admin-role invitation', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'admin-user', role: 'admin' }));
			}
			if (urlStr.includes('/api/v1/instance/members')) {
				return jsonResponse({
					members: [member({ userId: 'admin-user', role: 'admin' })],
					nextCursor: null
				});
			}
			if (urlStr.includes('/api/v1/instance/invitations')) {
				return jsonResponse({
					invitations: [
						{
							id: 'inv-member-role',
							role: 'member',
							status: 'pending',
							invitedByUserId: 'admin-user',
							createdAt: '2026-09-03T00:00:00.000Z',
							expiresAt: '2099-01-01T00:00:00.000Z',
							acceptedAt: null,
							acceptedByUserId: null,
							revokedAt: null,
							revokedByUserId: null
						},
						{
							id: 'inv-admin-role',
							role: 'admin',
							status: 'pending',
							invitedByUserId: 'admin-user',
							createdAt: '2026-09-03T00:00:00.000Z',
							expiresAt: '2099-01-01T00:00:00.000Z',
							acceptedAt: null,
							acceptedByUserId: null,
							revokedAt: null,
							revokedByUserId: null
						}
					],
					nextCursor: null
				});
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'Invitations' }).click();
		await expect.element(screen.getByText('inv-member-role')).toBeVisible();

		const revokeButtons = screen.getByRole('button', { name: 'Revoke' });
		await expect.element(revokeButtons.first()).toBeVisible();
		expect(revokeButtons.all()).toHaveLength(1);
	});

	it('renders an unrevoked but past-expiry invitation as Expired and offers no revoke action', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
			}
			if (urlStr.includes('/api/v1/instance/members')) {
				return jsonResponse({
					members: [member({ userId: 'owner-user-1', role: 'owner' })],
					nextCursor: null
				});
			}
			if (urlStr.includes('/api/v1/instance/invitations')) {
				return jsonResponse({
					invitations: [
						{
							id: 'inv-expired',
							role: 'member',
							status: 'pending',
							invitedByUserId: 'owner-user-1',
							createdAt: '1999-12-01T00:00:00.000Z',
							expiresAt: '2000-01-01T00:00:00.000Z',
							acceptedAt: null,
							acceptedByUserId: null,
							revokedAt: null,
							revokedByUserId: null
						}
					],
					nextCursor: null
				});
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'Invitations' }).click();

		await expect.element(screen.getByText('Expired', { exact: true })).toBeVisible();
		expect(screen.getByRole('button', { name: 'Revoke' }).query()).toBeNull();
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

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'API keys' }).click();
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

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'API keys' }).click();

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

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'API keys' }).click();

		await screen.getByLabelText('Key name').fill('Max Expiry Key');
		await screen.getByLabelText('Expires in (days, optional)').fill('365');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();

		await expect.element(screen.getByText('One-time API key secret')).toBeVisible();
		expect(createBody?.expiresAt).toBeTypeOf('string');
		const maxAllowedMs = Date.now() + 365 * 24 * 60 * 60 * 1000;
		const requestedMs = Date.parse(createBody!.expiresAt as string);
		expect(requestedMs).toBeLessThan(maxAllowedMs);
		// The buffer should be a small, deliberate margin (minutes), not an
		// accidental multi-day truncation.
		expect(maxAllowedMs - requestedMs).toBeLessThan(10 * 60 * 1000);
		expect(maxAllowedMs - requestedMs).toBeGreaterThan(0);
	});

	it('binds the one-time invitation reveal to the invited email and invitation id, and clears on the next attempt', async () => {
		let inviteCount = 0;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.includes('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/instance/invitations') && init?.method === 'POST') {
					inviteCount += 1;
					return jsonResponse(
						{
							invitation: {
								id: `inv-${inviteCount}`,
								role: 'member',
								status: 'pending',
								invitedByUserId: 'owner-user-1',
								createdAt: '2026-09-03T00:00:00.000Z',
								expiresAt: '2099-01-01T00:00:00.000Z',
								acceptedAt: null,
								acceptedByUserId: null,
								revokedAt: null,
								revokedByUserId: null
							},
							token: `ski1_token_${inviteCount}`
						},
						201
					);
				}
				if (urlStr.includes('/api/v1/instance/invitations')) {
					return jsonResponse({ invitations: [], nextCursor: null });
				}
				if (urlStr.includes('/api/v1/instance/members')) {
					return jsonResponse({
						members: [member({ userId: 'owner-user-1', role: 'owner' })],
						nextCursor: null
					});
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'Invitations' }).click();

		await screen.getByLabelText('Email address').fill('alice@example.com');
		await screen.getByRole('button', { name: 'Create invitation' }).first().click();
		await expect
			.element(screen.getByText('For alice@example.com — invitation inv-1'))
			.toBeVisible();

		await screen.getByLabelText('Email address').fill('bob@example.com');
		await screen.getByRole('button', { name: 'Create invitation' }).first().click();
		await expect.element(screen.getByText('For bob@example.com — invitation inv-2')).toBeVisible();
		expect(screen.getByText('For alice@example.com — invitation inv-1').query()).toBeNull();
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

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'API keys' }).click();

		await screen.getByLabelText('Key name').fill('My Key');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();

		await expect.element(screen.getByText('One-time API key secret')).toBeVisible();
		await screen.getByRole('button', { name: 'Copy secret' }).click();
		await expect
			.element(screen.getByText('Could not copy to clipboard. Copy the value manually.'))
			.toBeVisible();
	});

	it('surfaces a rejected role change in the list banner with a refresh action, never a Retry', async () => {
		let membersCallCount = 0;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				// `/members/me` has to match exactly: `/members/member-user-2/role`
				// also contains the literal substring `members/me`.
				if (urlStr.endsWith('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.endsWith('/role') && init?.method === 'POST') {
					return problemResponse(409, 'The instance must keep one active owner.');
				}
				if (urlStr.includes('/api/v1/instance/members')) {
					membersCallCount += 1;
					return jsonResponse({
						members: [
							member({ userId: 'owner-user-1', role: 'owner' }),
							member({ userId: 'member-user-2', role: 'member' })
						],
						nextCursor: null
					});
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await expect.element(screen.getByText('member-user-2')).toBeVisible();
		expect(membersCallCount).toBe(1);

		await screen.getByLabelText('Role for member-user-2').selectOptions('admin');
		await screen.getByRole('button', { name: 'Update role' }).click();

		await expect
			.element(screen.getByText('The instance must keep one active owner.'))
			.toBeVisible();
		// A failed mutation must never be offered a "Retry" that quietly reloads
		// the list instead of replaying the mutation.
		expect(screen.getByRole('button', { name: 'Retry' }).query()).toBeNull();
		expect(membersCallCount).toBe(1);

		await screen.getByRole('alert').getByRole('button', { name: 'Refresh members' }).click();
		await expect.element(screen.getByText('member-user-2')).toBeVisible();
		expect(membersCallCount).toBe(2);
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

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'API keys' }).click();

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

		// The second secret was never copied: a carried-over "Copied!" would let a
		// user dismiss a one-time secret that is not on the clipboard.
		expect(screen.getByRole('button', { name: 'Copied!' }).query()).toBeNull();
		await expect.element(screen.getByRole('button', { name: 'Copy secret' })).toBeVisible();
	});

	it('never carries a stale clipboard error onto a newly revealed invitation token', async () => {
		let inviteCount = 0;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.includes('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/instance/invitations') && init?.method === 'POST') {
					inviteCount += 1;
					return jsonResponse(
						{
							invitation: {
								id: `inv-${inviteCount}`,
								role: 'member',
								status: 'pending',
								invitedByUserId: 'owner-user-1',
								createdAt: '2026-09-03T00:00:00.000Z',
								expiresAt: '2099-01-01T00:00:00.000Z',
								acceptedAt: null,
								acceptedByUserId: null,
								revokedAt: null,
								revokedByUserId: null
							},
							token: `ski1_token_${inviteCount}`
						},
						201
					);
				}
				if (urlStr.includes('/api/v1/instance/invitations')) {
					return jsonResponse({ invitations: [], nextCursor: null });
				}
				if (urlStr.includes('/api/v1/instance/members')) {
					return jsonResponse({
						members: [member({ userId: 'owner-user-1', role: 'owner' })],
						nextCursor: null
					});
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);
		vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'Invitations' }).click();

		await screen.getByLabelText('Email address').fill('alice@example.com');
		await screen.getByRole('button', { name: 'Create invitation' }).first().click();
		await expect.element(screen.getByText('ski1_token_1')).toBeVisible();

		await screen.getByRole('button', { name: 'Copy token' }).click();
		await expect
			.element(screen.getByText('Could not copy to clipboard. Copy the value manually.'))
			.toBeVisible();

		await screen.getByLabelText('Email address').fill('bob@example.com');
		await screen.getByRole('button', { name: 'Create invitation' }).first().click();
		await expect.element(screen.getByText('ski1_token_2')).toBeVisible();

		// No copy was attempted for the second token, so no failure may be shown.
		expect(
			screen.getByText('Could not copy to clipboard. Copy the value manually.').query()
		).toBeNull();
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
					// The third attempt is an idempotent replay: 200 with metadata only
					// and no plaintext secret to reveal.
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

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'API keys' }).click();

		await screen.getByLabelText('Key name').fill('First Key');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();
		await expect.element(screen.getByText('signkit_plaintext_secret_1')).toBeVisible();
		await expect.element(screen.getByText('For “First Key” — key key-1')).toBeVisible();

		// A failed follow-up create must not destroy the only copy of secret 1.
		await screen.getByLabelText('Key name').fill('Second Key');
		await screen.getByRole('checkbox').first().click();
		await screen.getByRole('button', { name: 'Create key' }).click();
		await expect
			.element(screen.getByText('The API key operation could not be completed.'))
			.toBeVisible();
		await expect.element(screen.getByText('signkit_plaintext_secret_1')).toBeVisible();
		await expect.element(screen.getByText('For “First Key” — key key-1')).toBeVisible();

		// Neither may a successful response that carries no fresh secret.
		await screen.getByRole('button', { name: 'Create key' }).click();
		await expect.element(screen.getByText('signkit_plaintext_secret_1')).toBeVisible();
		await expect.element(screen.getByText('For “First Key” — key key-1')).toBeVisible();
		expect(createCount).toBe(3);
	});

	it('keeps the revealed invitation token intact when a follow-up create fails', async () => {
		let inviteCount = 0;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/instance/invitations') && init?.method === 'POST') {
					inviteCount += 1;
					if (inviteCount === 2) {
						return problemResponse(409, 'The Idempotency-Key was already used.');
					}
					return jsonResponse(
						{
							invitation: {
								id: `inv-${inviteCount}`,
								role: 'member',
								status: 'pending',
								invitedByUserId: 'owner-user-1',
								createdAt: '2026-09-03T00:00:00.000Z',
								expiresAt: '2099-01-01T00:00:00.000Z',
								acceptedAt: null,
								acceptedByUserId: null,
								revokedAt: null,
								revokedByUserId: null
							},
							token: `ski1_token_${inviteCount}`
						},
						201
					);
				}
				if (urlStr.includes('/api/v1/instance/invitations')) {
					return jsonResponse({ invitations: [], nextCursor: null });
				}
				if (urlStr.includes('/api/v1/instance/members')) {
					return jsonResponse({
						members: [member({ userId: 'owner-user-1', role: 'owner' })],
						nextCursor: null
					});
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await screen.getByRole('tab', { name: 'Invitations' }).click();

		await screen.getByLabelText('Email address').fill('alice@example.com');
		await screen.getByRole('button', { name: 'Create invitation' }).first().click();
		await expect.element(screen.getByText('ski1_token_1')).toBeVisible();
		await expect
			.element(screen.getByText('For alice@example.com — invitation inv-1'))
			.toBeVisible();

		await screen.getByLabelText('Email address').fill('bob@example.com');
		await screen.getByRole('button', { name: 'Create invitation' }).first().click();
		await expect.element(screen.getByText('The Idempotency-Key was already used.')).toBeVisible();

		// Alice's one-time token is still the only one ever disclosed, unchanged.
		await expect.element(screen.getByText('ski1_token_1')).toBeVisible();
		await expect
			.element(screen.getByText('For alice@example.com — invitation inv-1'))
			.toBeVisible();
		expect(screen.getByText('ski1_token_2').query()).toBeNull();
	});
});
