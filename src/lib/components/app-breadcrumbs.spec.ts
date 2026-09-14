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
		expect(source).toMatch(/startsWith\('\/envelopes'\).*m\.nav_agreements/);
		expect(source).toMatch(/startsWith\('\/settings'\).*m\.nav_settings/);
		expect(source).toMatch(/startsWith\('\/setup'\).*m\.setup_title/);
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
		expect(source).toMatch(/\{#if routeLabel !== null\}/);
	});
});
