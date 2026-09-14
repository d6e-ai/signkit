import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import InvitationsPage from './+page.svelte';

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

describe('settings invitations page in the browser', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		gotoMock.mockReset();
	});

	it('redirects a plain active member back to /settings, never showing the invitations UI', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'plain-member', role: 'member' }));
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		await render(InvitationsPage);
		await vi.waitFor(() =>
			expect(gotoMock).toHaveBeenCalledWith(expect.stringMatching(/\/settings$/))
		);
	});

	it('hides admin/owner role choices from an admin creating an invitation, but not from an owner', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'admin-user', role: 'admin' }));
			}
			if (urlStr.includes('/api/v1/instance/invitations')) {
				return jsonResponse({ invitations: [], nextCursor: null });
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(InvitationsPage);

		const roleSelect = screen.getByLabelText('Role');
		await expect.element(roleSelect).toBeVisible();
		await roleSelect.click();
		const optionValues = screen
			.getByRole('option')
			.all()
			.map((option) => option.element().getAttribute('data-value'));
		expect(optionValues).toEqual(['member']);
	});

	it('lets an owner choose admin and owner roles when creating an invitation', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
			}
			if (urlStr.includes('/api/v1/instance/invitations')) {
				return jsonResponse({ invitations: [], nextCursor: null });
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(InvitationsPage);

		const roleSelect = screen.getByLabelText('Role');
		await expect.element(roleSelect).toBeVisible();
		await roleSelect.click();
		const optionValues = screen
			.getByRole('option')
			.all()
			.map((option) => option.element().getAttribute('data-value'));
		expect(optionValues).toEqual(['member', 'admin', 'owner']);
	});

	it('lets an admin revoke a member-role invitation but not an admin-role invitation', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'admin-user', role: 'admin' }));
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

		const screen = await render(InvitationsPage);
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

		const screen = await render(InvitationsPage);

		await expect.element(screen.getByText('Expired', { exact: true })).toBeVisible();
		expect(screen.getByRole('button', { name: 'Revoke' }).query()).toBeNull();
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
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(InvitationsPage);

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
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);
		vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

		const screen = await render(InvitationsPage);

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

		expect(
			screen.getByText('Could not copy to clipboard. Copy the value manually.').query()
		).toBeNull();
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
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(InvitationsPage);

		await screen.getByLabelText('Email address').fill('alice@example.com');
		await screen.getByRole('button', { name: 'Create invitation' }).first().click();
		await expect.element(screen.getByText('ski1_token_1')).toBeVisible();
		await expect
			.element(screen.getByText('For alice@example.com — invitation inv-1'))
			.toBeVisible();

		await screen.getByLabelText('Email address').fill('bob@example.com');
		await screen.getByRole('button', { name: 'Create invitation' }).first().click();
		await expect.element(screen.getByText('The Idempotency-Key was already used.')).toBeVisible();

		await expect.element(screen.getByText('ski1_token_1')).toBeVisible();
		await expect
			.element(screen.getByText('For alice@example.com — invitation inv-1'))
			.toBeVisible();
		expect(screen.getByText('ski1_token_2').query()).toBeNull();
	});

	it('associates a create failure FieldError inside its invalid Field with data-invalid and aria-invalid', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.endsWith('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/instance/invitations') && init?.method === 'POST') {
					return problemResponse(409, 'Invitation already pending.');
				}
				if (urlStr.includes('/api/v1/instance/invitations')) {
					return jsonResponse({ invitations: [], nextCursor: null });
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(InvitationsPage);

		await screen.getByLabelText('Email address').fill('dup@example.com');
		await screen.getByRole('button', { name: 'Create invitation' }).first().click();
		const fieldError = screen.getByText('Invitation already pending.');
		await expect.element(fieldError).toBeVisible();
		const field = fieldError.element().closest('[data-slot="field"]');
		expect(field).not.toBeNull();
		expect(field?.getAttribute('data-invalid')).not.toBeNull();
		const emailInput = screen.getByLabelText('Email address');
		expect(emailInput.element().getAttribute('aria-invalid')).toBe('true');
	});

	it('dismisses the revealed invitation token via its dismiss action', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
				if (urlStr.includes('/api/v1/instance/members/me')) {
					return meResponse(member({ userId: 'owner-user-1', role: 'owner' }));
				}
				if (urlStr.includes('/api/v1/instance/invitations') && init?.method === 'POST') {
					return jsonResponse(
						{
							invitation: {
								id: 'inv-dismiss',
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
							token: 'ski1_dismiss_me'
						},
						201
					);
				}
				if (urlStr.includes('/api/v1/instance/invitations')) {
					return jsonResponse({ invitations: [], nextCursor: null });
				}
				return jsonResponse({});
			});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(InvitationsPage);

		await screen.getByLabelText('Email address').fill('gone@example.com');
		await screen.getByRole('button', { name: 'Create invitation' }).first().click();
		await expect.element(screen.getByText('ski1_dismiss_me')).toBeVisible();

		await screen.getByRole('alert').getByRole('button').first().click();
		expect(screen.getByText('ski1_dismiss_me').query()).toBeNull();
	});
});
