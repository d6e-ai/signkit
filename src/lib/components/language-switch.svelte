<script lang="ts">
	import { IconCheck, IconLanguage } from '@tabler/icons-svelte';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { getLocale, setLocale } from '$lib/paraglide/runtime';
	import * as m from '$lib/paraglide/messages';

	const languages = [
		{ code: 'en', label: 'English' },
		{ code: 'ja', label: '日本語' }
	] as const;
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon" aria-label={m.nav_language()}>
				<IconLanguage />
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="end" class="min-w-36">
		<DropdownMenu.Label>{m.nav_language()}</DropdownMenu.Label>
		<DropdownMenu.Group>
			{#each languages as language (language.code)}
				<DropdownMenu.Item onclick={() => setLocale(language.code)}>
					<span>{language.label}</span>
					<span class="flex-auto"></span>
					{#if getLocale() === language.code}<IconCheck />{/if}
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Group>
	</DropdownMenu.Content>
</DropdownMenu.Root>
