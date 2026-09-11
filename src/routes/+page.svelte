<script lang="ts">
	import {
		IconArrowRight,
		IconBrandGit,
		IconCheck,
		IconClock,
		IconFileText,
		IconGitCommit,
		IconRobot,
		IconSignature,
		IconUsers
	} from '@tabler/icons-svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Progress } from '$lib/components/ui/progress';
	import * as m from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';

	const agreements = [
		{
			title: '業務委託基本契約',
			counterparty: 'Northstar Studio',
			status: 'review',
			files: 3,
			recipients: 2,
			revisions: 12,
			updated: 'minutes18'
		},
		{
			title: 'Mutual NDA — APAC',
			counterparty: 'Forma Labs',
			status: 'waiting',
			files: 2,
			recipients: 3,
			revisions: 7,
			updated: 'hours2'
		},
		{
			title: 'AI Research Partnership',
			counterparty: 'Harbor Institute',
			status: 'draft',
			files: 4,
			recipients: 4,
			revisions: 18,
			updated: 'yesterday'
		},
		{
			title: 'Master Service Agreement',
			counterparty: 'Aster Systems',
			status: 'completed',
			files: 2,
			recipients: 2,
			revisions: 9,
			updated: 'sep8'
		}
	] as const;

	const activity = [
		{
			icon: IconGitCommit,
			actor: 'agent',
			action: 'edited',
			subject: '業務委託基本契約',
			time: 'minutes18'
		},
		{
			icon: IconSignature,
			actor: 'Yu Kimura',
			action: 'sent',
			subject: 'Mutual NDA — APAC',
			time: 'hours2'
		},
		{
			icon: IconCheck,
			actor: 'Aster Systems',
			action: 'signed',
			subject: 'Master Service Agreement',
			time: 'days3'
		}
	] as const;

	function statusLabel(status: (typeof agreements)[number]['status']): string {
		if (status === 'draft') return m.status_draft();
		if (status === 'waiting') return m.status_waiting();
		if (status === 'completed') return m.status_completed();
		return m.status_review();
	}

	function statusClass(status: (typeof agreements)[number]['status']): string {
		if (status === 'completed')
			return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300';
		if (status === 'waiting')
			return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300';
		if (status === 'review')
			return 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300';
		return '';
	}

	function timeLabel(
		time: (typeof agreements)[number]['updated'] | (typeof activity)[number]['time']
	): string {
		if (time === 'minutes18') return m.time_minutes_18();
		if (time === 'hours2') return m.time_hours_2();
		if (time === 'days3') return m.time_days_3();
		if (time === 'yesterday') return m.time_yesterday();
		return m.time_sep_8();
	}
</script>

<div class="mx-auto flex w-full max-w-7xl flex-col gap-6">
	<section class="flex flex-col justify-between gap-4 md:flex-row md:items-end">
		<div class="max-w-2xl">
			<div
				class="mb-2 flex items-center gap-2 text-xs font-medium tracking-[0.18em] text-muted-foreground uppercase"
			>
				<span class="size-1.5 rounded-full bg-primary"></span>Open core · Agent native
			</div>
			<h1 class="text-3xl font-semibold tracking-tight md:text-4xl">{m.dashboard_title()}</h1>
			<p class="mt-2 text-sm leading-6 text-muted-foreground md:text-base">
				{m.dashboard_description()}
			</p>
		</div>
		<Button size="lg" href={localizeHref('/agreements/new')}
			><IconFileText data-icon="inline-start" />{m.new_agreement()}</Button
		>
	</section>

	<section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
		<Card.Root
			><Card.Header class="pb-2"
				><Card.Description>{m.stat_action_needed()}</Card.Description></Card.Header
			><Card.Content
				><div class="text-3xl font-semibold">3</div>
				<p class="mt-1 text-xs text-muted-foreground">
					{m.stat_action_needed_detail()}
				</p></Card.Content
			></Card.Root
		>
		<Card.Root
			><Card.Header class="pb-2"
				><Card.Description>{m.stat_waiting()}</Card.Description></Card.Header
			><Card.Content
				><div class="text-3xl font-semibold">8</div>
				<p class="mt-1 text-xs text-muted-foreground">{m.stat_waiting_detail()}</p></Card.Content
			></Card.Root
		>
		<Card.Root
			><Card.Header class="pb-2"
				><Card.Description>{m.stat_completed()}</Card.Description></Card.Header
			><Card.Content
				><div class="text-3xl font-semibold">24</div>
				<p class="mt-1 text-xs text-emerald-600">{m.stat_completed_detail()}</p></Card.Content
			></Card.Root
		>
		<Card.Root
			><Card.Header class="pb-2"
				><Card.Description>{m.stat_cycle_time()}</Card.Description></Card.Header
			><Card.Content
				><div class="text-3xl font-semibold">
					2.4 <span class="text-base font-normal text-muted-foreground">{m.days()}</span>
				</div>
				<Progress value={62} class="mt-3" /></Card.Content
			></Card.Root
		>
	</section>

	<section class="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(19rem,0.7fr)]">
		<Card.Root class="overflow-hidden">
			<Card.Header class="flex-row items-start justify-between gap-4"
				><div>
					<Card.Title>{m.recent_title()}</Card.Title><Card.Description
						>{m.recent_description()}</Card.Description
					>
				</div>
				<Button variant="ghost" size="sm" href={localizeHref('/agreements')}
					>{m.view_all()}<IconArrowRight data-icon="inline-end" /></Button
				></Card.Header
			>
			<Card.Content class="px-0"
				><div class="divide-y border-t">
					{#each agreements as agreement (agreement.title)}
						<a
							href={localizeHref('/agreements')}
							class="group grid gap-3 px-6 py-4 transition-colors hover:bg-muted/45 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
						>
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<p class="truncate text-sm font-medium">{agreement.title}</p>
									<Badge variant="outline" class={statusClass(agreement.status)}
										>{statusLabel(agreement.status)}</Badge
									>
								</div>
								<p class="mt-1 truncate text-xs text-muted-foreground">{agreement.counterparty}</p>
							</div>
							<div
								class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground sm:justify-end"
							>
								<span class="inline-flex items-center gap-1"
									><IconFileText class="size-3.5" />{agreement.files} {m.files()}</span
								><span class="inline-flex items-center gap-1"
									><IconUsers class="size-3.5" />{agreement.recipients}</span
								><span class="inline-flex items-center gap-1"
									><IconBrandGit class="size-3.5" />{agreement.revisions}</span
								><span>{timeLabel(agreement.updated)}</span>
							</div>
						</a>
					{/each}
				</div></Card.Content
			>
		</Card.Root>

		<div class="flex flex-col gap-6">
			<Card.Root
				><Card.Header
					><Card.Title>{m.activity_title()}</Card.Title><Card.Description
						>{m.activity_description()}</Card.Description
					></Card.Header
				><Card.Content class="space-y-5">
					{#each activity as event (event.time)}
						<div class="flex gap-3">
							<div
								class="flex size-8 shrink-0 items-center justify-center rounded-full border bg-background"
							>
								<event.icon class="size-4" />
							</div>
							<div class="min-w-0 text-sm">
								<p>
									<span class="font-medium"
										>{event.actor === 'agent' ? m.actor_ai_reviewer() : event.actor}</span
									>
									{event.action === 'edited'
										? m.edited()
										: event.action === 'sent'
											? m.sent()
											: m.signed()}
								</p>
								<p class="truncate text-muted-foreground">{event.subject}</p>
							</div>
							<span class="ml-auto shrink-0 text-xs text-muted-foreground"
								>{timeLabel(event.time)}</span
							>
						</div>
					{/each}
				</Card.Content></Card.Root
			>
			<Card.Root class="border-primary/20 bg-primary/[0.035]"
				><Card.Header class="pb-3"
					><div
						class="mb-2 flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground"
					>
						<IconRobot class="size-5" />
					</div>
					<Card.Title>{m.agent_ready()}</Card.Title><Card.Description
						>{m.agent_ready_description()}</Card.Description
					></Card.Header
				><Card.Footer
					><Button variant="outline" class="w-full" href={localizeHref('/automation')}
						>{m.open_automation()}<IconArrowRight data-icon="inline-end" /></Button
					></Card.Footer
				></Card.Root
			>
		</div>
	</section>

	<section
		class="grid gap-3 rounded-2xl border bg-card p-5 md:grid-cols-[auto_1fr_auto] md:items-center"
	>
		<div class="flex size-10 items-center justify-center rounded-xl bg-muted"><IconBrandGit /></div>
		<div>
			<h2 class="font-medium">{m.source_history()}</h2>
			<p class="mt-1 text-sm text-muted-foreground">{m.source_history_description()}</p>
		</div>
		<div class="flex items-center gap-2 text-xs text-muted-foreground">
			<IconClock class="size-4" />SHA-256 · CAS
		</div>
	</section>
</div>
