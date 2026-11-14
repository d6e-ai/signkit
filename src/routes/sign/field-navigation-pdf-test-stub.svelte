<script lang="ts" module>
	import { SvelteMap } from 'svelte/reactivity';
	const pending = new SvelteMap<string, () => void>();

	export function pdfLoad(src: string): (() => void) | undefined {
		return pending.get(src);
	}
</script>

<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import type { PdfRenderedPage } from '$lib/components/pdf-document-view.svelte';

	let {
		src,
		overlay,
		onpages
	}: {
		src: string;
		overlay?: Snippet<[PdfRenderedPage]>;
		onpages?: (pages: readonly PdfRenderedPage[]) => void;
	} = $props();
	let ready = $state(false);
	const page: PdfRenderedPage = { pageNumber: 1, widthPoints: 595.28, heightPoints: 841.89 };

	onMount(() => {
		const notify = onpages;
		pending.set(src, () => {
			ready = true;
			notify?.([page]);
		});
		return () => {
			pending.delete(src);
		};
	});
</script>

<div data-testid="document-preview" data-src={src}>
	<a href={src} target="_blank" rel="noopener">Open the agreement</a>
	{#if ready}
		<div class="relative w-full" style="aspect-ratio: 595.28 / 841.89;" data-pdf-page="1">
			{#if overlay}{@render overlay(page)}{/if}
		</div>
	{/if}
</div>
