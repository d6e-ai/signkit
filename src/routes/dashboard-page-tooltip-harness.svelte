<script lang="ts">
	import * as Tooltip from '$lib/components/ui/tooltip';
	import DashboardPage from './+page.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<!-- The shared layout supplies Tooltip.Provider; standalone
     SSR/unit tests of `+page.svelte` render it in isolation, so they need
     this faithful stand-in instead of a production provider nested inside
     the page itself. -->
<Tooltip.Provider>
	<DashboardPage {data} />
</Tooltip.Provider>
