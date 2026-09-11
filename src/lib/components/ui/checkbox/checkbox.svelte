<script lang="ts">
	import { Checkbox as CheckboxPrimitive } from 'bits-ui';
	import { IconCheck, IconMinus } from '@tabler/icons-svelte';
	import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		checked = $bindable(false),
		indeterminate = $bindable(false),
		class: className,
		...restProps
	}: WithoutChildrenOrChild<CheckboxPrimitive.RootProps> = $props();
</script>

<CheckboxPrimitive.Root
	bind:ref
	bind:checked
	bind:indeterminate
	data-slot="checkbox"
	class={cn(
		'peer size-5 shrink-0 rounded-lg border border-input bg-input/50 shadow-xs transition-[color,box-shadow,background-color] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
		className
	)}
	{...restProps}
>
	{#snippet children({ checked: isChecked, indeterminate: isIndeterminate })}
		<div class="flex items-center justify-center text-current transition-none">
			{#if isIndeterminate}
				<IconMinus class="size-3.5" />
			{:else if isChecked}
				<IconCheck class="size-3.5" />
			{/if}
		</div>
	{/snippet}
</CheckboxPrimitive.Root>
