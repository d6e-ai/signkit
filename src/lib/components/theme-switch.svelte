<script lang="ts">
	// Light, dark, or follow the system.
	//
	// The trigger shows the appearance in force, not the stored preference: on
	// "system" at night, a sun icon would be telling the reader something the
	// page is visibly not doing.
	import { IconCheck, IconDeviceDesktop, IconMoon, IconSun } from '@tabler/icons-svelte';
	import { mode, setMode, userPrefersMode } from 'mode-watcher';

	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as m from '$lib/paraglide/messages';

	const options = [
		{ value: 'light' as const, label: () => m.nav_theme_light(), icon: IconSun },
		{ value: 'dark' as const, label: () => m.nav_theme_dark(), icon: IconMoon },
		{ value: 'system' as const, label: () => m.nav_theme_system(), icon: IconDeviceDesktop }
	];
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon"
				class="rounded-full"
				aria-label={m.nav_theme()}
			>
				{#if mode.current === 'dark'}
					<IconMoon />
				{:else}
					<IconSun />
				{/if}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="min-w-36">
		<DropdownMenu.Label>{m.nav_theme()}</DropdownMenu.Label>
		<DropdownMenu.Group>
			{#each options as option (option.value)}
				<DropdownMenu.Item onclick={() => setMode(option.value)}>
					<option.icon />
					<span>{option.label()}</span>
					<span class="flex-auto"></span>
					{#if userPrefersMode.current === option.value}
						<IconCheck />
					{/if}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Group>
	</DropdownMenu.Content>
</DropdownMenu.Root>
