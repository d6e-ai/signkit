<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import * as m from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { Spinner } from '$lib/components/ui/spinner';
	import SettingsStatusShell from '$lib/components/settings/settings-status-shell.svelte';
	import SettingsAcceptInvitationCard from '$lib/components/settings/settings-accept-invitation-card.svelte';
	import SettingsAccessRestrictedCard from '$lib/components/settings/settings-access-restricted-card.svelte';
	import { createSettingsCallerContext } from '$lib/components/settings/settings-caller-context.svelte';

	const ctx = createSettingsCallerContext();
	onMount(() => {
		void ctx.load();
	});

	const currentMember = $derived(ctx.callerContext?.member ?? null);
	const isActiveMember = $derived(currentMember?.status === 'active');
	const isOwnerOrAdmin = $derived(
		isActiveMember && (currentMember?.role === 'owner' || currentMember?.role === 'admin')
	);

	// This page is the only home for a non-member accepting an invitation. Once
	// the caller turns out to be an active member, it hands off to the one
	// child route their role can actually use -- there is no tabs UI here
	// anymore to fall back to.
	$effect(() => {
		if (!isActiveMember) return;
		void goto(localizeHref(isOwnerOrAdmin ? '/settings/members' : '/settings/api-keys'));
	});
</script>

<svelte:head>
	<title>{m.settings_title()} — {m.app_name()}</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<div class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
			{m.settings_title()}
		</h1>
		<p class="text-sm text-muted-foreground">
			{m.settings_description()}
		</p>
	</div>

	<SettingsStatusShell {ctx}>
		{#snippet ready()}
			{#if !currentMember}
				<SettingsAcceptInvitationCard onAccepted={() => ctx.load()} />
			{:else if !isActiveMember}
				<SettingsAccessRestrictedCard member={currentMember} />
			{:else}
				<div
					class="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground"
					aria-live="polite"
				>
					<Spinner class="size-8" />
					<p class="text-sm font-medium">{m.nav_loading()}</p>
				</div>
			{/if}
		{/snippet}
	</SettingsStatusShell>
</div>
