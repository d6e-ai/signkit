import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime';
import { clearInvitationLink } from '$lib/client/invitation-link';
import InvitationPage from './+page.svelte';
import '../../layout.css';
const { gotoMock } = vi.hoisted(() => ({ gotoMock: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: gotoMock }));
vi.mock('$app/state', () => ({
	page: { url: new URL('https://signkit.example/en/invitations/accept') }
}));
const token = `ski1_${'a'.repeat(43)}`;
const defaultLocale = getLocale;
function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}
function problem(status: number, detail: string) {
	return json({ type: 'urn:signkit:problem:test', title: 'Error', status, detail }, status);
}
beforeEach(async () => {
	await page.viewport(1280, 844);
	gotoMock.mockReset();
	overwriteGetLocale(() => 'en');
	clearInvitationLink(window);
	window.history.replaceState(window.history.state, '', `#token=${token}`);
});
afterEach(() => {
	clearInvitationLink(window);
	window.history.replaceState(
		window.history.state,
		'',
		window.location.pathname + window.location.search
	);
	overwriteGetLocale(defaultLocale);
	vi.unstubAllGlobals();
});
describe('invitation email landing page', () => {
	it('survives sign-in without exposing the token and requires confirmation before acceptance', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => problem(401, 'Authentication required'))
		);
		const signedOut = await render(InvitationPage);
		const signIn = signedOut.getByRole('link', { name: 'Sign in', exact: true });
		await expect.element(signIn).toBeVisible();
		expect(window.location.hash).toBe('');
		const href = signIn.element().getAttribute('href')!;
		expect(href).toContain(encodeURIComponent('/en/invitations/accept'));
		expect(href).not.toContain(token);
		expect(document.body.textContent).not.toContain(token);
		await signedOut.unmount();
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			init?.method === 'POST'
				? json({ invitation: {}, member: {} })
				: json({ member: null, bootstrapped: true })
		);
		vi.stubGlobal('fetch', fetchMock);
		const signedIn = await render(InvitationPage);
		const confirm = signedIn.getByRole('button', { name: 'Accept invitation', exact: true });
		await expect.element(confirm).toBeVisible();
		expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
		expect(signedIn.getByRole('textbox').query()).toBeNull();
		await confirm.click();
		await vi.waitFor(() =>
			expect(gotoMock).toHaveBeenCalledWith(expect.stringMatching(/\/settings$/), {
				invalidateAll: true,
				replaceState: true
			})
		);
		const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
		expect(JSON.parse(request[1]!.body as string)).toEqual({ token });
		expect(window.sessionStorage.getItem('signkit:pending-invitation')).toBeNull();
	});
	it('retains a retryable link and command identity after a rejected acceptance', async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			init?.method === 'POST'
				? problem(404, 'The instance invitation could not be accepted.')
				: json({ member: null, bootstrapped: true })
		);
		vi.stubGlobal('fetch', fetchMock);
		const screen = await render(InvitationPage);
		const confirm = screen.getByRole('button', { name: 'Accept invitation', exact: true });
		await confirm.click();
		await expect
			.element(screen.getByRole('alert'))
			.toHaveTextContent('Check that you are using the invited account');
		await confirm.click();
		await vi.waitFor(() =>
			expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
		);
		const requests = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
		expect(requests[0][1]!.headers).toEqual(requests[1][1]!.headers);
		expect(gotoMock).not.toHaveBeenCalled();
		expect(document.body.textContent).not.toContain(token);
	});
	it('prevents duplicate acceptance while pending and returns to sign-in if the session expired', async () => {
		let finish: (response: Response) => void = () => {};
		const pending = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		let expired = false;
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') return pending;
			return expired
				? problem(401, 'Authentication required')
				: json({ member: null, bootstrapped: true });
		});
		vi.stubGlobal('fetch', fetchMock);
		const screen = await render(InvitationPage);
		await screen.getByRole('button', { name: 'Accept invitation', exact: true }).click();
		await expect
			.element(screen.getByRole('button', { name: 'Accepting invitation…', exact: true }))
			.toBeDisabled();
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
		expired = true;
		finish(problem(401, 'Authentication required'));
		await expect.element(screen.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
		expect(gotoMock).not.toHaveBeenCalled();
	});
	it.each([
		{ width: 1280, hasInvitation: false, signedOut: false },
		{ width: 390, hasInvitation: false, signedOut: false },
		{ width: 1280, hasInvitation: true, signedOut: false },
		{ width: 390, hasInvitation: true, signedOut: false },
		{ width: 1280, hasInvitation: true, signedOut: true },
		{ width: 390, hasInvitation: true, signedOut: true }
	])(
		'keeps the invitation card readable at $width pixels (link: $hasInvitation)',
		async ({ width, hasInvitation, signedOut }) => {
			await page.viewport(width, 844);
			overwriteGetLocale(() => 'ja');
			if (!hasInvitation)
				window.history.replaceState(
					window.history.state,
					'',
					window.location.pathname + window.location.search
				);
			vi.stubGlobal(
				'fetch',
				vi.fn(async () =>
					signedOut
						? problem(401, 'Authentication required')
						: json({ member: null, bootstrapped: true })
				)
			);
			const screen = await render(InvitationPage);
			const description = screen.getByText(
				signedOut
					? 'ワークスペース管理にアクセスするにはログインしてください。'
					: hasInvitation
						? 'このワークスペースに参加します。招待メールが届いたアカウントでログインしていることを確認してください。'
						: '管理者に招待メールの送信を依頼してください。'
			);
			await expect.element(description).toBeVisible();
			const card = description.element().closest('[data-slot="card"]')!;
			const bounds = card.getBoundingClientRect();
			expect(bounds.width).toBeGreaterThanOrEqual(Math.min(400, width - 64));
			expect(bounds.right).toBeLessThanOrEqual(width);
			expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
			expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
		}
	);
	it.each(['', '#token=invalid'])(
		'shows only an administrator notice for a missing or invalid link %s',
		async (hash) => {
			window.history.replaceState(
				window.history.state,
				'',
				window.location.pathname + window.location.search + hash
			);
			overwriteGetLocale(() => 'ja');
			const fetchMock = vi.fn();
			vi.stubGlobal('fetch', fetchMock);
			const screen = await render(InvitationPage);
			await expect
				.element(screen.getByText('管理者に招待メールの送信を依頼してください。'))
				.toBeVisible();
			expect(screen.getByRole('textbox').query()).toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
		}
	);
});
