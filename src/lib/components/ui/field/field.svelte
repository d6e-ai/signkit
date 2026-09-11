<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	type FieldOrientation = 'vertical' | 'horizontal' | 'responsive';

	let {
		ref = $bindable(null),
		class: className,
		orientation = 'vertical',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & { orientation?: FieldOrientation } = $props();
</script>

<div
	bind:this={ref}
	data-slot="field"
	data-orientation={orientation}
	role="group"
	class={cn(
		'group/field flex w-full gap-3',
		orientation === 'vertical' && 'flex-col [&>*]:w-full',
		orientation === 'horizontal' && 'flex-row items-center',
		orientation === 'responsive' && 'flex-col sm:flex-row sm:items-center',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
