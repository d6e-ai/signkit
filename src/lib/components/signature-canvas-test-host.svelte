<script lang="ts">
	import { untrack } from 'svelte';
	import SignatureCanvas from './signature-canvas.svelte';

	let {
		recipientName = 'Alex Rivera',
		initialValue = '',
		disabled = false,
		invalid = false
	}: {
		recipientName?: string;
		initialValue?: string;
		disabled?: boolean;
		invalid?: boolean;
	} = $props();

	let value = $state(untrack(() => initialValue));
</script>

<p data-testid="committed-signature">{value.length === 0 ? '(empty)' : value}</p>
<SignatureCanvas
	id="signature-field"
	envelopeId="01910000-0000-7000-8000-000000000001"
	recipientId="01910000-0000-7000-8000-000000000002"
	{recipientName}
	{disabled}
	{invalid}
	bind:value
/>
