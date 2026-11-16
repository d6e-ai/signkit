<script lang="ts">
	import * as Alert from '$lib/components/ui/alert';
	let { message }: { message: string } = $props();
</script>

<Alert.Root class="mx-auto w-full max-w-lg"><Alert.Title>{message}</Alert.Title></Alert.Root>
