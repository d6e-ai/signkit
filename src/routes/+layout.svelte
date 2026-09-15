<script lang="ts">
	import { navigating } from '$app/state';
	import { ModeWatcher } from 'mode-watcher';
	import AppBreadcrumbs from '$lib/components/app-breadcrumbs.svelte';
	import AppSidebar from '$lib/components/app-sidebar.svelte';
	import LanguageSwitch from '$lib/components/language-switch.svelte';
	import ThemeSwitch from '$lib/components/theme-switch.svelte';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import favicon from '$lib/assets/favicon.svg';
	import { isRecipientSurfacePath } from '$lib/navigation/recipient-surface';
	import { isSetupSurfacePath } from '$lib/navigation/setup-surface';
	import { isSignedOutSurfacePath } from '$lib/navigation/signed-out-surface';
	import { page } from '$app/state';
	import './layout.css';
	import * as m from '$lib/paraglide/messages';

	let { data, children } = $props();
	let bareShell = $derived(
		isRecipientSurfacePath(page.url.pathname) ||
			isSignedOutSurfacePath(page.url.pathname) ||
			isSetupSurfacePath(page.url.pathname)
	);
	let navigationPending = $derived(navigating.to !== null);
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>{m.app_name()}</title>
	<meta name="description" content="Electronic signature workspace." />
</svelte:head>

<!-- Applies the stored theme before paint, so a dark-mode reader does not get a
     white flash on every navigation. -->
<ModeWatcher />

<Tooltip.Provider>
	{#if bareShell}
		<div class="min-h-svh bg-muted/25">
			<!-- Header contents share the same container as the page body, so the
			     brand and the page content line up on wide screens instead of the
			     header running edge to edge past it. -->
			<header class="border-b bg-background/90 backdrop-blur-xl">
				<div class="container mx-auto flex h-16 w-full items-center px-4 sm:px-6">
					<a href="/" class="font-semibold tracking-tight">{m.app_name()}</a>
					<div class="ml-auto flex items-center gap-1">
						<ThemeSwitch />
						<LanguageSwitch />
					</div>
				</div>
			</header>
			<main class="container mx-auto w-full px-4 py-6 sm:px-6 sm:py-8 lg:py-10">
				{@render children()}
			</main>
		</div>
	{:else}
		<Sidebar.Provider>
			<AppSidebar
				name={data.name ?? null}
				email={data.email ?? null}
				instanceMemberRole={data.instanceMemberRole ?? null}
			/>
			<Sidebar.Inset class="min-w-0">
				<header
					class="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur-xl"
				>
					<Sidebar.Trigger />
					{#if navigationPending}
						<Spinner aria-label={m.nav_loading()} />
					{:else}
						<AppBreadcrumbs />
					{/if}
					<div class="ml-auto flex min-w-0 items-center gap-1">
						<ThemeSwitch />
						<LanguageSwitch />
					</div>
				</header>
				<main class="flex-1 px-4 py-6">{@render children()}</main>
			</Sidebar.Inset>
		</Sidebar.Provider>
	{/if}
</Tooltip.Provider>
