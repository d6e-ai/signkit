<script lang="ts">
	import { createInstanceManagementClient } from '$lib/client/instance-management';
	import * as m from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import { Spinner } from '$lib/components/ui/spinner';
	import { IconMail } from '@tabler/icons-svelte';

	let { onAccepted }: { onAccepted: () => void | Promise<void> } = $props();

	const client = createInstanceManagementClient();

	let invitationToken = $state('');
	let acceptPending = $state(false);
	let acceptError = $state<string | null>(null);
	let acceptSuccess = $state<string | null>(null);

	async function handleAcceptInvitation(event: SubmitEvent) {
		event.preventDefault();
		if (!invitationToken.trim()) return;
		acceptPending = true;
		acceptError = null;
		acceptSuccess = null;
		try {
			await client.acceptInvitation({ token: invitationToken.trim() });
			acceptSuccess = m.settings_invitation_accept_success();
			invitationToken = '';
			await onAccepted();
		} catch (err: unknown) {
			acceptError = err instanceof Error ? err.message : String(err);
		} finally {
			acceptPending = false;
		}
	}
</script>

<Card.Root class="mx-auto max-w-lg">
	<Card.Header>
		<div
			class="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"
		>
			<IconMail class="size-5" />
		</div>
		<Card.Title>{m.settings_invitation_accept_title()}</Card.Title>
		<Card.Description>{m.settings_invitation_accept_description()}</Card.Description>
	</Card.Header>
	<Card.Content>
		<form onsubmit={handleAcceptInvitation}>
			<Field.FieldGroup>
				<Field.Field data-invalid={acceptError !== null} data-disabled={acceptPending}>
					<Field.FieldLabel for="invitation-token">
						{m.settings_invitation_token_label()}
					</Field.FieldLabel>
					<Input
						id="invitation-token"
						type="text"
						placeholder={m.settings_invitation_token_placeholder()}
						bind:value={invitationToken}
						disabled={acceptPending}
						aria-invalid={acceptError !== null}
						required
					/>
					{#if acceptError}
						<Field.FieldError>{acceptError}</Field.FieldError>
					{/if}
					{#if acceptSuccess}
						<Field.FieldDescription class="text-primary">{acceptSuccess}</Field.FieldDescription>
					{/if}
				</Field.Field>

				<Button type="submit" class="w-full" disabled={acceptPending || !invitationToken.trim()}>
					{#if acceptPending}
						<Spinner data-icon="inline-start" />
						<span>{m.settings_invitation_accept_pending()}</span>
					{:else}
						<span>{m.settings_invitation_accept_action()}</span>
					{/if}
				</Button>
			</Field.FieldGroup>
		</form>
	</Card.Content>
</Card.Root>
