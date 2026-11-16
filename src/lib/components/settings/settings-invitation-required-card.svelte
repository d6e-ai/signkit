<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import * as Card from '$lib/components/ui/card';
</script>

<Card.Root class="mx-auto max-w-lg">
	<Card.Header>
		<Card.Title>{m.settings_invitation_required_title()}</Card.Title>
		<Card.Description>{m.settings_invitation_required_description()}</Card.Description>
	</Card.Header>
</Card.Root>
