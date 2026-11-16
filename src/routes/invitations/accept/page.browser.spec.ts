import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, commands } from 'vitest/browser';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime';
import { clearInvitationLink } from '$lib/client/invitation-link';
import InvitationPage from './+page.svelte';
import '../../layout.css';
const account = { subject: 'signed-in-subject', email: 'current@example.com' };
const renderPage = (identity = account) =>
	render(InvitationPage, { data: { signedInAccount: identity } });
const { gotoMock, invalidateMock, authorizeMock, appPage } = vi.hoisted(() => ({
	gotoMock: vi.fn(),
	invalidateMock: vi.fn(),
	authorizeMock: vi.fn(),
	appPage: { url: new URL('https://signkit.example/en/invitations/accept') }
}));
vi.mock('$app/navigation', () => ({
	goto: gotoMock,
	invalidateAll: invalidateMock,
	afterNavigate: vi.fn()
}));
vi.mock('$lib/client/authorization-navigation', () => ({
	navigateToAuthorization: authorizeMock
}));
vi.mock('$app/state', () => ({
	page: appPage
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
	authorizeMock.mockReset();
	appPage.url = new URL('https://signkit.example/en/invitations/accept');
	invalidateMock.mockReset();
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
		const signedOut = await renderPage();
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
		const signedIn = await renderPage();
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
	it('prepares account switching with a same-origin command then navigates separately without exposing the invitation', async () => {
		let finish: (response: Response) => void = () => {};
		const pending = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			init?.method === 'POST' ? pending : json({ member: null, bootstrapped: true })
		);
		vi.stubGlobal('fetch', fetchMock);
		const screen = await renderPage();
		await expect.element(screen.getByText('current@example.com')).toBeVisible();
		const button = screen.getByRole('button', { name: 'Use another account', exact: true });
		expect(button.element().closest('form')).toBeNull();
		await button.click();
		await expect
			.element(screen.getByRole('button', { name: 'Opening sign-in…', exact: true }))
			.toBeDisabled();
		await expect
			.element(screen.getByRole('button', { name: 'Accept invitation', exact: true }))
			.toBeDisabled();
		expect(authorizeMock).not.toHaveBeenCalled();
		const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
		expect(posts).toHaveLength(1);
		expect(String(posts[0][0])).toMatch(/\/auth\/switch-account$/);
		expect(posts[0][1]).toEqual({
			method: 'POST',
			credentials: 'same-origin',
			headers: { accept: 'application/json' },
			redirect: 'error'
		});
		const authorizeUrl = 'https://auth.example/auth/login?state=fresh&prompt=select_account';
		finish(json({ authorizeUrl }));
		await vi.waitFor(() => expect(authorizeMock).toHaveBeenCalledExactlyOnceWith(authorizeUrl));
		expect(window.sessionStorage.getItem('signkit:pending-invitation')).toContain(token);
		expect(JSON.stringify(posts)).not.toContain(token);
		expect(document.body.textContent).not.toContain(token);
	});
	it('refreshes the signed-in identity when returning from authorization through browser history', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
				init?.method === 'POST'
					? json({ authorizeUrl: 'https://auth.example/auth/login' })
					: json({ member: null, bootstrapped: true })
			)
		);
		const screen = await renderPage();
		await screen.getByRole('button', { name: 'Use another account', exact: true }).click();
		await vi.waitFor(() => expect(authorizeMock).toHaveBeenCalled());
		window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
		await vi.waitFor(() => expect(invalidateMock).toHaveBeenCalledOnce());
		await expect
			.element(screen.getByRole('button', { name: 'Use another account', exact: true }))
			.toBeEnabled();
		expect(window.sessionStorage.getItem('signkit:pending-invitation')).toContain(token);
	});
	it.each(['network', 'http', 'invalid-destination'])(
		'keeps the invitation and offers a switch retry after %s failure',
		async (failure) => {
			let failed = false;
			vi.stubGlobal(
				'fetch',
				vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
					if (init?.method !== 'POST') return json({ member: null, bootstrapped: true });
					if (failed) return json({ authorizeUrl: 'https://auth.example/auth/login' });
					failed = true;
					if (failure === 'network') throw new TypeError('Failed to fetch');
					return failure === 'http'
						? problem(503, 'Unavailable')
						: json({ authorizeUrl: 'javascript:alert(1)' });
				})
			);
			const screen = await renderPage();
			await screen.getByRole('button', { name: 'Use another account', exact: true }).click();
			await expect
				.element(screen.getByRole('alert'))
				.toHaveTextContent('Could not open sign-in. Try again.');
			expect(authorizeMock).not.toHaveBeenCalled();
			expect(window.sessionStorage.getItem('signkit:pending-invitation')).toContain(token);
			await screen.getByRole('button', { name: 'Use another account', exact: true }).click();
			await vi.waitFor(() =>
				expect(authorizeMock).toHaveBeenCalledExactlyOnceWith('https://auth.example/auth/login')
			);
		}
	);
	it.each(['cancelled', 'failed', 'same-account'])(
		'offers recovery for an OAuth %s return without automatically accepting',
		async (reason) => {
			appPage.url = new URL(`https://signkit.example/en/invitations/accept?auth=${reason}`);
			const fetchMock = vi.fn(async () => json({ member: null, bootstrapped: true }));
			vi.stubGlobal('fetch', fetchMock);
			const screen = await renderPage();
			await expect.element(screen.getByRole('alert')).toBeVisible();
			await expect
				.element(screen.getByRole('button', { name: 'Use another account', exact: true }))
				.toBeVisible();
			expect(fetchMock.mock.calls).toHaveLength(1);
		}
	);
	it('refreshes an account changed in another tab and requires another explicit confirmation with a new command key', async () => {
		let changed = false;
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			init?.method === 'POST'
				? changed
					? json({ invitation: {}, member: {} })
					: json(
							{
								status: 409,
								type: 'urn:signkit:problem:account-changed',
								title: 'Account changed',
								detail: 'Refresh your account.'
							},
							409
						)
				: json({ member: null, bootstrapped: true })
		);
		vi.stubGlobal('fetch', fetchMock);
		const screen = await renderPage();
		await screen.getByRole('button', { name: 'Accept invitation', exact: true }).click();
		await expect
			.element(screen.getByRole('alert'))
			.toHaveTextContent('Your account changed in another tab');
		expect(invalidateMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
		changed = true;
		await screen.rerender({
			data: { signedInAccount: { subject: 'new-subject', email: 'new@example.com' } }
		});
		await screen.getByRole('button', { name: 'Accept invitation', exact: true }).click();
		await vi.waitFor(() => expect(gotoMock).toHaveBeenCalled());
		const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
		expect(new Headers(posts[0][1]!.headers).get('x-signkit-expected-subject')).toBe(
			account.subject
		);
		expect(new Headers(posts[1][1]!.headers).get('x-signkit-expected-subject')).toBe('new-subject');
		expect(new Headers(posts[1][1]!.headers).get('idempotency-key')).not.toBe(
			new Headers(posts[0][1]!.headers).get('idempotency-key')
		);
	});
	it('sends the real browser switch command with a same-origin Origin header', async () => {
		const nativeFetch = window.fetch.bind(window);
		const { url } = await commands.startFixtureServer({
			status: 200,
			headers: { 'content-type': 'application/json' },
			bodyBase64: '',
			echoRequest: true
		});
		let requestMetadata: { method: string; origin: string; referer: string } | undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method !== 'POST') return json({ member: null, bootstrapped: true });
				const response = await nativeFetch(url, init);
				requestMetadata = await response.json();
				return json({ authorizeUrl: 'https://auth.example/auth/login' });
			})
		);
		try {
			const screen = await renderPage();
			await screen.getByRole('button', { name: 'Use another account', exact: true }).click();
			await vi.waitFor(() => expect(authorizeMock).toHaveBeenCalled());
			expect(requestMetadata?.method).toBe('POST');
			expect(requestMetadata?.origin).toBe(window.location.origin);
			expect(requestMetadata?.referer).not.toContain(token);
		} finally {
			await commands.stopFixtureServer();
		}
	});
	it('replaces a handoff on hash-only navigation and clears invalid fragments in the same page', async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			init?.method === 'POST'
				? json({ invitation: {}, member: {} })
				: json({ member: null, bootstrapped: true })
		);
		vi.stubGlobal('fetch', fetchMock);
		const screen = await renderPage();
		await expect
			.element(screen.getByRole('button', { name: 'Accept invitation', exact: true }))
			.toBeVisible();
		const nextToken = `ski1_${'b'.repeat(43)}`;
		window.location.hash = `token=${nextToken}`;
		await expect.poll(() => window.location.hash).toBe('');
		await screen.getByRole('button', { name: 'Accept invitation', exact: true }).click();
		const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
		expect(JSON.parse(post[1]!.body as string)).toEqual({ token: nextToken });
		window.location.hash = 'token=invalid';
		await expect
			.element(screen.getByText('Open your invitation email', { exact: true }))
			.toBeVisible();
		expect(window.sessionStorage.getItem('signkit:pending-invitation')).toBeNull();
	});
	it('does not discard a new handoff when acceptance of the previous one completes', async () => {
		let finish: (response: Response) => void = () => {};
		const pending = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
				init?.method === 'POST' ? pending : json({ member: null, bootstrapped: true })
			)
		);
		const screen = await renderPage();
		await screen.getByRole('button', { name: 'Accept invitation', exact: true }).click();
		const nextToken = `ski1_${'c'.repeat(43)}`;
		window.location.hash = `token=${nextToken}`;
		await expect.poll(() => window.location.hash).toBe('');
		finish(json({ invitation: {}, member: {} }));
		await expect
			.element(screen.getByRole('button', { name: 'Accept invitation', exact: true }))
			.toBeVisible();
		expect(gotoMock).not.toHaveBeenCalled();
		expect(window.sessionStorage.getItem('signkit:pending-invitation')).toContain(nextToken);
	});
	it('retains a retryable link and command identity after a rejected acceptance', async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
			init?.method === 'POST'
				? problem(404, 'The instance invitation could not be accepted.')
				: json({ member: null, bootstrapped: true })
		);
		vi.stubGlobal('fetch', fetchMock);
		const screen = await renderPage();
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
		const screen = await renderPage();
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
			const screen = await renderPage();
			const description = screen.getByText(
				signedOut
					? 'ワークスペース管理にアクセスするにはログインしてください。'
					: hasInvitation
						? 'このワークスペースに参加します。招待メールが届いたアカウントでログインしていることを確認してください。'
						: 'メール内の招待リンクをもう一度開いて続けてください。招待の有効期限が切れている場合は、管理者に再招待を依頼してください。'
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
			const screen = await renderPage();
			await expect
				.element(
					screen.getByText(
						'メール内の招待リンクをもう一度開いて続けてください。招待の有効期限が切れている場合は、管理者に再招待を依頼してください。'
					)
				)
				.toBeVisible();
			expect(screen.getByRole('textbox').query()).toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
		}
	);
});
