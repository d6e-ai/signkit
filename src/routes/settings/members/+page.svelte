<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import SettingsAccessGate from '$lib/components/settings/settings-access-gate.svelte';
	import SettingsMembersPanel from '$lib/components/settings/settings-members-panel.svelte';
</script>

<svelte:head>
	<title>{m.settings_tab_members()} — {m.settings_title()} — {m.app_name()}</title>
</svelte:head>

<div class="mx-auto flex max-w-6xl flex-col gap-6">
	<div class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
			{m.settings_tab_members()}
		</h1>
		<p class="text-sm text-muted-foreground">
			{m.settings_members_description()}
		</p>
	</div>

	<SettingsAccessGate require="owner-or-admin">
		{#snippet children({ member, isCallerOwner, isCallerAdmin })}
			<SettingsMembersPanel currentUserId={member.userId} {isCallerOwner} {isCallerAdmin} />
		{/snippet}
	</SettingsAccessGate>
</div>
