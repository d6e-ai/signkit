<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconArrowRight from '@tabler/icons-svelte/icons/arrow-right';
	import IconFileText from '@tabler/icons-svelte/icons/file-text';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Empty from '$lib/components/ui/empty';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import * as Table from '$lib/components/ui/table';
	import { tabsListVariants } from '$lib/components/ui/tabs';
	import type {
		DashboardCounts,
		DashboardItem,
		DashboardView
	} from '$lib/application/dashboard/model';
	import type { EnvelopeStatus } from '$lib/domain/envelope';
	import * as m from '$lib/paraglide/messages';
	import { getLocale, localizeHref } from '$lib/paraglide/runtime';
	import type { PageData } from './$types';

	interface WorklistError {
		status: number;
		message: string;
	}

	let { data }: { data: PageData } = $props();

	const dashboardViews: readonly DashboardView[] = [
		'all',
		'action_required',
		'waiting',
		'drafts',
		'completed'
	];

	const viewTabLabel = (view: DashboardView): string =>
		view === 'all'
			? m.dashboard_tab_all()
			: view === 'action_required'
				? m.dashboard_tab_action_required()
				: view === 'waiting'
					? m.dashboard_tab_waiting()
					: view === 'drafts'
						? m.dashboard_tab_drafts()
						: m.dashboard_tab_completed();

	const viewTabCount = (view: DashboardView, counts: DashboardCounts): number =>
		view === 'all'
			? counts.all
			: view === 'action_required'
				? counts.actionRequired
				: view === 'waiting'
					? counts.waiting
					: view === 'drafts'
						? counts.drafts
						: counts.completed;

	const statusLabel = (status: EnvelopeStatus): string =>
		status === 'draft'
			? m.envelope_status_draft()
			: status === 'ready'
				? m.envelope_status_ready()
				: status === 'sent'
					? m.envelope_status_sent()
					: status === 'in_progress'
						? m.envelope_status_in_progress()
						: status === 'completed'
							? m.envelope_status_completed()
							: status === 'declined'
								? m.envelope_status_declined()
								: status === 'expired'
									? m.envelope_status_expired()
									: m.envelope_status_voided();

	const statusVariant = (status: EnvelopeStatus): 'default' | 'secondary' | 'outline' =>
		status === 'completed'
			? 'default'
			: status === 'voided' || status === 'declined' || status === 'expired'
				? 'outline'
				: 'secondary';

	// The status badge already names draft/ready/completed/declined/expired/
	// voided -- this only ever adds a second line for the two *active*
	// statuses, where there is real information the badge alone can't carry
	// (whose turn it is, or how far along a multi-signer envelope is). It
	// never implies a terminal envelope is still progressing, and never
	// changes an envelope's real signing authority or where the row links to.
	const secondaryStatusText = (item: DashboardItem): string | null => {
		if (item.envelope.status !== 'sent' && item.envelope.status !== 'in_progress') return null;
		if (item.actionRequired) return m.dashboard_row_action_required_label();
		if (item.nextRecipient !== null) {
			return m.dashboard_row_waiting_on({
				name: item.nextRecipient.name || item.nextRecipient.email
			});
		}
		// Every actionable recipient already has their own turn tracked above;
		// an envelope with zero actionable (signer/approver) recipients has no
		// meaningful "N/M completed" to show, so render nothing rather than a
		// fabricated "0/0".
		if (item.actionableRecipientCount === 0) return null;
		return m.dashboard_row_progress({
			completed: item.completedRecipientCount,
			total: item.actionableRecipientCount
		});
	};

	const recipientExtraCount = (item: DashboardItem): number => Math.max(item.recipientCount - 1, 0);

	const rowActionLabel = (status: EnvelopeStatus): string =>
		status === 'draft' || status === 'ready'
			? m.dashboard_row_action_continue()
			: m.dashboard_row_action_open();

	// A table full of identical "Open"/"Continue editing" links reads the
	// same to a screen reader; the accessible name must carry which
	// agreement each one opens.
	const rowActionAccessibleName = (item: DashboardItem): string =>
		item.envelope.status === 'draft' || item.envelope.status === 'ready'
			? m.dashboard_row_action_continue_named({ title: item.envelope.title })
			: m.dashboard_row_action_open_named({ title: item.envelope.title });

	function formatDate(value: string): string {
		return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
			new Date(value)
		);
	}

	// Tab/search/pagination links all derive from the current query state so
	// that switching views, searching, or paging is a real navigation (back/
	// forward and bookmarking work, and SSR `load` supplies the data -- no
	// client fetch). Every override is explicit about view/q rather than
	// relying on them already being present in the ambient URL, so a link is
	// correct even if built from data alone.
	function buildHref(overrides: {
		view?: DashboardView;
		q?: string;
		cursor?: string | null;
	}): string {
		const url = new URL(page.url);
		if (overrides.view !== undefined) {
			url.searchParams.set('view', overrides.view);
			url.searchParams.delete('cursor');
		}
		if (overrides.q !== undefined) {
			if (overrides.q) url.searchParams.set('q', overrides.q);
			else url.searchParams.delete('q');
			url.searchParams.delete('cursor');
		}
		if ('cursor' in overrides) {
			if (overrides.cursor) url.searchParams.set('cursor', overrides.cursor);
			else url.searchParams.delete('cursor');
		}
		return localizeHref(`${url.pathname}${url.search}`);
	}

	function viewHref(view: DashboardView): string {
		return buildHref({ view, q: data.worklistQuery.query });
	}

	function clearSearchHref(): string {
		return buildHref({ view: data.worklistQuery.view, q: '' });
	}

	function firstPageHref(): string {
		return buildHref({ view: data.worklistQuery.view, q: data.worklistQuery.query, cursor: null });
	}

	function nextPageHref(cursor: string): string {
		return buildHref({ view: data.worklistQuery.view, q: data.worklistQuery.query, cursor });
	}

	// The backend's own problem detail is an English API string not meant for
	// end users in either locale; only the HTTP status is trustworthy enough
	// to localize into user-facing copy.
	function worklistErrorDescription(error: WorklistError): string {
		return error.status === 503
			? m.dashboard_error_description_unavailable()
			: m.dashboard_error_description_generic();
	}
</script>

<svelte:head>
	<title>{m.dashboard_title()} — {m.app_name()}</title>
</svelte:head>

<div class="flex w-full flex-col gap-6">
	<section class="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
		<h1 class="text-2xl font-semibold tracking-tight">{m.dashboard_title()}</h1>
		<Button href={localizeHref('/envelopes/new')}>
			<IconFileText data-icon="inline-start" />{m.dashboard_send_contract()}
		</Button>
	</section>

	<nav
		aria-label={m.dashboard_views_nav_label()}
		class={tabsListVariants({ variant: 'line', class: 'h-auto w-full flex-wrap overflow-x-auto' })}
	>
		{#each dashboardViews as view (view)}
			<Button
				href={viewHref(view)}
				variant={data.worklistQuery.view === view ? 'secondary' : 'ghost'}
				size="sm"
				aria-current={data.worklistQuery.view === view ? 'page' : undefined}
			>
				{viewTabLabel(view)}
				{#if data.worklist}
					<Badge variant={data.worklistQuery.view === view ? 'default' : 'secondary'}>
						{viewTabCount(view, data.worklist.counts)}
					</Badge>
				{/if}
			</Button>
		{/each}
	</nav>

	<form
		method="GET"
		action={localizeHref(page.url.pathname)}
		class="flex flex-wrap items-end gap-2"
	>
		<input type="hidden" name="view" value={data.worklistQuery.view} />
		<Field.FieldGroup class="min-w-48 flex-1 sm:w-96 sm:flex-none">
			<Field.Field>
				<Field.FieldLabel for="dashboard-search">{m.dashboard_search_label()}</Field.FieldLabel>
				<Input
					id="dashboard-search"
					type="search"
					name="q"
					placeholder={m.dashboard_search_placeholder()}
					value={data.worklistQuery.query}
				/>
			</Field.Field>
		</Field.FieldGroup>
		<Button type="submit" variant="outline">{m.dashboard_search_submit()}</Button>
	</form>

	{#if data.worklistQuery.view === 'action_required' && data.worklist && data.worklist.items.length > 0}
		<p class="text-sm text-muted-foreground">{m.dashboard_action_required_hint()}</p>
	{/if}

	{#if data.worklistError}
		<Alert.Root variant="destructive">
			<IconAlertTriangle />
			<Alert.Title>{m.dashboard_error_title()}</Alert.Title>
			<Alert.Description class="flex flex-col gap-3">
				<p>{worklistErrorDescription(data.worklistError)}</p>
				<Button variant="outline" class="w-fit" onclick={() => void invalidateAll()}>
					{m.common_retry()}
				</Button>
			</Alert.Description>
		</Alert.Root>
	{:else if data.worklist === null || data.worklist.items.length === 0}
		<Empty.Root>
			<Empty.Header>
				<Empty.Media variant="icon"><IconFileText /></Empty.Media>
				{#if data.worklist === null || data.worklist.counts.all === 0}
					<Empty.Title>{m.dashboard_empty_workspace_title()}</Empty.Title>
					<Empty.Description>{m.dashboard_empty_workspace_description()}</Empty.Description>
				{:else if data.worklistQuery.query !== ''}
					<Empty.Title>{m.dashboard_empty_search_title()}</Empty.Title>
					<Empty.Description>{m.dashboard_empty_search_description()}</Empty.Description>
				{:else}
					<Empty.Title>{m.dashboard_empty_view_title()}</Empty.Title>
					<Empty.Description>{m.dashboard_empty_view_description()}</Empty.Description>
				{/if}
			</Empty.Header>
			<Empty.Content>
				{#if data.worklist !== null && data.worklist.counts.all > 0 && data.worklistQuery.query !== ''}
					<Button variant="outline" href={clearSearchHref()}>{m.dashboard_clear_search()}</Button>
				{:else if data.worklist !== null && data.worklist.counts.all > 0 && data.worklistQuery.view !== 'all'}
					<Button variant="outline" href={viewHref('all')}>{m.dashboard_tab_all()}</Button>
				{:else}
					<Button href={localizeHref('/envelopes/new')}>
						<IconFileText data-icon="inline-start" />{m.dashboard_send_contract()}
					</Button>
				{/if}
			</Empty.Content>
		</Empty.Root>
	{:else}
		<div class="overflow-x-auto rounded-xl border">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>{m.dashboard_col_agreement()}</Table.Head>
						<Table.Head>{m.dashboard_col_recipient()}</Table.Head>
						<Table.Head>{m.dashboard_col_status()}</Table.Head>
						<Table.Head>{m.dashboard_col_updated()}</Table.Head>
						<Table.Head class="text-right">{m.dashboard_col_actions()}</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.worklist.items as item (item.envelope.id)}
						<Table.Row>
							<Table.Cell class="font-medium">
								<a href={localizeHref(`/envelopes/${item.envelope.id}`)} class="hover:underline">
									{item.envelope.title}
								</a>
							</Table.Cell>
							<Table.Cell>
								{#if item.recipient}
									<div class="flex flex-col">
										<span>{item.recipient.name || item.recipient.email}</span>
										{#if recipientExtraCount(item) > 0}
											<span class="text-xs text-muted-foreground">
												{m.dashboard_row_recipient_more({ count: recipientExtraCount(item) })}
											</span>
										{/if}
									</div>
								{:else}
									<span class="text-muted-foreground">{m.dashboard_row_no_recipients()}</span>
								{/if}
							</Table.Cell>
							<Table.Cell>
								<div class="flex flex-col gap-1">
									<Badge variant={statusVariant(item.envelope.status)}>
										{statusLabel(item.envelope.status)}
									</Badge>
									{#if secondaryStatusText(item)}
										<span class="text-xs text-muted-foreground">{secondaryStatusText(item)}</span>
									{/if}
								</div>
							</Table.Cell>
							<Table.Cell class="text-muted-foreground">
								{formatDate(item.envelope.updatedAt)}
							</Table.Cell>
							<Table.Cell class="text-right">
								<Button
									href={localizeHref(`/envelopes/${item.envelope.id}`)}
									variant="outline"
									size="sm"
									aria-label={rowActionAccessibleName(item)}
								>
									{rowActionLabel(item.envelope.status)}
									<IconArrowRight data-icon="inline-end" />
								</Button>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>

		{#if data.worklistQuery.cursor !== null || data.worklist.nextCursor}
			<div class="flex items-center justify-center gap-2">
				{#if data.worklistQuery.cursor !== null}
					<Button variant="outline" href={firstPageHref()}>{m.dashboard_pagination_first()}</Button>
				{/if}
				{#if data.worklist.nextCursor}
					<Button variant="outline" href={nextPageHref(data.worklist.nextCursor)}>
						{m.dashboard_pagination_next()}
					</Button>
				{/if}
			</div>
		{/if}
	{/if}
</div>
