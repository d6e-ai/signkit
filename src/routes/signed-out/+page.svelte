<script lang="ts">
	import { IconLogout } from '@tabler/icons-svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as m from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
</script>

<svelte:head>
	<title>{m.signed_out_title()} — {m.app_name()}</title>
</svelte:head>

<div class="mx-auto flex min-h-[60vh] max-w-lg items-center">
	<Card.Root class="w-full">
		<Card.Header>
			<div
				class="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"
			>
				<IconLogout class="size-5" />
			</div>
			<Card.Title>{m.signed_out_title()}</Card.Title>
			<Card.Description>{m.signed_out_description()}</Card.Description>
		</Card.Header>
		<Card.Content>
			<Button class="w-full" href={localizeHref('/auth/login')}>{m.sign_in()}</Button>
		</Card.Content>
	</Card.Root>
</div>
