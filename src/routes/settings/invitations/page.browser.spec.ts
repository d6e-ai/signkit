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

	it('queues invitation email without rendering the bearer token and updates the recipient on the next success', async () => {
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
								id: 'inv-1',
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
							delivery: { status: 'scheduled' }
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
		await screen.getByRole('button', { name: 'Send invitation email' }).first().click();
		await expect
			.element(
				screen.getByText(
					'The invitation email for alice@example.com is queued for background delivery.'
				)
			)
			.toBeVisible();
		expect(screen.getByText(/ski1_/).query()).toBeNull();

		await screen.getByLabelText('Email address').fill('bob@example.com');
		await screen.getByRole('button', { name: 'Send invitation email' }).first().click();
		await expect
			.element(
				screen.getByText(
					'The invitation email for bob@example.com is queued for background delivery.'
				)
			)
			.toBeVisible();
		expect(
			screen
				.getByText('The invitation email for alice@example.com is queued for background delivery.')
				.query()
		).toBeNull();
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
		await screen.getByRole('button', { name: 'Send invitation email' }).first().click();
		const fieldError = screen.getByText('Invitation already pending.');
		await expect.element(fieldError).toBeVisible();
		const field = fieldError.element().closest('[data-slot="field"]');
		expect(field).not.toBeNull();
		expect(field?.getAttribute('data-invalid')).not.toBeNull();
		const emailInput = screen.getByLabelText('Email address');
		expect(emailInput.element().getAttribute('aria-invalid')).toBe('true');
	});
});
