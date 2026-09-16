import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('application layout shell', () => {
	const source: string = readFileSync('src/routes/+layout.svelte', 'utf8');

	it('keeps both application headers at the 64px h-16 height', () => {
		expect(source.match(/\bh-16\b/g)).toHaveLength(2);
		expect(source).not.toMatch(/\bh-14\b/);
	});

	it('uses the shadcn sidebar shell outside recipient surfaces', () => {
		expect(source).toContain('<Sidebar.Provider>');
		expect(source).toContain('<AppSidebar');
		expect(source).toContain('name={data.name ?? null}');
		expect(source).toContain('email={data.email ?? null}');
		expect(source).toContain('instanceMemberRole={data.instanceMemberRole ?? null}');
		expect(source).toContain('<Sidebar.Inset');
		expect(source).toContain('<Sidebar.Trigger />');
	});

	it('applies the stored theme before paint via ModeWatcher', () => {
		expect(source).toContain("import { ModeWatcher } from 'mode-watcher';");
		expect(source).toContain('<ModeWatcher />');
	});

	it('places a theme switch next to the language switch in both header variants', () => {
		expect(source).toContain("import ThemeSwitch from '$lib/components/theme-switch.svelte';");
		const themeSwitchCount = source.match(/<ThemeSwitch \/>/g) ?? [];
		expect(themeSwitchCount).toHaveLength(2);
	});

	it('never applies the rounded/floating inset-variant shell styling', () => {
		expect(source).not.toMatch(/rounded-2xl|shadow-sm/);
	});

	it('matches the ai-gateway inset shell exactly: min-w-0 and nothing else', () => {
		expect(source).toContain('<Sidebar.Inset class="min-w-0">');
	});

	it('keeps authenticated header and page content on the same px-4 horizontal grid with a shared container', () => {
		expect(source).toContain('bg-background/85 px-4 backdrop-blur-xl');
		expect(source).toContain('<div class="container mx-auto w-full flex-1 px-4 py-6">');
		expect(source).not.toContain('<main class="flex-1 px-4 py-6">');
		expect(source).not.toMatch(/<main class="[^"]*(?:md:p-6|lg:p-8)/);
	});

	it('leaves Sidebar.Inset as the sole main landmark outside bare shells', () => {
		const authenticatedShell = source.slice(source.indexOf('{:else}'));
		expect(authenticatedShell.match(/<main\b/g)).toBeNull();
	});

	it('carries no dead header search action', () => {
		expect(source).not.toMatch(/IconSearch|aria-label="Search"/);
	});

	it('places no separator between the sidebar trigger and the breadcrumb', () => {
		const triggerIndex: number = source.indexOf('<Sidebar.Trigger />');
		const breadcrumbIndex: number = source.indexOf('<AppBreadcrumbs />');
		expect(triggerIndex).toBeGreaterThan(-1);
		expect(breadcrumbIndex).toBeGreaterThan(triggerIndex);
		const between: string = source.slice(triggerIndex, breadcrumbIndex);
		expect(between).not.toMatch(/bg-border|<Sidebar\.Separator/);
	});

	it('renders the route-aware breadcrumb and swaps it for a spinner while navigating', () => {
		expect(source).toContain('import AppBreadcrumbs from ');
		expect(source).toMatch(/navigating\.to\s*!==\s*null/);
		expect(source).toMatch(/\{#if navigationPending\}\s*<Spinner/);
		expect(source).toContain('<AppBreadcrumbs />');
	});

	it('never shows a header sign-in action, since anonymous callers are redirected server-side', () => {
		expect(source).not.toMatch(/auth\/login/);
	});

	it('uses the bare recipient-style shell for the public signed-out surface too', () => {
		expect(source).toContain('isSignedOutSurfacePath');
		expect(source).toMatch(
			/isRecipientSurfacePath\(page\.url\.pathname\)\s*\|\|\s*isSignedOutSurfacePath\(page\.url\.pathname\)/
		);
	});

	it('uses the bare shell for the unbootstrapped setup surface, since the sidebar has nowhere to link yet', () => {
		expect(source).toContain('isSetupSurfacePath');
		expect(source).toMatch(
			/isSignedOutSurfacePath\(page\.url\.pathname\)\s*\|\|\s*isSetupSurfacePath\(page\.url\.pathname\)/
		);
	});

	it('never reintroduces Markdown-native/open-core/agent-ready product-marketing metadata', () => {
		expect(source).not.toMatch(/Markdown-native/i);
		expect(source).not.toMatch(/open-core/i);
		expect(source).not.toMatch(/agent-ready/i);
	});
});
