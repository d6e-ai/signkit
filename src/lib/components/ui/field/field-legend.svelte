<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		variant = 'legend',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> & { variant?: 'legend' | 'label' } = $props();
</script>

<legend
	bind:this={ref}
	data-slot="field-legend"
	data-variant={variant}
	class={cn(variant === 'legend' ? 'text-base font-medium' : 'text-sm font-medium', className)}
	{...restProps}
>
	{@render children?.()}
</legend>
