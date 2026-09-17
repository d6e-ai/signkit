import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import AppBreadcrumbs from './app-breadcrumbs.svelte';

vi.mock('$app/state', () => ({
	page: {
		url: new URL('https://signkit.example/envelopes/new'),
		params: {},
		route: { id: '/envelopes/new' },
		status: 200,
		error: null,
		data: {},
		form: null,
		state: {}
	}
}));

describe('app breadcrumbs on the new envelope route', () => {
	it('uses the create-page label instead of treating new as an envelope id', async () => {
		const screen = await render(AppBreadcrumbs);

		await expect.element(screen.getByText('SignKit')).toBeVisible();
		await expect.element(screen.getByText('New agreement')).toBeVisible();
		expect(screen.container.querySelectorAll('a')).toHaveLength(1);
		expect(screen.container.querySelectorAll('[data-slot="breadcrumb-page"]')).toHaveLength(1);
	});
});
