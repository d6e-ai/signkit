<script lang="ts">
	import { page } from '$app/state';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb';
	import { breadcrumbFallbackLabel } from '$lib/navigation/breadcrumb-fallback-label';
	import { deLocalizeHref, localizeHref } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';

	const currentPath = $derived(deLocalizeHref(page.url.pathname));

	// Falls back to a label derived from the path itself, never a repeated
	// `m.app_name()`: the root crumb already carries the brand, so a second
	// crumb with the same text for a route this component doesn't recognize
	// would read as "SignKit / SignKit" instead of a useful location.
	const routeLabel = $derived.by((): string | null => {
		if (currentPath === '/') return m.nav_dashboard();
		if (currentPath === '/envelopes/new') return m.new_agreement();
		if (currentPath.startsWith('/envelopes')) return m.nav_agreements();
		if (currentPath.startsWith('/settings')) return m.nav_settings();
		if (currentPath.startsWith('/setup')) return m.setup_title();
		return breadcrumbFallbackLabel(currentPath);
	});

	// A settings child route gets a third crumb identifying which subsection is
	// active, since "Instance administration" alone no longer distinguishes
	// Members from Invitations from API keys now that each is its own route.
	const settingsChildLabel = $derived.by((): string | null => {
		if (currentPath === '/settings/members') return m.settings_tab_members();
		if (currentPath === '/settings/invitations') return m.settings_tab_invitations();
		if (currentPath === '/settings/api-keys') return m.settings_tab_api_keys();
		return null;
	});
</script>

<Breadcrumb.Root>
	<Breadcrumb.List>
		<Breadcrumb.Item>
			<Breadcrumb.Link href={localizeHref('/')}>{m.app_name()}</Breadcrumb.Link>
		</Breadcrumb.Item>
		{#if routeLabel !== null}
			<Breadcrumb.Separator />
			<Breadcrumb.Item>
				<!-- Never a link: /settings is only a redirector for a non-member
				     accepting an invitation or an active member being routed to
				     their own child route -- it is not a stable page any caller
				     who is already on a settings child route could usefully land
				     back on. -->
				<Breadcrumb.Page>{routeLabel}</Breadcrumb.Page>
			</Breadcrumb.Item>
		{/if}
		{#if settingsChildLabel !== null}
			<Breadcrumb.Separator />
			<Breadcrumb.Item>
				<Breadcrumb.Page>{settingsChildLabel}</Breadcrumb.Page>
			</Breadcrumb.Item>
		{/if}
	</Breadcrumb.List>
</Breadcrumb.Root>
