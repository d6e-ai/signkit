<script lang="ts">
	import { IconSearch } from '@tabler/icons-svelte';
	import AppSidebar from '$lib/components/app-sidebar.svelte';
	import LanguageSwitch from '$lib/components/language-switch.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Sidebar from '$lib/components/ui/sidebar';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import favicon from '$lib/assets/favicon.svg';
	import './layout.css';
	import * as m from '$lib/paraglide/messages';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>{m.app_name()} — Markdown-native agreements</title>
	<meta
		name="description"
		content="An open-core, agent-ready agreement and electronic signature platform."
	/>
</svelte:head>

<Tooltip.Provider>
	<Sidebar.Provider>
		<AppSidebar />
		<Sidebar.Inset class="min-w-0 overflow-hidden bg-muted/25">
			<header
				class="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur-xl"
			>
				<Sidebar.Trigger />
				<div class="h-5 w-px bg-border"></div>
				<div class="hidden truncate text-sm font-medium sm:block">{m.nav_dashboard()}</div>
				<div class="ml-auto flex min-w-0 items-center gap-1">
					<Button variant="ghost" size="icon" aria-label="Search" class="hidden sm:inline-flex"
						><IconSearch /></Button
					>
					<LanguageSwitch />
					<Button variant="outline" size="sm" href="/auth/login" class="shrink-0"
						><span class="sm:hidden">{m.sign_in_short()}</span><span class="hidden sm:inline"
							>{m.sign_in()}</span
						></Button
					>
				</div>
			</header>
			<main class="flex-1 p-4 md:p-6 lg:p-8">{@render children()}</main>
		</Sidebar.Inset>
	</Sidebar.Provider>
</Tooltip.Provider>
