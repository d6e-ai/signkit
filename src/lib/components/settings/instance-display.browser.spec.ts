import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime';
import MembersPage from '../../../routes/settings/members/+page.svelte';
import InvitationsPage from '../../../routes/settings/invitations/+page.svelte';
import type { InstanceInvitationMetadata, InstanceMemberMetadata } from '$lib/ports/instance-store';
import type { InvitationDisplay, MemberDisplay } from '$lib/ports/instance-display-store';
import '../../../routes/layout.css';

const { gotoMock } = vi.hoisted(() => ({ gotoMock: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: gotoMock }));
const defaultGetLocale = getLocale;
const owner: InstanceMemberMetadata = {
	userId: 'owner-subject',
	role: 'owner',
	status: 'active',
	createdAt: '2026-10-01T00:00:00.000Z',
	updatedAt: '2026-10-01T00:00:00.000Z'
};
const target: InstanceMemberMetadata = { ...owner, userId: 'target-subject', role: 'member' };
const snapshot = (name = 'Alex Rivera', email = 'alex@example.com'): MemberDisplay => ({
	state: 'available',
	name,
	email,
	observedAt: new Date(Date.now() - 86400000).toISOString(),
	expiresAt: new Date(Date.now() + 86400000).toISOString()
});
const invitation = (
	status: 'pending' | 'accepted' | 'revoked' = 'pending',
	expired = false
): InstanceInvitationMetadata => ({
	id: '01900000-0000-7000-8000-000000000001',
	role: 'member',
	status,
	invitedByUserId: owner.userId,
	createdAt: new Date(Date.now() - 86400000).toISOString(),
	expiresAt: new Date(Date.now() + (expired ? -1 : 86400000)).toISOString(),
	acceptedAt: status === 'accepted' ? new Date().toISOString() : null,
	acceptedByUserId: status === 'accepted' ? target.userId : null,
	revokedAt: status === 'revoked' ? new Date().toISOString() : null,
	revokedByUserId: status === 'revoked' ? owner.userId : null
});

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}
function membersFetch(display?: Record<string, MemberDisplay>, member = target) {
	return vi.fn<typeof fetch>(async (input, init) => {
		const url = String(input);
		if (url.endsWith('/members/me')) return json({ member: owner, bootstrapped: true });
		if (init?.method === 'POST')
			return json(
				{
					type: 'urn:signkit:problem:forbidden',
					title: 'Forbidden',
					status: 403,
					detail: 'Role change rejected.'
				},
				403
			);
		if (url.includes('/members'))
			return json({
				members: [member],
				nextCursor: null,
				...(display ? { memberDisplays: display } : {})
			});
		return json({});
	});
}
function invitationsFetch(
	item: InstanceInvitationMetadata,
	display?: InvitationDisplay | Record<string, unknown>
) {
	return vi.fn<typeof fetch>(async (input) => {
		if (String(input).endsWith('/members/me')) return json({ member: owner, bootstrapped: true });
		return json({
			invitations: [item],
			nextCursor: null,
			...(display ? { invitationDisplays: { [item.id]: display } } : {})
		});
	});
}

beforeEach(async () => {
	await page.viewport(1280, 844);
	overwriteGetLocale(() => 'en');
	gotoMock.mockReset();
});
afterEach(() => {
	overwriteGetLocale(defaultGetLocale);
	vi.unstubAllGlobals();
});

test('shows the observed member identity and keeps role mutations keyed by the stable subject', async () => {
	const fetchMock = membersFetch({ [target.userId]: snapshot() });
	vi.stubGlobal('fetch', fetchMock);
	const screen = await render(MembersPage);
	await expect.element(screen.getByText('Alex Rivera', { exact: true })).toBeVisible();
	await expect.element(screen.getByText('alex@example.com')).toBeVisible();
	await expect.element(screen.getByText('Profile as of', { exact: false })).toBeVisible();
	await expect.element(screen.getByText(target.userId, { exact: true })).not.toBeInTheDocument();
	await page.screenshot({ fullPage: true });
	await screen.getByLabelText('Role for Alex Rivera').click();
	await screen.getByRole('option', { name: 'Admin', exact: true }).click();
	await screen.getByRole('button', { name: 'Update role' }).click();
	await expect
		.poll(() =>
			fetchMock.mock.calls.some(
				([url, init]) =>
					String(url).includes(`/members/${target.userId}/role`) && init?.method === 'POST'
			)
		)
		.toBe(true);
	const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
	expect(JSON.parse(request![1]!.body as string)).toEqual({ role: 'admin' });
});

test('keeps a legacy member identifiable and exposes the complete stable ID in details', async () => {
	const id = `member-${'a'.repeat(175)}`;
	vi.stubGlobal('fetch', membersFetch(undefined, { ...target, userId: id }));
	const screen = await render(MembersPage);
	await expect.element(screen.getByText('Display information unavailable')).toBeVisible();
	const trigger = screen.getByRole('button', { name: `Details for ${id}`, exact: true });
	(trigger.element() as HTMLButtonElement).focus();
	await userEvent.keyboard('{Enter}');
	const details = screen.getByRole('dialog');
	await expect.element(details.getByRole('heading', { name: 'Member details' })).toBeVisible();
	await expect.element(details.getByText(id, { exact: true })).toBeVisible();
	await userEvent.keyboard('{Escape}');
	await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument();
	await expect.poll(() => document.activeElement).toBe(trigger.element());
});

test('keeps long member identity and full ID readable in mobile details', async () => {
	await page.viewport(390, 844);
	const name = 'AlexandraRivera'.repeat(10);
	vi.stubGlobal(
		'fetch',
		membersFetch({ [target.userId]: snapshot(name, 'long-address-for-this-member@example.com') })
	);
	const screen = await render(MembersPage);
	await screen.getByRole('button', { name: `Details for ${name}`, exact: true }).click();
	const details = screen.getByRole('dialog');
	await expect.element(details.getByText(target.userId, { exact: true })).toBeVisible();
	const overlay = details.element() as HTMLElement;
	await expect
		.poll(() => details.getByText(name, { exact: true }).element().getBoundingClientRect().right)
		.toBeLessThanOrEqual(390);
	expect(overlay.scrollWidth).toBeLessThanOrEqual(overlay.clientWidth);
	await page.screenshot({ fullPage: true });
});

test('uses Japanese snapshot and role labels without rendering profile text as markup', async () => {
	overwriteGetLocale(() => 'ja');
	const name = '<img src=x onerror=alert(1)>';
	vi.stubGlobal('fetch', membersFetch({ [target.userId]: snapshot(name) }));
	const screen = await render(MembersPage);
	await expect.element(screen.getByText(name, { exact: true })).toBeVisible();
	await expect.element(screen.getByText('時点のプロフィール', { exact: false })).toBeVisible();
	expect(screen.container.querySelector('img')).toBeNull();
	await screen.getByRole('button', { name: `${name} の詳細`, exact: true }).click();
	const details = screen.getByRole('dialog');
	await expect.element(details.getByRole('heading', { name: 'メンバーの詳細' })).toBeVisible();
	await expect.element(details.getByText('メンバー', { exact: true })).toBeVisible();
});

test('shows a pending target without credential material and keeps the ID in details', async () => {
	await page.viewport(390, 844);
	const item = invitation();
	vi.stubGlobal(
		'fetch',
		invitationsFetch(item, {
			state: 'pending',
			email: 'invited@example.com',
			token: 'ski1_hidden',
			sealedPayload: 'ciphertext-hidden'
		})
	);
	const screen = await render(InvitationsPage);
	await expect.element(screen.getByText('invited@example.com', { exact: true })).toBeVisible();
	await expect.element(screen.getByText(item.id, { exact: true })).not.toBeInTheDocument();
	expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	await page.screenshot({ fullPage: true });
	await screen
		.getByRole('button', { name: 'Details for invited@example.com', exact: true })
		.click();
	const details = screen.getByRole('dialog');
	await expect.element(details.getByText(item.id, { exact: true })).toBeVisible();
	expect(document.body.textContent).not.toContain('ski1_hidden');
	expect(document.body.textContent).not.toContain('ciphertext-hidden');
});

test('identifies an accepted member separately from the original invitation target', async () => {
	const item = invitation('accepted');
	vi.stubGlobal(
		'fetch',
		invitationsFetch(item, {
			state: 'accepted',
			member: snapshot(),
			email: 'old-target@example.com'
		})
	);
	const screen = await render(InvitationsPage);
	await expect.element(screen.getByText('Alex Rivera', { exact: true })).toBeVisible();
	await screen.getByRole('button', { name: 'Details for Alex Rivera', exact: true }).click();
	const details = screen.getByRole('dialog');
	await expect.element(details.getByText('Accepted member', { exact: true })).toBeVisible();
	await expect.element(details.getByText(target.userId, { exact: true })).toBeVisible();
	expect(document.body.textContent).not.toContain('old-target@example.com');
});

test.each(['revoked', 'expired'] as const)(
	'redacts a stale target on a %s invitation',
	async (state) => {
		const item = invitation(state === 'revoked' ? 'revoked' : 'pending', state === 'expired');
		vi.stubGlobal(
			'fetch',
			invitationsFetch(item, { state: 'pending', email: 'should-be-hidden@example.com' })
		);
		const screen = await render(InvitationsPage);
		await expect.element(screen.getByText('Recipient address removed')).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Revoke', exact: true }))
			.not.toBeInTheDocument();
		expect(document.body.textContent).not.toContain('should-be-hidden@example.com');
	}
);
