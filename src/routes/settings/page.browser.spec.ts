import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SettingsPage from './+page.svelte';

const { gotoMock } = vi.hoisted(() => ({ gotoMock: vi.fn() }));

vi.mock('$app/navigation', () => ({
	goto: gotoMock,
	invalidateAll: vi.fn(async () => undefined)
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

	it('asks a non-member without a received invitation to request one, without a token form', async () => {
		const mockFetch = vi.fn(async (input: RequestInfo | URL) =>
			String(input).endsWith('/invitations/received')
				? jsonResponse({
						account: { subject: 'user-1', email: 'user@example.com' },
						invitations: []
					})
				: meResponse(null)
		);
		vi.stubGlobal('fetch', mockFetch);
		const screen = await render(SettingsPage);
		await expect
			.element(
				screen.getByText(
					'If you were invited, sign in with the account for the invited email address and the invitation will appear here. Otherwise, ask your administrator to invite you.'
				)
			)
			.toBeVisible();
		expect(screen.getByRole('textbox').query()).toBeNull();
		expect(screen.getByRole('button', { name: 'Accept invitation' }).query()).toBeNull();
		expect(screen.getByRole('button', { name: 'Join' }).query()).toBeNull();
		expect(mockFetch.mock.calls.map(([input]) => String(input))).toEqual([
			'/api/v1/instance/members/me',
			'/api/v1/instance/invitations/received'
		]);
		expect(gotoMock).not.toHaveBeenCalled();
	});

	it('lets a non-member join a received invitation without the emailed link', async () => {
		let joined = false;
		const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith('/invitations/received')) {
				return jsonResponse({
					account: { subject: 'user-1', email: 'invitee@example.com' },
					invitations: [
						{
							id: '01900000-0000-7000-8000-000000000001',
							role: 'admin',
							createdAt: '2026-09-01T00:00:00.000Z',
							expiresAt: '2026-09-08T00:00:00.000Z'
						}
					]
				});
			}
			if (url.endsWith('/01900000-0000-7000-8000-000000000001/accept')) {
				const headers = new Headers(init?.headers);
				expect(init?.method).toBe('POST');
				expect(init?.body).toBe('{}');
				expect(headers.get('x-signkit-expected-subject')).toBe('user-1');
				expect(headers.get('idempotency-key')).toBeTruthy();
				joined = true;
				return jsonResponse({
					invitation: { id: '01900000-0000-7000-8000-000000000001' },
					member: member({ userId: 'user-1', role: 'admin' })
				});
			}
			return meResponse(joined ? member({ userId: 'user-1', role: 'admin' }) : null);
		});
		vi.stubGlobal('fetch', mockFetch);
		const screen = await render(SettingsPage);
		await expect.element(screen.getByText('You have an invitation')).toBeVisible();
		await expect.element(screen.getByText('invitee@example.com')).toBeVisible();
		await expect.element(screen.getByText('Role: Admin')).toBeVisible();
		await screen.getByRole('button', { name: 'Join' }).click();
		await vi.waitFor(() =>
			expect(gotoMock).toHaveBeenCalledWith(expect.stringMatching(/\/settings\/members$/))
		);
		expect(joined).toBe(true);
	});

	it('explains that a verified email is needed before invitations can be shown', async () => {
		const mockFetch = vi.fn(async (input: RequestInfo | URL) =>
			String(input).endsWith('/invitations/received')
				? new Response(
						JSON.stringify({
							type: 'urn:signkit:problem:email-verification-required',
							title: 'Email verification required',
							status: 403,
							detail: 'Listing received invitations requires a provider-verified email claim.',
							instance: '/api/v1/instance/invitations/received'
						}),
						{ status: 403, headers: { 'content-type': 'application/problem+json' } }
					)
				: meResponse(null)
		);
		vi.stubGlobal('fetch', mockFetch);
		const screen = await render(SettingsPage);
		await expect
			.element(
				screen.getByText('Verify your email address to see invitations, then sign in again.')
			)
			.toBeVisible();
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
