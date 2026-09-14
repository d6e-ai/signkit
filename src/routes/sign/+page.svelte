<script lang="ts">
	import { IconAlertTriangle } from '@tabler/icons-svelte';
	import * as Card from '$lib/components/ui/card';
	import * as m from '$lib/paraglide/messages';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{m.signing_page_title()} — {m.app_name()}</title>
	<meta name="robots" content="noindex,nofollow,noarchive" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="flex w-full flex-col items-center gap-6">
	<Card.Root class="w-full max-w-2xl text-center shadow-sm">
		<Card.Header class="items-center gap-4 py-10">
			<div class="flex size-12 items-center justify-center rounded-2xl bg-muted text-foreground">
				<IconAlertTriangle class="size-6" />
			</div>
			<Card.Title>
				{data.state === 'unavailable' ? m.signing_unavailable_title() : m.signing_invalid_title()}
			</Card.Title>
			<Card.Description class="max-w-md leading-6">
				{data.state === 'unavailable'
					? m.signing_unavailable_description()
					: m.signing_invalid_description()}
			</Card.Description>
		</Card.Header>
	</Card.Root>
</div>
