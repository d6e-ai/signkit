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

	it('derives a non-empty display name (trimmed name -> trimmed email -> app name) for the account row', () => {
		expect(source).toContain('function displayName(): string {');
		expect(source).toMatch(/const trimmedName = name\?\.trim\(\);/);
		expect(source).toMatch(/if \(trimmedName\) return trimmedName;/);
		expect(source).toMatch(/const trimmedEmail = email\?\.trim\(\);/);
		expect(source).toMatch(/if \(trimmedEmail\) return trimmedEmail;/);
		expect(source).toMatch(/return m\.app_name\(\);/);
		expect(source).toContain('const accountDisplayName = $derived(displayName());');
		expect(source).toContain(
			'const accountInitial = $derived(accountDisplayName.charAt(0).toUpperCase());'
		);
	});

	it('uses the derived display name for the account row, the dropdown label, and the trigger aria-label', () => {
		expect(source).toMatch(/aria-label=\{accountDisplayName\}/);
		expect(source).not.toMatch(/aria-label=\{name \?\? email/);
		expect(source).not.toMatch(/\{name\}/);
		expect(source).not.toMatch(/d6e-auth/i);
	});

	it('matches the d6e-auth Header account identity typography in both the trigger and the dropdown label, tolerant of Prettier class reordering', () => {
		// Sibling ../d6e-auth Header.svelte renders the account name/email pair
		// with `font-medium`/`leading-none`, not `font-semibold`/`leading-tight`.
		// Prettier is free to reorder Tailwind classes and to break these
		// elements across lines (a stray `>` on its own line), so this asserts
		// token membership on the extracted class attribute rather than an
		// exact class string or exact tag layout.
		function classTokens(pattern: RegExp): string[] {
			const match: RegExpMatchArray | null = source.match(pattern);
			expect(match).not.toBeNull();
			return (match as RegExpMatchArray)[1].split(/\s+/).filter(Boolean);
		}

		const triggerNameClasses = classTokens(/<span class="([^"]*)"\s*>\s*\{accountDisplayName\}/);
		const triggerEmailClasses = classTokens(/<span class="([^"]*)"\s*>\s*\{email\}/);
		const dropdownNameClasses = classTokens(/<p class="([^"]*)"\s*>\s*\{accountDisplayName\}/);
		const dropdownEmailClasses = classTokens(/<p class="([^"]*)"\s*>\s*\{email\}/);

		const requiredNameClasses = ['truncate', 'text-sm', 'font-medium', 'leading-none'];
		const requiredEmailClasses = [
			'truncate',
			'text-muted-foreground',
			'mt-1',
			'text-xs',
			'leading-none'
		];

		for (const classes of [triggerNameClasses, dropdownNameClasses]) {
			for (const required of requiredNameClasses) {
				expect(classes).toContain(required);
			}
			expect(classes).not.toContain('font-semibold');
		}
		for (const classes of [triggerEmailClasses, dropdownEmailClasses]) {
			for (const required of requiredEmailClasses) {
				expect(classes).toContain(required);
			}
		}

		expect(source).not.toMatch(/leading-tight/);
	});

	it('gives the footer an account dropdown with only an identity label and a sign-out form', () => {
		const footerStart: number = source.indexOf('<Sidebar.Footer>');
		expect(footerStart).toBeGreaterThan(-1);
		const footerBlock: string = source.slice(footerStart);
		expect(footerBlock).toContain('<DropdownMenu.Root>');
		expect(footerBlock).toContain('method="POST" action="/auth/logout"');
	});

	it('removes the instance-administration/settings entry from the footer dropdown entirely', () => {
		const footerStart: number = source.indexOf('<Sidebar.Footer>');
		const footerBlock: string = source.slice(footerStart);
		expect(footerBlock).not.toMatch(/nav_settings|IconAdjustmentsHorizontal/);
	});

	it('never links to the fabricated /inbox, /templates, /contacts, or /automation routes', () => {
		expect(source).not.toMatch(/\/inbox|\/templates|\/contacts|\/automation/);
		expect(source).not.toMatch(/nav_inbox|nav_templates|nav_contacts|nav_automation/);
	});

	it('never renders a fabricated nav badge', () => {
		expect(source).not.toMatch(/MenuBadge|badge:/);
	});

	it('keeps the real Dashboard and Agreements destinations as flat items', () => {
		expect(source).toMatch(/m\.nav_dashboard\(\), href: '\/'/);
		expect(source).toMatch(/m\.nav_agreements\(\), href: '\/envelopes'/);
	});

	it('replaces the single settings link with an expandable Instance administration menu', () => {
		expect(source).toContain("from '$lib/components/ui/collapsible'");
		expect(source).toContain('<Collapsible.Root');
		expect(source).toContain('<Collapsible.Trigger>');
		expect(source).toContain('<Collapsible.Content>');
		expect(source).toContain('<Sidebar.MenuSub>');
		expect(source).toMatch(/tooltipContent=\{m\.nav_settings\(\)\}/);
	});

	it('composes Collapsible.Root via its child snippet so Sidebar.MenuItem is the direct ul child, never a wrapping div', () => {
		// A bare `<Collapsible.Root>...</Collapsible.Root>` around
		// `<Sidebar.MenuItem>` renders `<ul><div><li>...</li></div></ul>` --
		// invalid: a `<ul>`'s children must be `<li>` elements. The child
		// snippet lets Collapsible.Root render *as* whatever the snippet
		// returns instead of wrapping it in its own element, so
		// `Sidebar.MenuItem` (an `<li>`) becomes the actual root.
		const collapsibleRootMatch = source.match(
			/<Collapsible\.Root[^>]*>\s*\{#snippet child\(\{ props: collapsibleProps \}\)\}\s*<Sidebar\.MenuItem \{\.\.\.collapsibleProps\}>/
		);
		expect(collapsibleRootMatch).not.toBeNull();
	});

	it('links every settings sub-item to its own dedicated route', () => {
		expect(source).toMatch(/m\.settings_tab_members\(\), href: '\/settings\/members'/);
		expect(source).toMatch(/m\.settings_tab_invitations\(\), href: '\/settings\/invitations'/);
		expect(source).toMatch(/m\.settings_tab_api_keys\(\), href: '\/settings\/api-keys'/);
	});

	it('keeps contacts inside recipient authoring rather than adding a sidebar destination', () => {
		expect(source).not.toMatch(/href: ['"]\/contacts/);
		expect(source).not.toMatch(/nav_contacts/);
	});

	it('filters the settings submenu by instanceMemberRole: owner/admin see all three, a plain member sees only API keys, everyone else sees none', () => {
		expect(source).toContain('const visibleSettingsItems = $derived.by(() => {');
		expect(source).toMatch(
			/if \(instanceMemberRole === 'owner' \|\| instanceMemberRole === 'admin'\) return settingsItems;/
		);
		expect(source).toMatch(/if \(instanceMemberRole === 'member'\) \{/);
		expect(source).toMatch(
			/return settingsItems\.filter\(\(item\) => item\.href === '\/settings\/api-keys'\);/
		);
		expect(source).toMatch(/return \[\];\s*\}\);/);
		// The whole collapsible entry, not just its children, must disappear
		// when there is nothing privileged to show -- never a dead expandable
		// menu with an empty submenu inside.
		expect(source).toMatch(/\{#if visibleSettingsItems\.length > 0\}\s*<Collapsible\.Root/);
		expect(source).toContain('{#each visibleSettingsItems as item (item.href)}');
	});

	it('opens the settings menu automatically while on a settings route', () => {
		expect(source).toContain('onSettingsRoute');
		expect(source).toMatch(
			/\$effect\(\(\) => \{\s*if \(onSettingsRoute\) settingsMenuOpen = true;/
		);
	});

	it('expands an icon-collapsed sidebar when the settings trigger is clicked, composing (not replacing) the Collapsible trigger behavior via mergeProps', () => {
		expect(source).toContain("import { mergeProps } from 'bits-ui';");
		expect(source).toContain('function expandSidebarForSettings(): void {');
		expect(source).toMatch(/!sidebar\.isMobile && sidebar\.state === 'collapsed'/);
		expect(source).toContain('sidebar.setOpen(true);');
		expect(source).toMatch(/mergeProps\(triggerProps, \{ onclick: expandSidebarForSettings \}\)/);
	});

	it('navigates to settings sub-items via real anchors, not JS-only click handlers', () => {
		const subStart: number = source.indexOf('<Sidebar.MenuSub>');
		const subBlock: string = source.slice(subStart, source.indexOf('</Sidebar.MenuSub>'));
		expect(subBlock).not.toMatch(/onclick=\{.*window\.location/);
		expect(subBlock).toMatch(/<Sidebar\.MenuSubButton\s+href=\{localizeHref\(item\.href\)\}/);
	});
});
