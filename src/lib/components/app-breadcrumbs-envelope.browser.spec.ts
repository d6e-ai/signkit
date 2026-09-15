import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { envelopeBreadcrumbTitle } from '$lib/navigation/envelope-breadcrumb-title';
import AppBreadcrumbs from './app-breadcrumbs.svelte';

vi.mock('$app/state', () => ({
	page: {
		url: new URL('https://signkit.example/envelopes/01900000-0000-7000-8000-000000000020'),
		params: { envelopeId: '01900000-0000-7000-8000-000000000020' },
		route: { id: '/envelopes/[envelopeId]' },
		status: 200,
		error: null,
		data: {},
		form: null,
		state: {}
	}
}));

describe('app breadcrumbs on an envelope detail route', () => {
	beforeEach(() => envelopeBreadcrumbTitle.set(null));

	it('links the envelope collection and renders the loaded envelope name last', async () => {
		envelopeBreadcrumbTitle.set('Master Services Agreement');
		const screen = await render(AppBreadcrumbs);

		const anchors = screen.container.querySelectorAll('a');
		expect(anchors).toHaveLength(2);
		expect(anchors[0].textContent).toBe('SignKit');
		expect(anchors[1].textContent).toBe('Envelopes');
		expect(anchors[1].getAttribute('href')).toMatch(/\/envelopes$/);
		await expect.element(screen.getByText('Master Services Agreement')).toBeVisible();
	});
});
