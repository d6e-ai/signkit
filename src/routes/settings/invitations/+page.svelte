<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import SettingsAccessGate from '$lib/components/settings/settings-access-gate.svelte';
	import SettingsInvitationsPanel from '$lib/components/settings/settings-invitations-panel.svelte';
</script>

<svelte:head>
	<title>{m.settings_tab_invitations()} — {m.settings_title()} — {m.app_name()}</title>
</svelte:head>

<div class="mx-auto flex max-w-6xl flex-col gap-6">
	<div class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
			{m.settings_tab_invitations()}
		</h1>
	</div>

	<SettingsAccessGate require="owner-or-admin">
		{#snippet children({ isCallerOwner, isCallerAdmin })}
			<SettingsInvitationsPanel {isCallerOwner} {isCallerAdmin} />
		{/snippet}
	</SettingsAccessGate>
</div>
