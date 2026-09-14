<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
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
		type Envelope,
		type EnvelopeDetailResponse
	} from '$lib/client/envelopes';
	import { isActionableRecipientRole } from '$lib/domain/envelope';
	import * as m from '$lib/paraglide/messages';
	import { getLocale, localizeHref } from '$lib/paraglide/runtime';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const client = createEnvelopesClient();

	// A ceiling on simultaneously in-flight detail requests, not a batch
	// size: every active envelope is still covered, just at most this many
	// requests are ever outstanding at once, so a caller with hundreds of
	// active envelopes doesn't fire hundreds of concurrent requests.
	// Kept at 8 or below so a large workspace never fans out unbounded.
	const DETAIL_FETCH_CONCURRENCY = 8;

	let loading = $state(true);
	let authRequired = $state(false);
	let errorMessage = $state<string | null>(null);
	let envelopes = $state<Envelope[]>([]);

	let statsLoading = $state(false);
	let statsError = $state<string | null>(null);
	let actionNeeded = $state(0);
	let waiting = $state(0);

	// Guards against two overlapping `loadStats` calls (the initial load and
	// a caller-triggered retry) racing to publish state: only the call that
	// is still the latest when its work finishes may write `actionNeeded`,
	// `waiting`, `statsError`, or `statsLoading`. Without this, a slow first
	// attempt that eventually fails could overwrite a faster retry's success
	// with a stale failure, landing exactly on the "false zero" this page is
	// otherwise careful to avoid.
	let statsRequestGeneration = 0;
	let destroyed = false;

	onDestroy(() => {
		destroyed = true;
	});

	async function fetchDetailsWithConcurrencyLimit(
		targets: readonly Envelope[],
		isStale: () => boolean
	): Promise<EnvelopeDetailResponse[]> {
		const results: EnvelopeDetailResponse[] = new Array(targets.length);
		let nextIndex = 0;
		async function worker(): Promise<void> {
			while (!isStale()) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= targets.length) return;
				results[index] = await client.getDetail(targets[index].id);
			}
		}
		const workerCount = Math.min(DETAIL_FETCH_CONCURRENCY, targets.length);
		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		return results;
	}

	const signInHref = $derived(
		localizeHref(`/auth/login?return=${encodeURIComponent(page.url.pathname)}`)
	);

	// Only sent/in-progress envelopes carry recipients that can still act, so
	// these are the only ones worth a detail fetch -- a draft or a completed
	// envelope can never contribute to either bucket below.
	const activeEnvelopes = $derived(
		envelopes.filter((envelope) => envelope.status === 'sent' || envelope.status === 'in_progress')
	);

	const recent = $derived(
		[...envelopes]
			.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
			.slice(0, 6)
	);

	function normalizeEmail(value: string): string {
		return value.trim().toLowerCase();
	}

	const normalizedSelfEmail = $derived(data.email ? normalizeEmail(data.email) : '');

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

	// Loads recipient detail for every active envelope and buckets each one
	// into at most one of the two counts. A caller never appears in both: an
	// envelope only reaches the "waiting" branch once it has already failed
	// the "action needed" check.
	async function loadStats(): Promise<void> {
		const generation = ++statsRequestGeneration;
		const isStale = (): boolean => destroyed || generation !== statsRequestGeneration;
		const active = activeEnvelopes;
		if (active.length === 0) {
			if (isStale()) return;
			actionNeeded = 0;
			waiting = 0;
			statsError = null;
			statsLoading = false;
			return;
		}
		statsLoading = true;
		statsError = null;
		try {
			const details = await fetchDetailsWithConcurrencyLimit(active, isStale);
			// A newer call (a fresh mount's initial load, or a caller-triggered
			// retry) has since become the one allowed to publish -- this result
			// is stale even though it succeeded, and must not overwrite
			// whatever the latest call has already written or is still loading.
			if (isStale()) return;
			let action = 0;
			let waitingOnOthers = 0;
			for (const detail of details) {
				const actionable = detail.recipients.filter((recipient) =>
					isActionableRecipientRole(recipient.role)
				);
				const isCurrentUserPending = actionable.some(
					(recipient) =>
						normalizeEmail(recipient.email) === normalizedSelfEmail &&
						(recipient.status === 'pending' || recipient.status === 'viewed')
				);
				if (isCurrentUserPending) {
					action += 1;
					continue;
				}
				const hasOtherPending = actionable.some(
					(recipient) =>
						normalizeEmail(recipient.email) !== normalizedSelfEmail &&
						(recipient.status === 'pending' || recipient.status === 'viewed')
				);
				if (hasOtherPending) waitingOnOthers += 1;
			}
			actionNeeded = action;
			waiting = waitingOnOthers;
			statsLoading = false;
		} catch (cause) {
			if (isStale()) return;
			// A detail-load failure must never be mistaken for "nothing pending":
			// this leaves the prior counts alone and surfaces an explicit error
			// with its own retry instead of quietly rendering zero.
			statsError =
				cause instanceof EnvelopesApiError ? cause.detail : m.envelope_list_unavailable();
			statsLoading = false;
		}
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
			loading = false;
			return;
		}
		loading = false;
		await loadStats();
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
		<div class="grid gap-3 sm:grid-cols-2">
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
		<section class="grid gap-3 sm:grid-cols-2">
			{#if statsError}
				<div class="sm:col-span-2">
					<Card.Root class="border-destructive/30">
						<Card.Content class="flex flex-col items-center gap-3 py-6 text-center">
							<p class="text-sm font-medium text-destructive">{statsError}</p>
							<Button
								variant="outline"
								size="sm"
								disabled={statsLoading}
								onclick={() => void loadStats()}
							>
								{m.common_retry()}
							</Button>
						</Card.Content>
					</Card.Root>
				</div>
			{:else if statsLoading}
				<Skeleton class="h-24 w-full rounded-2xl" />
				<Skeleton class="h-24 w-full rounded-2xl" />
			{:else}
				<Card.Root
					><Card.Header class="pb-2"
						><Card.Description>{m.stat_action_needed()}</Card.Description></Card.Header
					><Card.Content><div class="text-3xl font-semibold">{actionNeeded}</div></Card.Content
					></Card.Root
				>
				<Card.Root
					><Card.Header class="pb-2"
						><Card.Description>{m.stat_waiting()}</Card.Description></Card.Header
					><Card.Content><div class="text-3xl font-semibold">{waiting}</div></Card.Content
					></Card.Root
				>
			{/if}
		</section>

		<Card.Root class="overflow-hidden">
			<Card.Header>
				<Card.Title>{m.recent_title()}</Card.Title>
				<Card.Description>{m.recent_description()}</Card.Description>
				<Card.Action>
					<Button variant="ghost" size="sm" href={localizeHref('/envelopes')}
						>{m.view_all()}<IconArrowRight data-icon="inline-end" /></Button
					>
				</Card.Action>
			</Card.Header>
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
