<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import IconFileText from '@tabler/icons-svelte/icons/file-text';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Spinner } from '$lib/components/ui/spinner';
	import { createEnvelopesClient, EnvelopesApiError, type Envelope } from '$lib/client/envelopes';
	import * as m from '$lib/paraglide/messages';
	import { getLocale, localizeHref } from '$lib/paraglide/runtime';

	const client = createEnvelopesClient();

	let loading = $state(true);
	let loadingMore = $state(false);
	let authRequired = $state(false);
	let errorMessage = $state<string | null>(null);
	let items = $state<Envelope[]>([]);
	let nextCursor = $state<string | null>(null);

	const signInHref = $derived(
		localizeHref(`/auth/login?return=${encodeURIComponent(page.url.pathname)}`)
	);

	function statusVariant(status: Envelope['status']): 'default' | 'secondary' | 'outline' {
		if (status === 'completed') return 'default';
		if (status === 'voided' || status === 'declined' || status === 'expired') return 'outline';
		return 'secondary';
	}

	function statusLabel(status: Envelope['status']): string {
		switch (status) {
			case 'draft':
				return m.envelope_status_draft();
			case 'ready':
				return m.envelope_status_ready();
			case 'sent':
				return m.envelope_status_sent();
			case 'in_progress':
				return m.envelope_status_in_progress();
			case 'completed':
				return m.envelope_status_completed();
			case 'declined':
				return m.envelope_status_declined();
			case 'expired':
				return m.envelope_status_expired();
			case 'voided':
				return m.envelope_status_voided();
		}
	}

	function formatDate(value: string): string {
		return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
			new Date(value)
		);
	}

	async function load(): Promise<void> {
		loading = true;
		authRequired = false;
		errorMessage = null;
		try {
			const result = await client.list({ limit: 25 });
			items = [...result.items];
			nextCursor = result.nextCursor;
		} catch (cause) {
			if (cause instanceof EnvelopesApiError && cause.status === 401) {
				authRequired = true;
			} else {
				errorMessage =
					cause instanceof EnvelopesApiError ? cause.detail : m.envelope_list_unavailable();
			}
		} finally {
			loading = false;
		}
	}

	async function loadMore(): Promise<void> {
		if (nextCursor === null || loadingMore) return;
		loadingMore = true;
		try {
			const result = await client.list({ limit: 25, cursor: nextCursor });
			items = [...items, ...result.items];
			nextCursor = result.nextCursor;
		} catch (cause) {
			errorMessage =
				cause instanceof EnvelopesApiError ? cause.detail : m.envelope_list_unavailable();
		} finally {
			loadingMore = false;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<svelte:head>
	<title>{m.envelope_list_title()} — {m.app_name()}</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-6">
	<section class="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">{m.envelope_list_title()}</h1>
			<p class="mt-1 text-sm text-muted-foreground">{m.envelope_list_description()}</p>
		</div>
		<Button href={localizeHref('/envelopes/new')}>
			<IconPlus data-icon="inline-start" />{m.new_agreement()}
		</Button>
	</section>

	{#if authRequired}
		<Card.Root>
			<Card.Content class="flex flex-col items-center gap-4 py-10 text-center">
				<IconAlertTriangle class="text-muted-foreground" />
				<p class="text-sm text-muted-foreground">{m.envelope_sign_in_required()}</p>
				<Button href={signInHref}>{m.sign_in()}</Button>
			</Card.Content>
		</Card.Root>
	{:else if loading}
		<div class="flex flex-col gap-3">
			<Skeleton class="h-20 w-full rounded-2xl" />
			<Skeleton class="h-20 w-full rounded-2xl" />
			<Skeleton class="h-20 w-full rounded-2xl" />
			<Skeleton class="h-20 w-full rounded-2xl" />
		</div>
	{:else if errorMessage}
		<Card.Root class="border-destructive/30">
			<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
				<p class="text-sm font-medium text-destructive">{errorMessage}</p>
				<Button variant="outline" onclick={() => void load()}>{m.common_retry()}</Button>
			</Card.Content>
		</Card.Root>
	{:else if items.length === 0}
		<Card.Root>
			<Card.Content class="flex flex-col items-center gap-4 py-14 text-center">
				<div
					class="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground"
				>
					<IconFileText />
				</div>
				<div>
					<p class="font-medium">{m.envelope_list_empty_title()}</p>
					<p class="mt-1 text-sm text-muted-foreground">{m.envelope_list_empty_description()}</p>
				</div>
				<Button href={localizeHref('/envelopes/new')}>
					<IconPlus data-icon="inline-start" />{m.new_agreement()}
				</Button>
			</Card.Content>
		</Card.Root>
	{:else}
		<Card.Root class="overflow-hidden">
			<div class="divide-y">
				{#each items as envelope (envelope.id)}
					<a
						href={localizeHref(`/envelopes/${envelope.id}`)}
						class="grid gap-2 px-6 py-4 transition-colors hover:bg-muted/45 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
					>
						<div class="min-w-0">
							<div class="flex items-center gap-2">
								<p class="truncate text-sm font-medium">{envelope.title}</p>
								<Badge variant={statusVariant(envelope.status)}
									>{statusLabel(envelope.status)}</Badge
								>
							</div>
							<p class="mt-1 text-xs text-muted-foreground">
								{m.envelope_updated_at({ timestamp: formatDate(envelope.updatedAt) })}
							</p>
						</div>
					</a>
				{/each}
			</div>
		</Card.Root>
		{#if nextCursor !== null}
			<div class="flex justify-center">
				<Button variant="outline" disabled={loadingMore} onclick={() => void loadMore()}>
					{#if loadingMore}<Spinner data-icon="inline-start" />{/if}
					{m.envelope_list_load_more()}
				</Button>
			</div>
		{/if}
	{/if}
</div>
