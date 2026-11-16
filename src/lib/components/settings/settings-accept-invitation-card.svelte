<script lang="ts">
	import {
		createInstanceManagementClient,
		defaultNewIdempotencyKey,
		InstanceManagementApiError
	} from '$lib/client/instance-management';
	import * as m from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import { Spinner } from '$lib/components/ui/spinner';

	let {
		invitationToken,
		account,
		onAccepted,
		onAuthenticationRequired,
		onAccountChanged
	}: {
		invitationToken: string;
		account: { subject: string; email: string } | null;
		onAccepted: () => void | Promise<void>;
		onAuthenticationRequired: () => void | Promise<void>;
		onAccountChanged: () => void | Promise<void>;
	} = $props();
	const client = createInstanceManagementClient();
	// Preserve the command identity when retrying an ambiguous response.
	let idempotencyKey = defaultNewIdempotencyKey();
	let commandSubject: string | null = null;
	let acceptPending = $state(false);
	let acceptError = $state<string | null>(null);

	async function handleAcceptInvitation() {
		if (acceptPending || !account) return;
		if (commandSubject !== account.subject) {
			commandSubject = account.subject;
			idempotencyKey = defaultNewIdempotencyKey();
		}
		acceptPending = true;
		acceptError = null;
		try {
			await client.acceptInvitation(
				{ token: invitationToken, expectedSubject: account.subject },
				{ idempotencyKey }
			);
			await onAccepted();
		} catch (err: unknown) {
			if (err instanceof InstanceManagementApiError && err.status === 401) {
				await onAuthenticationRequired();
			} else if (
				err instanceof InstanceManagementApiError &&
				err.type === 'urn:signkit:problem:account-changed'
			) {
				await onAccountChanged();
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
	<Card.Content>
		<p class="text-xs text-muted-foreground">{m.settings_invitation_current_account()}</p>
		<p class="mt-1 [overflow-wrap:anywhere]">
			<bdi dir="auto">{account?.email ?? m.settings_invitation_account_unavailable()}</bdi>
		</p>
	</Card.Content>
	{#if acceptError}
		<Card.Content>
			<Alert.Root variant="destructive"><Alert.Title>{acceptError}</Alert.Title></Alert.Root>
		</Card.Content>
	{/if}
	<Card.Footer class="flex-col gap-2">
		<Button
			onclick={handleAcceptInvitation}
			class="w-full"
			disabled={acceptPending || !account}
			aria-busy={acceptPending}
		>
			{#if acceptPending}<Spinner data-icon="inline-start" aria-hidden="true" />{/if}
			{acceptPending
				? m.settings_invitation_accept_pending()
				: m.settings_invitation_accept_action()}
		</Button>
		<form
			method="POST"
			action={localizeHref('/auth/switch-account')}
			class="w-full"
			data-sveltekit-reload
		>
			<Button type="submit" variant="outline" class="w-full" disabled={acceptPending}>
				{m.settings_invitation_switch_account()}
			</Button>
		</form>
	</Card.Footer>
</Card.Root>
