<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import * as Card from '$lib/components/ui/card';
	let { reopenEmail = false }: { reopenEmail?: boolean } = $props();
</script>

<Card.Root class="mx-auto w-full max-w-lg">
	<Card.Header>
		<Card.Title
			>{reopenEmail
				? m.settings_invitation_reopen_title()
				: m.settings_invitation_required_title()}</Card.Title
		>
		<Card.Description
			>{reopenEmail
				? m.settings_invitation_reopen_description()
				: m.settings_invitation_required_description()}</Card.Description
		>
	</Card.Header>
</Card.Root>
