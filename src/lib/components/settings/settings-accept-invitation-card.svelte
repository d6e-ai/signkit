<script lang="ts">
	import {
		createInstanceManagementClient,
		defaultNewIdempotencyKey,
		InstanceManagementApiError
	} from '$lib/client/instance-management';
	import * as m from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import { Spinner } from '$lib/components/ui/spinner';

	let {
		invitationToken,
		onAccepted,
		onAuthenticationRequired
	}: {
		invitationToken: string;
		onAccepted: () => void | Promise<void>;
		onAuthenticationRequired: () => void | Promise<void>;
	} = $props();
	const client = createInstanceManagementClient();
	// Preserve the command identity when retrying an ambiguous response.
	const idempotencyKey = defaultNewIdempotencyKey();
	let acceptPending = $state(false);
	let acceptError = $state<string | null>(null);

	async function handleAcceptInvitation() {
		if (acceptPending) return;
		acceptPending = true;
		acceptError = null;
		try {
			await client.acceptInvitation({ token: invitationToken }, { idempotencyKey });
			await onAccepted();
		} catch (err: unknown) {
			if (err instanceof InstanceManagementApiError && err.status === 401) {
				await onAuthenticationRequired();
			} else {
				acceptError =
					err instanceof InstanceManagementApiError && err.status === 404
						? m.settings_invitation_accept_error()
						: err instanceof Error
							? err.message
							: String(err);
			}
		} finally {
			acceptPending = false;
		}
	}
</script>

<Card.Root class="mx-auto w-full max-w-lg">
	<Card.Header>
		<Card.Title>{m.settings_invitation_accept_title()}</Card.Title>
		<Card.Description>{m.settings_invitation_accept_description()}</Card.Description>
	</Card.Header>
	{#if acceptError}
		<Card.Content>
			<Alert.Root variant="destructive"><Alert.Title>{acceptError}</Alert.Title></Alert.Root>
		</Card.Content>
	{/if}
	<Card.Footer>
		<Button
			onclick={handleAcceptInvitation}
			class="w-full"
			disabled={acceptPending}
			aria-busy={acceptPending}
		>
			{#if acceptPending}<Spinner data-icon="inline-start" aria-hidden="true" />{/if}
			{acceptPending
				? m.settings_invitation_accept_pending()
				: m.settings_invitation_accept_action()}
		</Button>
	</Card.Footer>
</Card.Root>
