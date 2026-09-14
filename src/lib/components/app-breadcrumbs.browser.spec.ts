import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import AppBreadcrumbs from './app-breadcrumbs.svelte';

vi.mock('$app/state', () => ({
	page: {
		url: new URL('https://signkit.example/settings/invitations'),
		params: {},
		route: { id: '/settings/invitations' },
		status: 200,
		error: null,
		data: {},
		form: null,
		state: {}
	}
}));

describe('app breadcrumbs on a settings child route', () => {
	it('shows three crumbs with a non-link intermediate settings Page and a terminal subsection Page', async () => {
		const screen = await render(AppBreadcrumbs);

		await expect.element(screen.getByText('SignKit')).toBeVisible();
		// The intermediate "Instance administration" crumb must be a Page
		// (current-section label), never a link back to /settings, which is
		// only a redirector and not a stable page.
		const settingsCrumb = screen.getByText('Instance administration');
		await expect.element(settingsCrumb).toBeVisible();
		expect(settingsCrumb.element().closest('a')).toBeNull();
		expect(settingsCrumb.element().tagName.toLowerCase()).not.toBe('a');

		const invitationsCrumb = screen.getByText('Invitations');
		await expect.element(invitationsCrumb).toBeVisible();
		expect(invitationsCrumb.element().closest('a')).toBeNull();

		// Exactly one home link (the brand); no /settings link anywhere.
		// Breadcrumb.Page renders a span with role=link aria-disabled, so a
		// role query would return 3. Query actual anchors directly.
		const anchors = screen.container.querySelectorAll('a');
		expect(anchors).toHaveLength(1);
		expect(anchors[0].getAttribute('href')).toMatch(/\/$/);
	});
});
