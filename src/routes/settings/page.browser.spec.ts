import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SettingsPage from './+page.svelte';

const { gotoMock } = vi.hoisted(() => ({ gotoMock: vi.fn() }));

vi.mock('$app/navigation', () => ({
	goto: gotoMock
}));

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' }
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

describe('settings entry page in the browser', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		gotoMock.mockReset();
	});

	it('shows a sign-in card on 401, not the invitation-accept card', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () => problemResponse(401, 'Authentication required'));
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await expect.element(screen.getByText('Authentication required')).toBeVisible();
		expect(gotoMock).not.toHaveBeenCalled();
	});

	it('offers the invitation-accept card to a non-member, and redirects once acceptance makes them an active member', async () => {
		let meCallCount = 0;
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/invitations/accept')) {
				return jsonResponse({
					invitation: {
						id: 'inv-1',
						role: 'member',
						status: 'accepted',
						invitedByUserId: 'owner-1',
						createdAt: '2026-09-01T00:00:00.000Z',
						expiresAt: '2099-01-01T00:00:00.000Z',
						acceptedAt: '2026-09-14T00:00:00.000Z',
						acceptedByUserId: 'user-1',
						revokedAt: null,
						revokedByUserId: null
					},
					member: member({ userId: 'user-1', role: 'member' })
				});
			}
			if (urlStr.includes('/api/v1/instance/members/me')) {
				meCallCount += 1;
				return meCallCount === 1
					? meResponse(null)
					: meResponse(member({ userId: 'user-1', role: 'member' }));
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await expect
			.element(
				screen.getByText(
					'You are not currently a member of this instance. Enter an invitation token to join.'
				)
			)
			.toBeVisible();

		await screen.getByLabelText('Invitation token').fill('ski1_test_token');
		await screen.getByRole('button', { name: 'Accept invitation' }).click();

		// Accepting makes the caller a plain active member, so the page hands off
		// to their one authorized destination instead of staying on the
		// invitation-accept card.
		await vi.waitFor(() =>
			expect(gotoMock).toHaveBeenCalledWith(expect.stringMatching(/\/settings\/api-keys$/))
		);
		expect(meCallCount).toBe(2);
	});

	it('shows the access-restricted card for a suspended member, never a tabbed UI', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () =>
				meResponse(member({ userId: 'suspended-user', role: 'member', status: 'suspended' }))
			);
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(SettingsPage);
		await expect.element(screen.getByText('Access restricted')).toBeVisible();
		expect(screen.getByRole('tab').query()).toBeNull();
	});

	it('redirects an active owner to /settings/members', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () => meResponse(member({ userId: 'owner-1', role: 'owner' })));
		vi.stubGlobal('fetch', mockFetch);

		await render(SettingsPage);
		await vi.waitFor(() =>
			expect(gotoMock).toHaveBeenCalledWith(expect.stringMatching(/\/settings\/members$/))
		);
	});

	it('redirects an active plain member to /settings/api-keys, never /settings/members', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () => meResponse(member({ userId: 'member-1', role: 'member' })));
		vi.stubGlobal('fetch', mockFetch);

		await render(SettingsPage);
		await vi.waitFor(() =>
			expect(gotoMock).toHaveBeenCalledWith(expect.stringMatching(/\/settings\/api-keys$/))
		);
	});
});
