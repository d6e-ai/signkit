<script lang="ts">
	// Root client-navigation overlay. Breadcrumbs stay visible in the
	// header; this covers the content below h-16. Full-page href
	// navigations never set navigating.to.
	import { navigating } from '$app/state';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as m from '$lib/paraglide/messages';

	const navigationPending = $derived(navigating.to !== null);
</script>

{#if navigationPending}
	<div
		class="fixed inset-x-0 top-16 bottom-0 z-50 cursor-wait bg-background/50 backdrop-blur-sm"
		aria-busy="true"
		aria-live="polite"
	>
		<div class="flex justify-center pt-8">
			<div class="flex items-center gap-3 rounded-lg border bg-background/90 px-6 py-4 shadow-lg">
				<Spinner class="size-6" />
				<span class="text-sm font-medium text-muted-foreground">{m.nav_loading()}</span>
			</div>
		</div>
	</div>
{/if}
