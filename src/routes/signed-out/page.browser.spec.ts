import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import SignedOutPage from './+page.svelte';

describe('signed-out page in browser', () => {
	it('renders a real anchor for Sign In, not a JS-only click handler', async () => {
		const screen = await render(SignedOutPage);

		const signIn = screen.getByRole('link', { name: 'Sign in' });
		await expect.element(signIn).toBeVisible();
		expect(signIn.element().getAttribute('href')).toMatch(/\/auth\/login$/);
	});
});
