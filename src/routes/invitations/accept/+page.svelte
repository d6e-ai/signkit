<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import * as m from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { Spinner } from '$lib/components/ui/spinner';
	import { clearInvitationLink, readInvitationLink } from '$lib/client/invitation-link';
	import SettingsAcceptInvitationCard from '$lib/components/settings/settings-accept-invitation-card.svelte';
	import SettingsInvitationRequiredCard from '$lib/components/settings/settings-invitation-required-card.svelte';
	import SettingsStatusShell from '$lib/components/settings/settings-status-shell.svelte';
	import { createSettingsCallerContext } from '$lib/components/settings/settings-caller-context.svelte';

	const ctx = createSettingsCallerContext();
	let invitationToken = $state<string | null>(null);
	let initialized = $state(false);
	onMount(() => {
		invitationToken = readInvitationLink(window);
		initialized = true;
		if (invitationToken) void ctx.load();
	});
	async function onAccepted() {
		clearInvitationLink(window);
		await goto(localizeHref('/settings'), { invalidateAll: true, replaceState: true });
	}
</script>

<svelte:head>
	<title>{m.settings_invitation_accept_title()} — {m.app_name()}</title>
	<meta name="referrer" content="no-referrer" />
	<meta name="robots" content="noindex,nofollow,noarchive" />
</svelte:head>

<div class="flex min-h-[70svh] items-center justify-center p-4">
	{#if !initialized}
		<p class="flex items-center gap-2" role="status">
			<Spinner aria-hidden="true" />{m.nav_loading()}
		</p>
	{:else if invitationToken}
		{@const token = invitationToken}
		<SettingsStatusShell {ctx}>
			{#snippet ready()}
				<SettingsAcceptInvitationCard
					invitationToken={token}
					{onAccepted}
					onAuthenticationRequired={() => ctx.load()}
				/>
			{/snippet}
		</SettingsStatusShell>
	{:else}
		<SettingsInvitationRequiredCard />
	{/if}
</div>
