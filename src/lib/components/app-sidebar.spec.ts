import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('app sidebar shell', () => {
	const source: string = readFileSync('src/lib/components/app-sidebar.svelte', 'utf8');

	it('uses the sidebar variant, not the rounded inset-shell variant', () => {
		expect(source).toContain('<Sidebar.Root variant="sidebar"');
		expect(source).not.toMatch(/variant="inset"/);
	});

	it('keeps Sidebar.Header itself at an exact h-16 with px-2 py-0, no additive vertical padding', () => {
		const headerMatch: RegExpMatchArray | null = source.match(
			/<Sidebar\.Header\s+class="([^"]*)"[^>]*>([\s\S]*?)<\/Sidebar\.Header>/
		);
		expect(headerMatch).not.toBeNull();
		const [, headerClass, headerBody] = headerMatch as RegExpMatchArray;

		expect(headerClass).toMatch(/\bh-16\b/);
		expect(headerClass).toMatch(/\bpx-2\b/);
		expect(headerClass).toMatch(/\bpy-0\b/);
		// A bare `p-*` (all-sides padding) or any non-zero `py-*` would stack on
		// top of the fixed h-16 and push the row past 64px -- the exact 80px
		// regression this row must never reintroduce.
		expect(headerClass).not.toMatch(/\bp-\d/);
		expect(headerClass).not.toMatch(/\bpy-[1-9]/);

		expect(headerBody).not.toMatch(/DropdownMenu|Popover/);
	});

	it('never nests the brand row inside an additional padded wrapper', () => {
		// The regression this guards: `Sidebar.Header class="p-2"` wrapping an
		// inner `h-16` div totals 64px + 16px = 80px, even though the row reads
		// as "h-16" at a glance.
		const headerMatch: RegExpMatchArray | null = source.match(
			/<Sidebar\.Header\s+class="([^"]*)"[^>]*>([\s\S]*?)<\/Sidebar\.Header>/
		);
		expect(headerMatch).not.toBeNull();
		const [, , headerBody] = headerMatch as RegExpMatchArray;
		expect(headerBody).not.toMatch(/\bh-16\b/);
	});

	it('shows the authenticated email in the footer via an email prop, never a d6e-auth label', () => {
		expect(source).toContain('let { email }: { email: string | null } = $props();');
		expect(source).toMatch(/<span[^>]*>\s*\{email\}\s*<\/span>/);
		expect(source).not.toMatch(/d6e-auth/i);
	});

	it('gives the footer an account dropdown with a sign-out form', () => {
		const footerStart: number = source.indexOf('<Sidebar.Footer>');
		expect(footerStart).toBeGreaterThan(-1);
		const footerBlock: string = source.slice(footerStart);
		expect(footerBlock).toContain('<DropdownMenu.Root>');
		expect(footerBlock).toContain('method="POST" action="/auth/logout"');
	});

	it('never links to the fabricated /inbox, /templates, /contacts, or /automation routes', () => {
		expect(source).not.toMatch(/\/inbox|\/templates|\/contacts|\/automation/);
		expect(source).not.toMatch(/nav_inbox|nav_templates|nav_contacts|nav_automation/);
	});

	it('never renders a fabricated nav badge', () => {
		expect(source).not.toMatch(/MenuBadge|badge:/);
	});

	it('keeps only the real Dashboard, Agreements, and Settings destinations', () => {
		expect(source).toMatch(/m\.nav_dashboard\(\), href: '\/'/);
		expect(source).toMatch(/m\.nav_agreements\(\), href: '\/envelopes'/);
		expect(source).toMatch(/m\.nav_settings\(\), href: '\/settings'/);
	});

	it('navigates to settings from the account dropdown via a real anchor, not a JS-only click handler', () => {
		const footerStart: number = source.indexOf('<Sidebar.Footer>');
		const footerBlock: string = source.slice(footerStart);
		expect(footerBlock).not.toMatch(/onclick=\{.*window\.location/);
		expect(footerBlock).toMatch(/<a \{\.\.\.props\} href=\{localizeHref\('\/settings'\)\}>/);
	});
});
