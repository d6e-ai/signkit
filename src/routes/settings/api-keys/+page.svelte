<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import SettingsAccessGate from '$lib/components/settings/settings-access-gate.svelte';
	import SettingsApiKeysPanel from '$lib/components/settings/settings-api-keys-panel.svelte';
</script>

<svelte:head>
	<title>{m.settings_tab_api_keys()} — {m.settings_title()} — {m.app_name()}</title>
</svelte:head>

<div class="mx-auto flex max-w-6xl flex-col gap-6">
	<div class="flex flex-col gap-1">
		<h1 class="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
			{m.settings_tab_api_keys()}
		</h1>
	</div>

	<SettingsAccessGate require="any">
		<SettingsApiKeysPanel />
	</SettingsAccessGate>
</div>
