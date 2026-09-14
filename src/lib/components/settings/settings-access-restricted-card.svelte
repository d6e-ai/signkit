<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import { IconLock } from '@tabler/icons-svelte';
	import type { InstanceMemberMetadata } from '$lib/client/instance-management';

	let { member }: { member: InstanceMemberMetadata } = $props();
</script>

<Card.Root class="mx-auto max-w-md text-center">
	<Card.Header>
		<div
			class="mx-auto mb-2 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground"
		>
			<IconLock class="size-6" />
		</div>
		<Card.Title>{m.settings_access_restricted_title()}</Card.Title>
		<Card.Description>{m.settings_access_restricted_description()}</Card.Description>
	</Card.Header>
	<Card.Content>
		<div class="flex items-center justify-center gap-2 text-sm">
			<span class="text-muted-foreground">{m.settings_members_col_role()}:</span>
			<Badge variant="outline">{member.role}</Badge>
			<span class="text-muted-foreground">{m.settings_members_col_status()}:</span>
			<Badge variant={member.status === 'active' ? 'secondary' : 'destructive'}>
				{member.status}
			</Badge>
		</div>
	</Card.Content>
</Card.Root>
