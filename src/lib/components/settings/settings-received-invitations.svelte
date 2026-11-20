<script lang="ts">
	import { onMount } from 'svelte';
	import {
		createInstanceManagementClient,
		defaultNewIdempotencyKey,
		InstanceManagementApiError,
		type ListReceivedInstanceInvitationsResponse,
		type ReceivedInstanceInvitation
	} from '$lib/client/instance-management';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { InstanceMemberRole } from '$lib/ports/instance-store';
	import { Button } from '$lib/components/ui/button';
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import { Spinner } from '$lib/components/ui/spinner';
	import SettingsInvitationNotice from './settings-invitation-notice.svelte';
	import SettingsInvitationRequiredCard from './settings-invitation-required-card.svelte';

	let {
		onAccepted,
		onAuthenticationRequired
	}: {
		onAccepted: () => void | Promise<void>;
		onAuthenticationRequired: () => void | Promise<void>;
	} = $props();

	const client = createInstanceManagementClient();
	let loading = $state(true);
	let unverified = $state(false);
	let received = $state<ListReceivedInstanceInvitationsResponse | null>(null);
	let acceptingId = $state<string | null>(null);
	let acceptError = $state<string | null>(null);
	let accountChanged = $state(false);
	// Preserve the command identity when retrying an ambiguous response for the
	// same invitation and account.
	let idempotencyKey = defaultNewIdempotencyKey();
	let commandTarget: string | null = null;

	function roleLabel(role: InstanceMemberRole): string {
		if (role === 'owner') return m.settings_members_role_owner();
		if (role === 'admin') return m.settings_members_role_admin();
		return m.settings_members_role_member();
	}

	function formatDate(value: string): string {
		return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
			new Date(value)
		);
	}

	async function load(): Promise<void> {
		loading = true;
		unverified = false;
		try {
			received = await client.listReceivedInvitations();
		} catch (err: unknown) {
			received = null;
			if (err instanceof InstanceManagementApiError && err.status === 401) {
				await onAuthenticationRequired();
			} else if (
				err instanceof InstanceManagementApiError &&
				err.type === 'urn:signkit:problem:email-verification-required'
			) {
				unverified = true;
			}
			// Any other failure falls back to the ordinary invitation-required card.
		} finally {
			loading = false;
		}
	}

	async function accept(invitation: ReceivedInstanceInvitation): Promise<void> {
		if (acceptingId !== null || received === null) return;
		const target: string = `${received.account.subject}\u0000${invitation.id}`;
		if (commandTarget !== target) {
			commandTarget = target;
			idempotencyKey = defaultNewIdempotencyKey();
		}
		acceptingId = invitation.id;
		acceptError = null;
		accountChanged = false;
		try {
			await client.acceptReceivedInvitation(
				{ invitationId: invitation.id, expectedSubject: received.account.subject },
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
				accountChanged = true;
				await load();
			} else if (
				err instanceof InstanceManagementApiError &&
				err.type === 'urn:signkit:problem:instance-member-already-exists'
			) {
				await onAccepted();
			} else {
				acceptError =
					err instanceof InstanceManagementApiError && err.status === 404
						? m.settings_invitation_accept_error()
						: err instanceof Error
							? err.message
							: String(err);
				if (err instanceof InstanceManagementApiError && err.status === 404) await load();
			}
		} finally {
			acceptingId = null;
		}
	}

	onMount(() => {
		void load();
	});
</script>

{#if loading}
	<p class="flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
		<Spinner aria-hidden="true" />{m.nav_loading()}
	</p>
{:else if received !== null && received.invitations.length > 0}
	<div class="mx-auto flex w-full max-w-lg flex-col gap-4">
		{#if accountChanged}
			<SettingsInvitationNotice message={m.settings_invitation_account_changed()} />
		{/if}
		<Card.Root>
			<Card.Header>
				<Card.Title>{m.settings_received_invitations_title()}</Card.Title>
				<Card.Description>{m.settings_received_invitations_description()}</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col gap-4">
				<div>
					<p class="text-xs text-muted-foreground">{m.settings_invitation_current_account()}</p>
					<p class="mt-1 [overflow-wrap:anywhere]">
						<bdi dir="auto">{received.account.email}</bdi>
					</p>
				</div>
				{#if acceptError}
					<Alert.Root variant="destructive"><Alert.Title>{acceptError}</Alert.Title></Alert.Root>
				{/if}
				<ul class="flex flex-col gap-3">
					{#each received.invitations as invitation (invitation.id)}
						<li
							class="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
							data-invitation-id={invitation.id}
						>
							<div class="flex flex-col gap-1 text-sm">
								<span class="font-medium">
									{m.settings_received_invitation_role({ role: roleLabel(invitation.role) })}
								</span>
								<span class="text-xs text-muted-foreground">
									{m.settings_received_invitation_expires({
										date: formatDate(invitation.expiresAt)
									})}
								</span>
							</div>
							<Button
								onclick={() => accept(invitation)}
								disabled={acceptingId !== null}
								aria-busy={acceptingId === invitation.id}
							>
								{#if acceptingId === invitation.id}
									<Spinner data-icon="inline-start" aria-hidden="true" />
									{m.settings_received_invitation_accept_pending()}
								{:else}
									{m.settings_received_invitation_accept_action()}
								{/if}
							</Button>
						</li>
					{/each}
				</ul>
			</Card.Content>
		</Card.Root>
	</div>
{:else}
	<div class="mx-auto flex w-full max-w-lg flex-col gap-4">
		{#if unverified}
			<SettingsInvitationNotice message={m.settings_received_invitation_unverified()} />
		{/if}
		<SettingsInvitationRequiredCard />
	</div>
{/if}
