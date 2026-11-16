<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import * as m from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { Spinner } from '$lib/components/ui/spinner';
	import SettingsStatusShell from '$lib/components/settings/settings-status-shell.svelte';
	import SettingsInvitationRequiredCard from '$lib/components/settings/settings-invitation-required-card.svelte';
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

	// Active members go directly to the settings their role can use.
	$effect(() => {
		if (!isActiveMember) return;
		void goto(localizeHref(isOwnerOrAdmin ? '/settings/members' : '/settings/api-keys'));
	});
</script>

<svelte:head>
	<title>{m.settings_title()} — {m.app_name()}</title>
</svelte:head>

<div class="flex flex-col gap-6">
	<SettingsStatusShell {ctx}>
		{#snippet ready()}
			{#if !currentMember}
				<SettingsInvitationRequiredCard />
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
