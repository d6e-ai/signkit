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

	it('asks a non-member to request an administrator invitation without a token form', async () => {
		const mockFetch = vi.fn(async () => meResponse(null));
		vi.stubGlobal('fetch', mockFetch);
		const screen = await render(SettingsPage);
		await expect
			.element(screen.getByText('Ask your administrator to send you an invitation email.'))
			.toBeVisible();
		expect(screen.getByRole('textbox').query()).toBeNull();
		expect(screen.getByRole('button', { name: 'Accept invitation' }).query()).toBeNull();
		expect(mockFetch.mock.calls).toHaveLength(1);
		expect(gotoMock).not.toHaveBeenCalled();
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
