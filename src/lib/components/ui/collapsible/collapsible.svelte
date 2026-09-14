<script lang="ts">
	import { Collapsible as CollapsiblePrimitive } from 'bits-ui';

	// `child` is forwarded through `restProps` untouched so
	// `<Collapsible.Root>{#snippet child(...)}<Sidebar.MenuItem ...>` renders
	// as-child: the primitive merges onto `Sidebar.MenuItem` (an `li`) instead
	// of wrapping it in a `div`, keeping `ul > li` valid.
	let {
		ref = $bindable(null),
		open = $bindable(false),
		...restProps
	}: CollapsiblePrimitive.RootProps = $props();
</script>

<CollapsiblePrimitive.Root bind:ref bind:open data-slot="collapsible" {...restProps} />
