import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import SignedOutPage from './+page.svelte';

describe('signed-out page', () => {
	it('renders without crashing', () => {
		const { body } = render(SignedOutPage);
		expect(body).toContain('Signed out');
	});

	it('offers a Sign In action pointing at /auth/login', () => {
		const { body } = render(SignedOutPage);
		expect(body).toContain('Sign in');
		expect(body).toMatch(/href="[^"]*\/auth\/login"/);
	});
});
