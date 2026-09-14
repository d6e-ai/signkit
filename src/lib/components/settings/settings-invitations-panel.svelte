<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		createInstanceManagementClient,
		type InstanceInvitationMetadata,
		type InstanceMemberRole
	} from '$lib/client/instance-management';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import * as Select from '$lib/components/ui/select';
	import * as Table from '$lib/components/ui/table';
	import { Spinner } from '$lib/components/ui/spinner';
	import { settingsRevealState } from './settings-reveal-state.svelte';
	import {
		IconCheck,
		IconCopy,
		IconPlus,
		IconRefresh,
		IconShield,
		IconX
	} from '@tabler/icons-svelte';

	let { isCallerOwner, isCallerAdmin }: { isCallerOwner: boolean; isCallerAdmin: boolean } =
		$props();

	function roleLabel(role: InstanceMemberRole): string {
		switch (role) {
			case 'owner':
				return m.settings_members_role_owner();
			case 'admin':
				return m.settings_members_role_admin();
			case 'member':
				return m.settings_members_role_member();
		}
	}

	const client = createInstanceManagementClient();

	let invitations = $state<InstanceInvitationMetadata[]>([]);
	let invitationsLoading = $state(false);
	let invitationsError = $state<string | null>(null);
	let invitationsNextCursor = $state<string | null>(null);
	let inviteEmail = $state('');
	let inviteRole = $state<InstanceMemberRole>('member');
	let invitePending = $state(false);
	let inviteCreateError = $state<string | null>(null);
	let revokeInvitePending = $state<Record<string, boolean>>({});

	function isInvitationExpired(invitation: InstanceInvitationMetadata): boolean {
		return invitation.status === 'pending' && Date.parse(invitation.expiresAt) <= Date.now();
	}

	async function loadInvitations(cursor?: string | null) {
		invitationsLoading = true;
		invitationsError = null;
		try {
			const res = await client.listInvitations(cursor ? { cursor } : undefined);
			if (cursor) {
				invitations = [...invitations, ...res.invitations];
			} else {
				invitations = [...res.invitations];
			}
			invitationsNextCursor = res.nextCursor;
		} catch (err: unknown) {
			invitationsError = err instanceof Error ? err.message : String(err);
		} finally {
			invitationsLoading = false;
		}
	}

	async function handleCreateInvitation(event: SubmitEvent) {
		event.preventDefault();
		const email = inviteEmail.trim();
		if (!email) return;
		invitePending = true;
		inviteCreateError = null;
		try {
			const res = await client.createInvitation({ email, role: inviteRole });
			if (res.token) {
				settingsRevealState.setRevealedInvitation({
					token: res.token,
					invitationId: res.invitation.id,
					email
				});
			}
			inviteEmail = '';
			inviteRole = 'member';
			await loadInvitations();
		} catch (err: unknown) {
			inviteCreateError = err instanceof Error ? err.message : String(err);
		} finally {
			invitePending = false;
		}
	}

	async function handleRevokeInvitation(id: string) {
		revokeInvitePending[id] = true;
		invitationsError = null;
		try {
			await client.revokeInvitation(id);
			await loadInvitations();
		} catch (err: unknown) {
			invitationsError = err instanceof Error ? err.message : String(err);
		} finally {
			revokeInvitePending[id] = false;
		}
	}

	onMount(() => {
		void loadInvitations();
	});

	onDestroy(() => {
		settingsRevealState.teardownInvitationPanel();
	});
</script>

<div class="flex flex-col gap-6">
	<!-- Create Form -->
	<Card.Root>
		<Card.Header>
			<Card.Title>{m.settings_invitations_create_title()}</Card.Title>
		</Card.Header>
		<Card.Content>
			<form onsubmit={handleCreateInvitation}>
				<Field.FieldGroup>
					<div class="grid gap-4 sm:grid-cols-2">
						<Field.Field data-invalid={inviteCreateError !== null} data-disabled={invitePending}>
							<Field.FieldLabel for="invite-email">
								{m.settings_invitations_email_label()}
							</Field.FieldLabel>
							<Input
								id="invite-email"
								type="email"
								placeholder={m.settings_invitations_email_placeholder()}
								bind:value={inviteEmail}
								disabled={invitePending}
								aria-invalid={inviteCreateError !== null}
								required
							/>
							<!-- The create failure isn't provably scoped to one input (it could
							     be the email, the role, or a server-side rejection), but the
							     email field is the one most often at fault and the one with a
							     visible invalid state, so the message is associated here rather
							     than floating unassociated at the form level. -->
							{#if inviteCreateError}
								<Field.FieldError>{inviteCreateError}</Field.FieldError>
							{/if}
						</Field.Field>
						<Field.Field data-disabled={invitePending}>
							<Field.FieldLabel for="invite-role">
								{m.settings_invitations_role_label()}
							</Field.FieldLabel>
							<Select.Root type="single" bind:value={inviteRole} disabled={invitePending}>
								<Select.Trigger id="invite-role" class="w-full">
									{roleLabel(inviteRole)}
								</Select.Trigger>
								<Select.Content>
									<Select.Group>
										<Select.Item value="member" label={m.settings_members_role_member()} />
										{#if isCallerOwner}
											<Select.Item value="admin" label={m.settings_members_role_admin()} />
											<Select.Item value="owner" label={m.settings_members_role_owner()} />
										{/if}
									</Select.Group>
								</Select.Content>
							</Select.Root>
						</Field.Field>
					</div>

					<Button type="submit" disabled={invitePending || !inviteEmail.trim()}>
						{#if invitePending}
							<Spinner data-icon="inline-start" />
							<span>{m.settings_invitations_create_pending()}</span>
						{:else}
							<IconPlus data-icon="inline-start" />
							<span>{m.settings_invitations_create_action()}</span>
						{/if}
					</Button>
				</Field.FieldGroup>
			</form>
		</Card.Content>
	</Card.Root>

	<!-- One-Time Token Reveal Warning Banner -->
	{#if settingsRevealState.revealedInvitation}
		<div class="rounded-2xl border-2 border-primary bg-primary/5 p-4 shadow-xs sm:p-5" role="alert">
			<div class="flex items-start justify-between gap-3">
				<div class="flex items-center gap-2 text-primary">
					<IconShield class="size-5 shrink-0" />
					<h2 class="text-base font-semibold">
						{m.settings_invitations_token_reveal_title()}
					</h2>
				</div>
				<Button
					variant="ghost"
					size="xs"
					onclick={() => settingsRevealState.dismissRevealedInvitation()}
					aria-label={m.settings_invitations_dismiss()}
				>
					<IconX data-icon="inline-start" />
				</Button>
			</div>
			<p class="mt-1 text-xs text-muted-foreground">
				{m.settings_invitations_token_reveal_warning()}
			</p>
			<p class="mt-1 text-xs font-medium text-foreground">
				{m.settings_invitations_token_reveal_metadata({
					email: settingsRevealState.revealedInvitation.email,
					invitationId: settingsRevealState.revealedInvitation.invitationId
				})}
			</p>
			<div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
				<div
					class="flex-1 rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs break-all select-all"
				>
					{settingsRevealState.revealedInvitation.token}
				</div>
				<Button
					variant="default"
					size="sm"
					class="shrink-0"
					onclick={() =>
						settingsRevealState.copyInvitationToken(settingsRevealState.revealedInvitation!.token)}
				>
					{#if settingsRevealState.invitationCopied}
						<IconCheck data-icon="inline-start" />
						<span>{m.settings_invitations_token_copied()}</span>
					{:else}
						<IconCopy data-icon="inline-start" />
						<span>{m.settings_invitations_copy_token()}</span>
					{/if}
				</Button>
			</div>
			{#if settingsRevealState.invitationCopyError}
				<p class="mt-2 text-xs font-medium text-destructive" role="alert">
					{settingsRevealState.invitationCopyError}
				</p>
			{/if}
		</div>
	{/if}

	<!-- Invitations List -->
	<Card.Root>
		<Card.Header class="flex flex-row items-center justify-between">
			<div>
				<Card.Title>{m.settings_invitations_title()}</Card.Title>
			</div>
			<Button
				variant="ghost"
				size="sm"
				onclick={() => loadInvitations()}
				disabled={invitationsLoading}
				aria-label={m.settings_invitations_refresh()}
			>
				<IconRefresh data-icon="inline-start" class={invitationsLoading ? 'animate-spin' : ''} />
			</Button>
		</Card.Header>
		<Card.Content>
			{#if invitationsError}
				<div
					class="mb-4 flex items-center justify-between rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-destructive"
					role="alert"
				>
					<span class="text-sm font-medium">{invitationsError}</span>
					<Button variant="outline" size="xs" onclick={() => loadInvitations()}
						>{m.settings_invitations_refresh()}</Button
					>
				</div>
			{/if}

			<div class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>{m.settings_invitations_col_id()}</Table.Head>
							<Table.Head>{m.settings_invitations_col_role()}</Table.Head>
							<Table.Head>{m.settings_invitations_col_status()}</Table.Head>
							<Table.Head class="hidden md:table-cell"
								>{m.settings_invitations_col_created()}</Table.Head
							>
							<Table.Head class="hidden md:table-cell"
								>{m.settings_invitations_col_expires()}</Table.Head
							>
							<Table.Head class="text-right">{m.settings_invitations_col_actions()}</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#if invitationsLoading && invitations.length === 0}
							<Table.Row>
								<Table.Cell colspan={6} class="h-24 text-center">
									<div class="flex items-center justify-center gap-2 text-muted-foreground">
										<Spinner class="size-4" />
										<span>{m.settings_invitations_loading()}</span>
									</div>
								</Table.Cell>
							</Table.Row>
						{:else if invitations.length === 0}
							<Table.Row>
								<Table.Cell colspan={6} class="h-24 text-center text-muted-foreground">
									{m.settings_invitations_empty()}
								</Table.Cell>
							</Table.Row>
						{:else}
							{#each invitations as invitation (invitation.id)}
								{@const isRevoking = revokeInvitePending[invitation.id] ?? false}
								{@const isExpiredInvitation = isInvitationExpired(invitation)}
								{@const canRevokeInvitation =
									invitation.status === 'pending' &&
									!isExpiredInvitation &&
									(isCallerOwner || (isCallerAdmin && invitation.role === 'member'))}
								<Table.Row>
									<Table.Cell class="font-mono text-xs">
										<span
											class="block max-w-[120px] truncate sm:max-w-[180px]"
											title={invitation.id}
										>
											{invitation.id}
										</span>
									</Table.Cell>
									<Table.Cell>
										<Badge variant="outline">{invitation.role}</Badge>
									</Table.Cell>
									<Table.Cell>
										{#if invitation.status === 'pending' && isExpiredInvitation}
											<Badge variant="outline">{m.settings_invitations_status_expired()}</Badge>
										{:else if invitation.status === 'pending'}
											<Badge variant="secondary">{m.settings_invitations_status_pending()}</Badge>
										{:else if invitation.status === 'accepted'}
											<Badge variant="outline">{m.settings_invitations_status_accepted()}</Badge>
										{:else}
											<Badge variant="destructive">{m.settings_invitations_status_revoked()}</Badge>
										{/if}
									</Table.Cell>
									<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
										{new Date(invitation.createdAt).toLocaleDateString(getLocale())}
									</Table.Cell>
									<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
										{new Date(invitation.expiresAt).toLocaleDateString(getLocale())}
									</Table.Cell>
									<Table.Cell class="text-right">
										{#if canRevokeInvitation}
											<Button
												variant="destructive"
												size="xs"
												onclick={() => handleRevokeInvitation(invitation.id)}
												disabled={isRevoking}
											>
												{#if isRevoking}
													<Spinner data-icon="inline-start" class="size-3" />
												{:else}
													{m.settings_invitations_action_revoke()}
												{/if}
											</Button>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/each}
						{/if}
					</Table.Body>
				</Table.Root>
			</div>

			{#if invitationsNextCursor}
				<div class="mt-4 flex justify-center">
					<Button
						variant="outline"
						size="sm"
						onclick={() => loadInvitations(invitationsNextCursor)}
						disabled={invitationsLoading}
					>
						{#if invitationsLoading}
							<Spinner data-icon="inline-start" />
						{/if}
						{m.settings_invitations_load_more()}
					</Button>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
