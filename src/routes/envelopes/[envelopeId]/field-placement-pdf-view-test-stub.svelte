<script lang="ts">
	import type { Snippet } from 'svelte';

	interface RenderedPage {
		pageNumber: number;
		widthPoints: number;
		heightPoints: number;
	}

	let {
		overlay
	}: {
		overlay?: Snippet<[RenderedPage]>;
	} = $props();

	const page: RenderedPage = {
		pageNumber: 1,
		widthPoints: 595.28,
		heightPoints: 841.89
	};
</script>

<div class="flex flex-col gap-4">
	<div
		class="relative w-full overflow-hidden rounded-xl border bg-background shadow-sm"
		style="aspect-ratio: {page.widthPoints} / {page.heightPoints};"
		data-pdf-page={page.pageNumber}
	>
		{#if overlay}
			<div class="absolute inset-0">{@render overlay(page)}</div>
		{/if}
	</div>
</div>
