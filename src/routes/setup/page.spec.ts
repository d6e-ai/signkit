import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import SetupPage from './+page.svelte';

describe('setup first-admin page server contracts', () => {
	it('renders the SSR initial checking shell without crashing', () => {
		const { body } = render(SetupPage);
		expect(body).toContain('Checking instance status');
		expect(body).toContain('Claim instance owner');
	});

	it('never renders the removed bootstrap-secret input', () => {
		const { body } = render(SetupPage);
		expect(body).not.toContain('Bootstrap secret');
	});
});
