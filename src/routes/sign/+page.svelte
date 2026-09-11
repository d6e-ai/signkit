<script lang="ts">
	import {
		IconAlertTriangle,
		IconClock,
		IconFileText,
		IconShieldCheck,
		IconUserCheck
	} from '@tabler/icons-svelte';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as m from '$lib/paraglide/messages';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function roleLabel(role: string): string {
		if (role === 'signer') return m.signing_role_signer();
		if (role === 'approver') return m.signing_role_approver();
		if (role === 'viewer') return m.signing_role_viewer();
		return m.signing_role_prefill();
	}

	function statusLabel(status: string): string {
		return status === 'viewed' ? m.signing_status_viewed() : m.signing_status_pending();
	}

	function formatExpiry(expiresAt: string, locale: string): string {
		return new Intl.DateTimeFormat(locale, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(new Date(expiresAt));
	}
</script>

<svelte:head>
	<title>{m.signing_page_title()} — {m.app_name()}</title>
	<meta name="robots" content="noindex,nofollow,noarchive" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="mx-auto flex min-h-[calc(100svh-7.5rem)] w-full max-w-2xl items-center justify-center">
	{#if data.state === 'active'}
		<Card.Root class="w-full overflow-hidden shadow-sm">
			<div class="h-1 bg-primary"></div>
			<Card.Header class="gap-4 pb-4">
				<div class="flex items-start justify-between gap-4">
					<div
						class="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary"
					>
						<IconShieldCheck class="size-6" />
					</div>
					<Badge variant="outline" class="border-emerald-200 bg-emerald-50 text-emerald-700">
						{m.signing_secure_access()}
					</Badge>
				</div>
				<div>
					<Card.Title class="text-2xl">{data.access.envelopeTitle}</Card.Title>
					<Card.Description class="mt-2 leading-6">
						{m.signing_access_description()}
					</Card.Description>
				</div>
			</Card.Header>
			<Card.Content class="space-y-5">
				<div class="grid gap-3 sm:grid-cols-2">
					<div class="rounded-xl border bg-muted/25 p-4">
						<div class="flex items-center gap-2 text-xs text-muted-foreground">
							<IconUserCheck class="size-4" />{m.signing_role()}
						</div>
						<p class="mt-2 font-medium">{roleLabel(data.access.role)}</p>
					</div>
					<div class="rounded-xl border bg-muted/25 p-4">
						<div class="flex items-center gap-2 text-xs text-muted-foreground">
							<IconFileText class="size-4" />{m.signing_status()}
						</div>
						<p class="mt-2 font-medium">{statusLabel(data.access.recipientStatus)}</p>
					</div>
				</div>
				<div
					class="flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/[0.035] p-4"
				>
					<IconClock class="mt-0.5 size-4 shrink-0 text-primary" />
					<div>
						<p class="text-sm font-medium">{m.signing_expires()}</p>
						<p class="mt-1 text-sm text-muted-foreground">
							{formatExpiry(data.access.expiresAt, data.access.locale)}
						</p>
					</div>
				</div>
			</Card.Content>
			<Card.Footer class="border-t bg-muted/20 py-4 text-sm text-muted-foreground">
				{m.signing_controls_next()}
			</Card.Footer>
		</Card.Root>
	{:else}
		<Card.Root class="w-full text-center shadow-sm">
			<Card.Header class="items-center gap-4 py-10">
				<div
					class="flex size-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700"
				>
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
	{/if}
</div>
