<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLParagraphElement>> = $props();
</script>

<p
	bind:this={ref}
	data-slot="field-description"
	class={cn(
		'text-sm leading-normal font-normal text-muted-foreground group-data-[invalid=true]/field:text-destructive',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</p>
