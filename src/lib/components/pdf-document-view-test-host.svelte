<script lang="ts">
	import PdfDocumentView, { type PdfRenderedPage } from './pdf-document-view.svelte';

	let {
		src,
		label = 'Agreement document',
		expectedPageCount = 2,
		loadingLabel = 'Loading the agreement…',
		errorTitle = 'The agreement could not be displayed',
		errorDescription = 'Reload this page to try again, or open the document in a new tab.',
		openLabel = 'Open the agreement',
		class: className = '',
		wrapperStyle = ''
	}: {
		src: string;
		label?: string;
		expectedPageCount?: number;
		loadingLabel?: string;
		errorTitle?: string;
		errorDescription?: string;
		openLabel?: string;
		class?: string;
		wrapperStyle?: string;
	} = $props();
</script>

<div style={wrapperStyle} data-testid="pdf-view-wrapper">
	<PdfDocumentView
		{src}
		{label}
		{expectedPageCount}
		{loadingLabel}
		{errorTitle}
		{errorDescription}
		{openLabel}
		class={className}
	>
		{#snippet overlay(page: PdfRenderedPage)}
			<div
				data-testid={`overlay-${page.pageNumber}`}
				class="absolute rounded border-2 border-primary bg-primary/20"
				style="left: 10%; top: 20%; width: 30%; height: 6%;"
			></div>
		{/snippet}
	</PdfDocumentView>
</div>
