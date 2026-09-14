<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { IconAlertTriangle, IconArrowRight, IconFileText } from '@tabler/icons-svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		createEnvelopesClient,
		fetchAllEnvelopes,
		EnvelopesApiError,
		type Envelope
	} from '$lib/client/envelopes';
	import * as m from '$lib/paraglide/messages';
	import { getLocale, localizeHref } from '$lib/paraglide/runtime';

	const client = createEnvelopesClient();

	let loading = $state(true);
	let authRequired = $state(false);
	let errorMessage = $state<string | null>(null);
	let envelopes = $state<Envelope[]>([]);

	const signInHref = $derived(
		localizeHref(`/auth/login?return=${encodeURIComponent(page.url.pathname)}`)
	);

	const actionNeeded = $derived(
		envelopes.filter((envelope) => envelope.status === 'draft' || envelope.status === 'ready')
			.length
	);
	const waiting = $derived(
		envelopes.filter((envelope) => envelope.status === 'sent' || envelope.status === 'in_progress')
			.length
	);
	const completed = $derived(
		envelopes.filter((envelope) => envelope.status === 'completed').length
	);
	const recent = $derived(
		[...envelopes]
			.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
			.slice(0, 6)
	);

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

	function statusClass(status: Envelope['status']): string {
		if (status === 'completed')
			return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300';
		if (status === 'sent' || status === 'in_progress')
			return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300';
		if (status === 'ready')
			return 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300';
		return '';
	}

	function formatDate(value: string): string {
		return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(new Date(value));
	}

	async function load(): Promise<void> {
		loading = true;
		authRequired = false;
		errorMessage = null;
		try {
			envelopes = await fetchAllEnvelopes(client);
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

	onMount(() => {
		void load();
	});
</script>

<div class="mx-auto flex w-full max-w-7xl flex-col gap-6">
	<section class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
		<div class="max-w-2xl">
			<h1 class="text-3xl font-semibold tracking-tight md:text-4xl">{m.dashboard_title()}</h1>
			<p class="mt-2 text-sm leading-6 text-muted-foreground md:text-base">
				{m.dashboard_description()}
			</p>
		</div>
		<Button size="lg" href={localizeHref('/envelopes/new')}
			><IconFileText data-icon="inline-start" />{m.new_agreement()}</Button
		>
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
		<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
			<Skeleton class="h-24 w-full rounded-2xl" />
			<Skeleton class="h-24 w-full rounded-2xl" />
			<Skeleton class="h-24 w-full rounded-2xl" />
			<Skeleton class="h-24 w-full rounded-2xl" />
		</div>
	{:else if errorMessage}
		<Card.Root class="border-destructive/30">
			<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
				<p class="text-sm font-medium text-destructive">{errorMessage}</p>
				<Button variant="outline" onclick={() => void load()}>{m.common_retry()}</Button>
			</Card.Content>
		</Card.Root>
	{:else}
		<section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
			<Card.Root
				><Card.Header class="pb-2"
					><Card.Description>{m.stat_action_needed()}</Card.Description></Card.Header
				><Card.Content><div class="text-3xl font-semibold">{actionNeeded}</div></Card.Content
				></Card.Root
			>
			<Card.Root
				><Card.Header class="pb-2"
					><Card.Description>{m.stat_waiting()}</Card.Description></Card.Header
				><Card.Content><div class="text-3xl font-semibold">{waiting}</div></Card.Content></Card.Root
			>
			<Card.Root
				><Card.Header class="pb-2"
					><Card.Description>{m.stat_completed()}</Card.Description></Card.Header
				><Card.Content><div class="text-3xl font-semibold">{completed}</div></Card.Content
				></Card.Root
			>
			<Card.Root
				><Card.Header class="pb-2"
					><Card.Description>{m.envelope_list_title()}</Card.Description></Card.Header
				><Card.Content><div class="text-3xl font-semibold">{envelopes.length}</div></Card.Content
				></Card.Root
			>
		</section>

		<Card.Root class="overflow-hidden">
			<Card.Header class="flex-row items-start justify-between gap-4"
				><div>
					<Card.Title>{m.recent_title()}</Card.Title><Card.Description
						>{m.recent_description()}</Card.Description
					>
				</div>
				<Button variant="ghost" size="sm" href={localizeHref('/envelopes')}
					>{m.view_all()}<IconArrowRight data-icon="inline-end" /></Button
				></Card.Header
			>
			<Card.Content class="px-0">
				{#if recent.length === 0}
					<p class="px-6 py-8 text-center text-sm text-muted-foreground">
						{m.envelope_list_empty_description()}
					</p>
				{:else}
					<div class="divide-y border-t">
						{#each recent as envelope (envelope.id)}
							<a
								href={localizeHref(`/envelopes/${envelope.id}`)}
								class="group grid gap-3 px-6 py-4 transition-colors hover:bg-muted/45 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
							>
								<div class="min-w-0">
									<div class="flex items-center gap-2">
										<p class="truncate text-sm font-medium">{envelope.title}</p>
										<Badge variant="outline" class={statusClass(envelope.status)}
											>{statusLabel(envelope.status)}</Badge
										>
									</div>
								</div>
								<div class="flex items-center gap-3 text-xs text-muted-foreground sm:justify-end">
									<span>{formatDate(envelope.updatedAt)}</span>
								</div>
							</a>
						{/each}
					</div>
				{/if}
			</Card.Content>
		</Card.Root>
	{/if}
</div>
