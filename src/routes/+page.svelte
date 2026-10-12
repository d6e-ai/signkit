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
	import * as Tabs from '$lib/components/ui/tabs';
	import type {
		DashboardCounts,
		DashboardItem,
		DashboardView
	} from '$lib/application/dashboard/model';
	import type { EnvelopeStatus } from '$lib/domain/envelope';
	import * as m from '$lib/paraglide/messages';
	import { getLocale, localizeHref } from '$lib/paraglide/runtime';
	import type { PageData } from './$types';

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

	// Never a sign/approve shortcut: `actionRequired` only ever changes which
	// of these labels is shown, never an envelope's real signing authority or
	// where the row links to.
	const progressLabel = (item: DashboardItem): string =>
		item.envelope.status === 'draft' || item.envelope.status === 'ready'
			? m.dashboard_row_not_sent()
			: item.actionRequired
				? m.dashboard_row_action_required_label()
				: (item.envelope.status === 'sent' || item.envelope.status === 'in_progress') &&
					  item.nextRecipient !== null
					? m.dashboard_row_waiting_on({
							name: item.nextRecipient.name || item.nextRecipient.email
						})
					: m.dashboard_row_progress({
							// Completion progress counts only recipients whose turn
							// actually matters to the outcome (signers/approvers), never
							// CC'd recipients -- `recipientCount` includes CC and would
							// otherwise understate progress on a fully-actionable
							// envelope.
							completed: item.completedRecipientCount,
							total: item.actionableRecipientCount
						});

	const recipientExtraCount = (item: DashboardItem): number => Math.max(item.recipientCount - 1, 0);

	const rowActionLabel = (status: EnvelopeStatus): string =>
		status === 'draft' || status === 'ready'
			? m.dashboard_row_action_continue()
			: m.dashboard_row_action_open();

	function formatDate(value: string): string {
		return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
			new Date(value)
		);
	}

	// Tab/search/pagination links all derive from the current URL so that
	// switching views or paging is a real navigation (back/forward and
	// bookmarking work, and SSR `load` supplies the data -- no client fetch).
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

	<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
		<Tabs.Root value={data.worklistQuery.view} class="w-full sm:w-auto">
			<Tabs.List variant="line" class="w-full overflow-x-auto sm:w-auto">
				{#each dashboardViews as view (view)}
					<a
						href={buildHref({ view, q: data.worklistQuery.query })}
						aria-current={data.worklistQuery.view === view ? 'page' : undefined}
						data-active={data.worklistQuery.view === view ? '' : undefined}
						class="relative inline-flex h-[calc(100%_-_1px)] flex-1 items-center justify-center gap-2 rounded-full border border-transparent px-3 py-1 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring data-active:bg-background data-active:text-foreground"
					>
						{viewTabLabel(view)}
						{#if data.worklist}
							<Badge variant="secondary">{viewTabCount(view, data.worklist.counts)}</Badge>
						{/if}
					</a>
				{/each}
			</Tabs.List>
		</Tabs.Root>

		<form method="GET" action={localizeHref(page.url.pathname)} class="flex items-end gap-2">
			<input type="hidden" name="view" value={data.worklistQuery.view} />
			<Field.Field class="w-full sm:w-64">
				<Field.FieldLabel for="dashboard-search">{m.dashboard_search_label()}</Field.FieldLabel>
				<Input
					id="dashboard-search"
					type="search"
					name="q"
					placeholder={m.dashboard_search_placeholder()}
					value={data.worklistQuery.query}
				/>
			</Field.Field>
			<Button type="submit" variant="outline">{m.dashboard_search_submit()}</Button>
		</form>
	</div>

	{#if data.worklistError}
		<Alert.Root variant="destructive">
			<IconAlertTriangle />
			<Alert.Title>{m.dashboard_error_title()}</Alert.Title>
			<Alert.Description class="flex flex-col gap-3">
				<p>{data.worklistError.message}</p>
				<Button variant="outline" class="w-fit" onclick={() => void invalidateAll()}>
					{m.common_retry()}
				</Button>
			</Alert.Description>
		</Alert.Root>
	{:else if data.worklist === null || data.worklist.items.length === 0}
		<Empty.Root>
			<Empty.Header>
				<Empty.Media variant="icon"><IconFileText /></Empty.Media>
				<Empty.Title>{m.dashboard_empty_title()}</Empty.Title>
				<Empty.Description>{m.dashboard_empty_description()}</Empty.Description>
			</Empty.Header>
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
							<Table.Cell class="max-w-64 font-medium">
								<a
									href={localizeHref(`/envelopes/${item.envelope.id}`)}
									class="truncate hover:underline"
								>
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
									<span class="text-xs text-muted-foreground">{progressLabel(item)}</span>
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

		{#if data.worklist.nextCursor}
			<div class="flex justify-center">
				<Button
					variant="outline"
					href={buildHref({
						view: data.worklistQuery.view,
						q: data.worklistQuery.query,
						cursor: data.worklist.nextCursor
					})}
				>
					{m.dashboard_pagination_next()}
				</Button>
			</div>
		{/if}
	{/if}
</div>
