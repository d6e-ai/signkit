<script lang="ts">
	import type { MemberDisplay } from '$lib/ports/instance-display-store';
	import * as Avatar from '$lib/components/ui/avatar';
	import { Button } from '$lib/components/ui/button';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';

	let {
		userId,
		display,
		onselect,
		detailed = false
	}: {
		userId: string;
		display: MemberDisplay | undefined;
		onselect?: () => void;
		detailed?: boolean;
	} = $props();
	const available = $derived(display?.state === 'available' ? display : null);
	const label = $derived(available?.name ?? userId);
	const initials = $derived(Array.from(label.trim()).slice(0, 2).join('').toUpperCase());
</script>

<div class="flex min-w-0 items-start gap-3">
	{#if available}
		<Avatar.Root aria-hidden="true"><Avatar.Fallback>{initials}</Avatar.Fallback></Avatar.Root>
	{/if}
	<div class="flex min-w-0 flex-1 flex-col items-start gap-1">
		{#if onselect}
			<Button
				variant="link"
				class="h-auto min-w-0 justify-start p-0 whitespace-normal"
				onclick={onselect}
				aria-label={m.settings_display_details_for({ name: label })}
				><bdi dir="auto" class="[overflow-wrap:anywhere]">{label}</bdi></Button
			>
		{:else}<p class="[overflow-wrap:anywhere]"><bdi dir="auto">{label}</bdi></p>{/if}
		{#if available}
			<p class="text-xs [overflow-wrap:anywhere] text-muted-foreground">
				<bdi dir="auto">{available.email}</bdi>
			</p>
			<p class="text-xs text-muted-foreground">
				{m.settings_display_observed({
					timestamp: new Intl.DateTimeFormat(getLocale(), {
						dateStyle: 'medium',
						...(detailed ? { timeStyle: 'short' as const } : {})
					}).format(new Date(available.observedAt))
				})}
			</p>
		{:else}
			<p class="text-xs text-muted-foreground">{m.settings_display_unavailable()}</p>
		{/if}
	</div>
</div>
