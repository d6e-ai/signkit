import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MembersPage from './+page.svelte';

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

describe('settings members page in the browser', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		gotoMock.mockReset();
	});

	it('renders the members list for an active owner', async () => {
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
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(MembersPage);
		await expect.element(screen.getByText('owner-user-1')).toBeVisible();
		await expect.element(screen.getByText('member-user-2')).toBeVisible();
		expect(gotoMock).not.toHaveBeenCalled();
	});

	it('shows a sign-in card on 401, not a redirect', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () => problemResponse(401, 'Authentication required'));
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(MembersPage);
		await expect.element(screen.getByText('Authentication required')).toBeVisible();
		expect(gotoMock).not.toHaveBeenCalled();
	});

	it('redirects a plain active member back to /settings, never showing the members table', async () => {
		const mockFetch = vi.fn().mockImplementation(async (url: RequestInfo | URL) => {
			const urlStr = String(url);
			if (urlStr.includes('/api/v1/instance/members/me')) {
				return meResponse(member({ userId: 'plain-member', role: 'member' }));
			}
			return jsonResponse({});
		});
		vi.stubGlobal('fetch', mockFetch);

		const screen = await render(MembersPage);
		await vi.waitFor(() =>
			expect(gotoMock).toHaveBeenCalledWith(expect.stringMatching(/\/settings$/))
		);
		expect(screen.getByText('plain-member').query()).toBeNull();
	});

	it('redirects a non-member back to /settings', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () => jsonResponse({ bootstrapped: true, member: null }));
		vi.stubGlobal('fetch', mockFetch);

		await render(MembersPage);
		await vi.waitFor(() =>
			expect(gotoMock).toHaveBeenCalledWith(expect.stringMatching(/\/settings$/))
		);
	});

	it('redirects a suspended member back to /settings', async () => {
		const mockFetch = vi
			.fn()
			.mockImplementation(async () =>
				meResponse(member({ userId: 'suspended-user', role: 'member', status: 'suspended' }))
			);
		vi.stubGlobal('fetch', mockFetch);

		await render(MembersPage);
		await vi.waitFor(() =>
			expect(gotoMock).toHaveBeenCalledWith(expect.stringMatching(/\/settings$/))
		);
	});

	it('does not automatically retry a failed members list load; only explicit Refresh does', async () => {
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

		const screen = await render(MembersPage);

		await expect.element(screen.getByText('Members unavailable')).toBeVisible();
		expect(membersCallCount).toBe(1);

		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(membersCallCount).toBe(1);

		expect(screen.getByRole('button', { name: 'Retry' }).query()).toBeNull();
		await screen.getByRole('alert').getByRole('button', { name: 'Refresh members' }).click();
		await expect.element(screen.getByText('Members unavailable')).toBeVisible();
		expect(membersCallCount).toBe(2);
	});

	it('surfaces a rejected role change in the list banner with a refresh action, never a Retry', async () => {
		let membersCallCount = 0;
		const mockFetch = vi
			.fn()
			.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
				const urlStr = String(url);
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

		const screen = await render(MembersPage);
		await expect.element(screen.getByText('member-user-2')).toBeVisible();
		expect(membersCallCount).toBe(1);

		await screen.getByLabelText('Role for member-user-2').click();
		await screen.getByRole('option', { name: 'Admin' }).click();
		await screen.getByRole('button', { name: 'Update role' }).click();

		await expect
			.element(screen.getByText('The instance must keep one active owner.'))
			.toBeVisible();
		expect(screen.getByRole('button', { name: 'Retry' }).query()).toBeNull();
		expect(membersCallCount).toBe(1);

		await screen.getByRole('alert').getByRole('button', { name: 'Refresh members' }).click();
		await expect.element(screen.getByText('member-user-2')).toBeVisible();
		expect(membersCallCount).toBe(2);
	});
});
