import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page as browserPage, userEvent } from 'vitest/browser';
import { createRawSnippet } from 'svelte';
import { envelopeBreadcrumbTitle } from '$lib/navigation/envelope-breadcrumb-title';
import Layout from './+layout.svelte';

const LONG_ENVELOPE_TITLE =
	'Master Services Agreement With Extended Multi-Party Schedules and Technical Specifications (2026)';

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
	},
	navigating: {
		to: null,
		from: null,
		type: null,
		willUnload: false,
		delta: 0,
		complete: Promise.resolve()
	}
}));

const tallContent = createRawSnippet(() => ({
	render: () =>
		'<div style="height: 1500px;" data-testid="tall-content">Tall page content inducing vertical scrolling</div>'
}));

function renderLayout() {
	return render(Layout, {
		props: {
			data: {
				name: 'Owner User',
				email: 'owner@example.com',
				instanceMemberRole: 'owner'
			},
			children: tallContent
		}
	});
}

describe('shared header regression on real +layout', () => {
	beforeEach(() => {
		envelopeBreadcrumbTitle.set(null);
	});

	afterEach(async () => {
		await browserPage.viewport(1280, 800);
	});

	it('asserts 390x844 mobile viewport with vertical scroll: controls do not shrink, breadcrumb truncates, and no horizontal overflow occurs', async () => {
		await browserPage.viewport(390, 844);
		expect(window.innerWidth).toBe(390);

		envelopeBreadcrumbTitle.set(LONG_ENVELOPE_TITLE);
		const screen = await renderLayout();

		const header = screen.container.querySelector('header') as HTMLElement;
		expect(header).not.toBeNull();
		const headerStyle = window.getComputedStyle(header);

		// Header preserves 64px h-16 height and px-4 horizontal padding
		expect(header.offsetHeight).toBe(64);
		expect(headerStyle.paddingLeft).toBe('16px');
		expect(headerStyle.paddingRight).toBe('16px');

		// Tall content induces vertical scrolling: clientWidth is reduced by scrollbar
		const clientWidth = document.documentElement.clientWidth;
		expect(document.documentElement.scrollHeight).toBeGreaterThan(window.innerHeight);
		expect(clientWidth).toBeLessThanOrEqual(390);

		// Header appearance and language controls do not flex-shrink to 50; they retain >= 84px
		const themeBtn = screen.getByRole('button', { name: 'Theme' });
		const langBtn = screen.getByRole('button', { name: 'Language' });
		const controls = themeBtn.element().parentElement as HTMLElement;
		const controlsRect = controls.getBoundingClientRect();
		expect(controlsRect.width).toBeGreaterThanOrEqual(84);

		// Breadcrumb is flexible, min-w-0, and does not overlap controls
		const breadcrumbNav = screen.getByRole('navigation', { name: 'breadcrumb' });
		const breadcrumbRect = breadcrumbNav.element().getBoundingClientRect();
		expect(breadcrumbRect.right).toBeLessThanOrEqual(controlsRect.left);

		// Current breadcrumb crumb has nonzero width, accessible title, and visual text truncation
		const pageCrumb = header.querySelector('[data-slot="breadcrumb-page"]') as HTMLElement;
		expect(pageCrumb).not.toBeNull();
		const pageCrumbRect = pageCrumb.getBoundingClientRect();
		expect(pageCrumbRect.width).toBeGreaterThan(0);
		expect(pageCrumb.textContent?.trim()).toBe(LONG_ENVELOPE_TITLE);
		expect(pageCrumb.getAttribute('title')).toBe(LONG_ENVELOPE_TITLE);
		expect(pageCrumb.scrollWidth).toBeGreaterThan(pageCrumb.clientWidth);

		const crumbStyle = window.getComputedStyle(pageCrumb);
		expect(crumbStyle.textOverflow).toBe('ellipsis');
		expect(crumbStyle.overflow).toBe('hidden');
		expect(crumbStyle.whiteSpace).toBe('nowrap');

		// Compare scrollWidth against documentElement.clientWidth (e.g. 375px), strictly no horizontal scroll
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(clientWidth);
		expect(document.body.scrollWidth).toBeLessThanOrEqual(clientWidth);
		expect(header.scrollWidth).toBeLessThanOrEqual(clientWidth);

		// Actually open theme menu, verify items, and close with Escape
		await themeBtn.click();
		const lightOption = screen.getByRole('menuitem', { name: /Light/i });
		await expect.element(lightOption).toBeVisible();
		await userEvent.keyboard('{Escape}');

		// Actually open language menu, verify items, and close with Escape
		await langBtn.click();
		const enOption = screen.getByRole('menuitem', { name: 'English' });
		await expect.element(enOption).toBeVisible();
		await userEvent.keyboard('{Escape}');
	});

	it('asserts 320x568 narrow viewport with vertical scroll: controls fit without overlap and header does not overflow clientWidth', async () => {
		await browserPage.viewport(320, 568);
		expect(window.innerWidth).toBe(320);

		envelopeBreadcrumbTitle.set(LONG_ENVELOPE_TITLE);
		const screen = await renderLayout();

		const header = screen.container.querySelector('header') as HTMLElement;
		expect(header).not.toBeNull();
		expect(header.offsetHeight).toBe(64);

		const clientWidth = document.documentElement.clientWidth;
		expect(document.documentElement.scrollHeight).toBeGreaterThan(window.innerHeight);
		expect(clientWidth).toBeLessThanOrEqual(320);

		// Controls retain >= 84px width
		const themeBtn = screen.getByRole('button', { name: 'Theme' });
		const langBtn = screen.getByRole('button', { name: 'Language' });
		const controls = themeBtn.element().parentElement as HTMLElement;
		const controlsRect = controls.getBoundingClientRect();
		expect(controlsRect.width).toBeGreaterThanOrEqual(84);

		// Breadcrumb and controls do not collide
		const breadcrumbNav = screen.getByRole('navigation', { name: 'breadcrumb' });
		const breadcrumbRect = breadcrumbNav.element().getBoundingClientRect();
		expect(breadcrumbRect.right).toBeLessThanOrEqual(controlsRect.left);

		// Current crumb has nonzero width, full accessible title, and is truncated
		const pageCrumb = header.querySelector('[data-slot="breadcrumb-page"]') as HTMLElement;
		expect(pageCrumb).not.toBeNull();
		const pageCrumbRect = pageCrumb.getBoundingClientRect();
		expect(pageCrumbRect.width).toBeGreaterThan(0);
		expect(pageCrumb.getAttribute('title')).toBe(LONG_ENVELOPE_TITLE);
		expect(pageCrumb.scrollWidth).toBeGreaterThan(pageCrumb.clientWidth);

		// No horizontal overflow beyond documentElement.clientWidth
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(clientWidth);
		expect(document.body.scrollWidth).toBeLessThanOrEqual(clientWidth);
		expect(header.scrollWidth).toBeLessThanOrEqual(clientWidth);

		// Keyboard activate theme control and dismiss
		themeBtn.element().focus();
		await userEvent.keyboard('{Enter}');
		await expect.element(screen.getByRole('menuitem', { name: /Light/i })).toBeVisible();
		await userEvent.keyboard('{Escape}');

		// Keyboard activate language control and dismiss
		langBtn.element().focus();
		await userEvent.keyboard('{Enter}');
		await expect.element(screen.getByRole('menuitem', { name: 'English' })).toBeVisible();
		await userEvent.keyboard('{Escape}');
	});

	it('renders on desktop 1280x800 viewport without horizontal overflow', async () => {
		await browserPage.viewport(1280, 800);
		expect(window.innerWidth).toBe(1280);

		envelopeBreadcrumbTitle.set('Standard Agreement');
		const screen = await renderLayout();

		const header = screen.container.querySelector('header') as HTMLElement;
		expect(header).not.toBeNull();
		expect(header.offsetHeight).toBe(64);

		const clientWidth = document.documentElement.clientWidth;
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(clientWidth);
		expect(document.body.scrollWidth).toBeLessThanOrEqual(clientWidth);
	});
});
