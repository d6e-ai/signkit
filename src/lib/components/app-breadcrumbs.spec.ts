import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('app breadcrumbs', () => {
	const source: string = readFileSync('src/lib/components/app-breadcrumbs.svelte', 'utf8');

	it('uses the installed shadcn breadcrumb component, not hand-rolled markup', () => {
		expect(source).toContain("from '$lib/components/ui/breadcrumb'");
		expect(source).toContain('<Breadcrumb.Root>');
		expect(source).toContain('<Breadcrumb.List>');
		expect(source).toContain('<Breadcrumb.Item>');
		expect(source).toContain('<Breadcrumb.Link');
		expect(source).toContain('<Breadcrumb.Separator');
		expect(source).toContain('<Breadcrumb.Page>');
	});

	it('is route-aware across the primary nav destinations', () => {
		expect(source).toMatch(/currentPath === '\/'.*m\.nav_dashboard/);
		expect(source).toMatch(/currentPath === '\/envelopes'.*m\.nav_agreements/);
		expect(source).toMatch(/startsWith\('\/settings'\).*m\.nav_settings/);
		expect(source).toMatch(/startsWith\('\/setup'\).*m\.setup_title/);
	});

	it('shows an envelope collection link and the loaded envelope title on detail routes', () => {
		expect(source).toContain('/^\\/envelopes\\/[^/]+$/.test(currentPath)');
		expect(source).toContain("href={localizeHref('/envelopes')}");
		expect(source).toContain('m.breadcrumb_envelopes()');
		expect(source).toContain('$envelopeBreadcrumbTitle ?? m.envelope_detail_title()');
	});

	it('anchors the first crumb on the SignKit brand linking home', () => {
		expect(source).toMatch(/<Breadcrumb\.Link href=\{localizeHref\('\/'\)\}>\{m\.app_name\(\)\}/);
	});

	it('never references the removed /inbox, /templates, /contacts, or /automation routes', () => {
		expect(source).not.toMatch(/nav_inbox|nav_templates|nav_contacts|nav_automation/);
		expect(source).not.toMatch(/\/inbox|\/templates|\/contacts|\/automation/);
	});

	it('never falls back to repeating the brand name for an unrecognized route', () => {
		expect(source).not.toMatch(/return m\.app_name\(\)/);
		expect(source).toContain('breadcrumbFallbackLabel');
	});

	it('only renders the second crumb when a label is available, never an empty one', () => {
		expect(source).toMatch(/\{:else if routeLabel !== null\}/);
	});

	it('identifies the active settings subsection as a third crumb', () => {
		expect(source).toMatch(/currentPath === '\/settings\/members'.*m\.settings_tab_members/);
		expect(source).toMatch(
			/currentPath === '\/settings\/invitations'.*m\.settings_tab_invitations/
		);
		expect(source).toMatch(/currentPath === '\/settings\/api-keys'.*m\.settings_tab_api_keys/);
		expect(source).toMatch(/\{#if settingsChildLabel !== null\}/);
	});

	it('renders the intermediate settings crumb as a Page, never a link to /settings', () => {
		// /settings is only a redirector (non-member accept flow, role-based
		// handoff), not a stable page, so a caller already on a child route
		// must not be offered it as a navigation target.
		const pageCount = source.match(/<Breadcrumb\.Page>/g) ?? [];
		expect(pageCount.length).toBeGreaterThanOrEqual(2);
		expect(source).not.toMatch(/<Breadcrumb\.Link[^>]*\/settings/);
		expect(source).not.toMatch(/href=\{localizeHref\('\/settings'\)\}/);
	});
});
