<script lang="ts">
	import { ModeWatcher } from 'mode-watcher';
	import LanguageSwitch from '$lib/components/language-switch.svelte';
	import NavigationProgress from '$lib/components/navigation-progress.svelte';
	import ThemeSwitch from '$lib/components/theme-switch.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import './layout.css';
	import * as m from '$lib/paraglide/messages';

	// Every page this server renders is a recipient page (signing and the
	// completed-document view); operators use the d6e console.
	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
	<title>{m.app_name()}</title>
	<meta name="description" content="Electronic signature workspace." />
</svelte:head>

<!-- Applies the stored theme before paint, so a dark-mode reader does not get a
     white flash on every navigation. -->
<ModeWatcher />

<Tooltip.Provider>
	<div class="min-h-svh bg-muted/25">
		<!-- Header contents share the same container as the page body, so the
		     brand and the page content line up on wide screens instead of the
		     header running edge to edge past it. -->
		<header class="border-b bg-background/90 backdrop-blur-xl">
			<div class="container mx-auto flex h-16 w-full items-center px-4 sm:px-6">
				<span class="font-semibold tracking-tight">{m.app_name()}</span>
				<div class="ml-auto flex shrink-0 items-center gap-1">
					<ThemeSwitch />
					<LanguageSwitch />
				</div>
			</div>
		</header>
		<main class="container mx-auto w-full px-4 py-6 sm:px-6 sm:py-8 lg:py-10">
			{@render children()}
		</main>
	</div>
	<NavigationProgress />
</Tooltip.Provider>
