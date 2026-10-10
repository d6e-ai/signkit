<script lang="ts">
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconDownload from '@tabler/icons-svelte/icons/download';
	import IconFileTypePdf from '@tabler/icons-svelte/icons/file-type-pdf';
	import { page } from '$app/state';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as m from '$lib/paraglide/messages';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	/**
	 * Built from the route param, not `data`: `view` is a real path segment, so a
	 * relative `../?format=pdf` link resolves against `/c/{token}/`, not
	 * `/c/{token}`, landing on the bare `/c/` collection route instead of the
	 * grant-scoped raw endpoint. An absolute path anchored on the token sidesteps
	 * that ambiguity entirely.
	 */
	const token = $derived(page.params.token as string);
</script>

<svelte:head>
	<title>{m.completion_receipt_title()} — {m.app_name()}</title>
</svelte:head>

<div class="flex min-h-[60vh] items-center">
	{#if data.state === 'published'}
		<Card.Root class="w-full">
			<Card.Header>
				<Card.Title>{m.completion_receipt_title()}</Card.Title>
				<Card.Description>{m.completion_receipt_description()}</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-3">
				{#if data.pdfAvailable}
					<Button href="/c/{token}?format=pdf" download="completion.pdf" class="w-fit">
						<IconFileTypePdf data-icon="inline-start" />
						{m.completion_receipt_pdf_download()}
					</Button>
				{:else}
					<p class="text-sm text-muted-foreground">{m.completion_receipt_pdf_pending()}</p>
				{/if}
				<div class="flex flex-wrap gap-2">
					<Button
						href="/c/{token}?format=json"
						download="completion-evidence.json"
						variant="outline"
					>
						<IconDownload data-icon="inline-start" />
						{m.completion_receipt_evidence_json_download()}
					</Button>
					<Button
						href="/c/{token}?format=markdown"
						download="completion-evidence.md"
						variant="outline"
					>
						<IconDownload data-icon="inline-start" />
						{m.completion_receipt_evidence_markdown_download()}
					</Button>
				</div>
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root class="w-full text-center shadow-sm">
			<Card.Header class="items-center gap-4 py-10">
				<div class="flex size-12 items-center justify-center rounded-2xl bg-muted text-foreground">
					<IconAlertTriangle class="size-6" />
				</div>
				<Card.Title>
					{data.state === 'unavailable'
						? m.completion_receipt_unavailable_title()
						: m.completion_receipt_invalid_title()}
				</Card.Title>
				<Card.Description class="leading-6">
					{data.state === 'unavailable'
						? m.completion_receipt_unavailable_description()
						: m.completion_receipt_invalid_description()}
				</Card.Description>
			</Card.Header>
		</Card.Root>
	{/if}
</div>
