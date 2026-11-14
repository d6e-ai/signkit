<script lang="ts">
	import { onMount } from 'svelte';
	import MemberDisplayView from './member-display.svelte';
	import type { InvitationDisplay } from '$lib/ports/instance-display-store';
	import * as Sheet from '$lib/components/ui/sheet';
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
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Empty from '$lib/components/ui/empty';
	import * as Field from '$lib/components/ui/field';
	import * as Select from '$lib/components/ui/select';
	import * as Table from '$lib/components/ui/table';
	import { Spinner } from '$lib/components/ui/spinner';
	import { IconAlertTriangle, IconMailForward, IconRefresh } from '@tabler/icons-svelte';

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

	function errorMessage(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}

	const client = createInstanceManagementClient();

	let invitations = $state<InstanceInvitationMetadata[]>([]);
	let invitationDisplays = $state<Record<string, InvitationDisplay>>({});
	let detailsInvitation = $state<InstanceInvitationMetadata | null>(null);
	function invitationLabel(invitation: InstanceInvitationMetadata): string {
		const display = invitationDisplays[invitation.id];
		return display?.state === 'pending'
			? display.email
			: display?.state === 'accepted' && display.member.state === 'available'
				? display.member.name
				: invitation.id;
	}
	function formatTimestamp(value: string): string {
		return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
			new Date(value)
		);
	}

	let invitationsLoading = $state(false);
	let invitationsError = $state<string | null>(null);
	let invitationsNextCursor = $state<string | null>(null);
	let inviteEmail = $state('');
	let inviteRole = $state<InstanceMemberRole>('member');
	let invitePending = $state(false);
	let inviteCreateError = $state<string | null>(null);
	let inviteScheduledEmail = $state<string | null>(null);
	let createOpen = $state(false);
	let revokeInvitePending = $state<Record<string, boolean>>({});
	let listRequestSequence = 0;

	function isInvitationExpired(invitation: InstanceInvitationMetadata): boolean {
		return invitation.status === 'pending' && Date.parse(invitation.expiresAt) <= Date.now();
	}

	function resetCreateForm(): void {
		inviteEmail = '';
		inviteRole = 'member';
		inviteCreateError = null;
	}

	function handleCreateOpenChange(nextOpen: boolean): void {
		if (!nextOpen && invitePending) return;
		if (!nextOpen) resetCreateForm();
		createOpen = nextOpen;
	}

	function guardCreateDismiss(event: Event): void {
		if (!invitePending) return;
		event.preventDefault();
	}

	async function loadInvitations(cursor?: string | null) {
		const sequence = ++listRequestSequence;
		invitationsLoading = true;
		invitationsError = null;
		try {
			const res = await client.listInvitations(cursor ? { cursor } : undefined);
			if (sequence !== listRequestSequence) return;
			if (cursor) {
				invitations = [...invitations, ...res.invitations];
			} else {
				invitations = [...res.invitations];
			}
			invitationDisplays = cursor
				? { ...invitationDisplays, ...res.invitationDisplays }
				: { ...res.invitationDisplays };
			if (detailsInvitation)
				detailsInvitation = invitations.find((item) => item.id === detailsInvitation?.id) ?? null;
			invitationsNextCursor = res.nextCursor;
		} catch (err: unknown) {
			if (sequence !== listRequestSequence) return;
			invitationsError = errorMessage(err);
		} finally {
			if (sequence === listRequestSequence) invitationsLoading = false;
		}
	}

	async function handleCreateInvitation(event: SubmitEvent) {
		event.preventDefault();
		const email = inviteEmail.trim();
		if (!email) return;
		invitePending = true;
		inviteCreateError = null;
		inviteScheduledEmail = null;
		let created = false;
		try {
			await client.createInvitation({
				email,
				role: inviteRole,
				locale: getLocale() === 'ja' ? 'ja' : 'en'
			});
			inviteScheduledEmail = email;
			resetCreateForm();
			created = true;
		} catch (err: unknown) {
			inviteCreateError = errorMessage(err);
		} finally {
			invitePending = false;
		}
		if (created) {
			createOpen = false;
			await loadInvitations();
		}
	}

	async function handleRevokeInvitation(id: string) {
		revokeInvitePending[id] = true;
		invitationsError = null;
		try {
			await client.revokeInvitation(id);
			await loadInvitations();
		} catch (err: unknown) {
			invitationsError = errorMessage(err);
		} finally {
			revokeInvitePending[id] = false;
		}
	}

	onMount(() => {
		void loadInvitations();
	});
</script>

<div class="flex flex-col gap-6">
	{#if inviteScheduledEmail}
		<Alert.Root>
			<IconMailForward />
			<Alert.Title>{m.settings_invitations_email_scheduled_title()}</Alert.Title>
			<Alert.Description>
				{m.settings_invitations_email_scheduled_description({ email: inviteScheduledEmail })}
			</Alert.Description>
		</Alert.Root>
	{/if}

	<Card.Root>
		<Card.Header class="flex flex-wrap items-center justify-end">
			<Card.Title class="sr-only">{m.settings_invitations_title()}</Card.Title>
			<Card.Action>
				<div class="flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						onclick={() => loadInvitations()}
						disabled={invitationsLoading}
						aria-label={m.settings_invitations_refresh()}
					>
						<IconRefresh
							data-icon="inline-start"
							class={invitationsLoading ? 'animate-spin' : ''}
						/>
					</Button>
					<Button size="sm" onclick={() => (createOpen = true)}>
						<IconMailForward data-icon="inline-start" />
						{m.settings_invitations_create_title()}
					</Button>
				</div>
			</Card.Action>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if invitationsError}
				<Alert.Root variant="destructive">
					<IconAlertTriangle />
					<Alert.Title>{invitationsError}</Alert.Title>
					<Alert.Action>
						<Button variant="outline" size="xs" onclick={() => loadInvitations()}>
							{m.settings_invitations_refresh()}
						</Button>
					</Alert.Action>
				</Alert.Root>
			{/if}

			{#if invitationsLoading && invitations.length === 0}
				<div class="flex items-center justify-center gap-2 py-8 text-muted-foreground">
					<Spinner class="size-4" />
					<span>{m.settings_invitations_loading()}</span>
				</div>
			{:else if invitations.length === 0}
				<Empty.Root>
					<Empty.Header>
						<Empty.Media variant="icon"><IconMailForward /></Empty.Media>
						<Empty.Title>{m.settings_invitations_empty()}</Empty.Title>
					</Empty.Header>
				</Empty.Root>
			{:else}
				<div class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>{m.settings_invitations_col_recipient()}</Table.Head>
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
							{#each invitations as invitation (invitation.id)}
								{@const isRevoking = revokeInvitePending[invitation.id] ?? false}
								{@const isExpiredInvitation = isInvitationExpired(invitation)}
								{@const canRevokeInvitation =
									invitation.status === 'pending' &&
									!isExpiredInvitation &&
									(isCallerOwner || (isCallerAdmin && invitation.role === 'member'))}
								<Table.Row>
									<Table.Cell class="min-w-52 whitespace-normal">
										{@const display = invitationDisplays[invitation.id]}
										{#if display?.state === 'accepted' && display.member.state === 'available'}
											<MemberDisplayView
												userId={invitation.acceptedByUserId ?? invitation.id}
												display={display.member}
												onselect={() => (detailsInvitation = invitation)}
											/>
										{:else}
											<div class="flex flex-col items-start gap-1">
												<Button
													variant="link"
													class="h-auto justify-start p-0 whitespace-normal"
													aria-label={m.settings_display_details_for({
														name: invitationLabel(invitation)
													})}
													onclick={() => (detailsInvitation = invitation)}
													><bdi dir="auto" class="[overflow-wrap:anywhere]"
														>{invitationLabel(invitation)}</bdi
													></Button
												>
												{#if display?.state !== 'pending'}<p class="text-xs text-muted-foreground">
														{display?.state === 'redacted'
															? m.settings_invitation_target_removed()
															: m.settings_display_unavailable()}
													</p>{/if}
											</div>
										{/if}
									</Table.Cell>
									<Table.Cell>
										<Badge variant="outline">{roleLabel(invitation.role)}</Badge>
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
						</Table.Body>
					</Table.Root>
				</div>
			{/if}

			{#if invitationsNextCursor}
				<div class="flex justify-center">
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

<Dialog.Root bind:open={() => createOpen, handleCreateOpenChange}>
	<Dialog.Content
		class="sm:max-w-lg"
		showCloseButton={!invitePending}
		closeLabel={m.common_cancel()}
		interactOutsideBehavior={invitePending ? 'ignore' : 'close'}
		escapeKeydownBehavior={invitePending ? 'ignore' : 'close'}
		onInteractOutside={guardCreateDismiss}
		onEscapeKeydown={guardCreateDismiss}
	>
		<Dialog.Header>
			<Dialog.Title>{m.settings_invitations_create_title()}</Dialog.Title>
			<Dialog.Description>{m.settings_invitations_create_description()}</Dialog.Description>
		</Dialog.Header>
		<form class="flex flex-col gap-6" onsubmit={handleCreateInvitation}>
			<Field.FieldGroup>
				{#if inviteCreateError}
					<Alert.Root variant="destructive">
						<IconAlertTriangle />
						<Alert.Title>{inviteCreateError}</Alert.Title>
					</Alert.Root>
				{/if}
				<Field.Field data-disabled={invitePending}>
					<Field.FieldLabel for="invite-email">
						{m.settings_invitations_email_label()}
					</Field.FieldLabel>
					<Input
						id="invite-email"
						type="email"
						placeholder={m.settings_invitations_email_placeholder()}
						bind:value={inviteEmail}
						disabled={invitePending}
						required
					/>
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
			</Field.FieldGroup>
			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					disabled={invitePending}
					onclick={() => handleCreateOpenChange(false)}
				>
					{m.common_cancel()}
				</Button>
				<Button type="submit" disabled={invitePending || !inviteEmail.trim()}>
					{#if invitePending}
						<Spinner data-icon="inline-start" />
						<span>{m.settings_invitations_create_pending()}</span>
					{:else}
						<IconMailForward data-icon="inline-start" />
						<span>{m.settings_invitations_create_action()}</span>
					{/if}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Sheet.Root
	open={detailsInvitation !== null}
	onOpenChange={(open) => {
		if (!open) detailsInvitation = null;
	}}
>
	{#if detailsInvitation}
		{@const display = invitationDisplays[detailsInvitation.id]}
		<Sheet.Content class="overflow-y-auto pb-6">
			<Sheet.Header
				><Sheet.Title>{m.settings_invitations_details_title()}</Sheet.Title><Sheet.Description
					>{m.settings_invitations_details_description()}</Sheet.Description
				></Sheet.Header
			>
			<div class="flex flex-col gap-5 px-6">
				{#if display?.state === 'pending'}
					<div>
						<p class="text-xs text-muted-foreground">{m.settings_invitations_col_recipient()}</p>
						<p class="[overflow-wrap:anywhere]"><bdi dir="auto">{display.email}</bdi></p>
					</div>
				{:else if display?.state === 'accepted'}
					<div class="flex flex-col gap-2">
						<p class="text-xs text-muted-foreground">{m.settings_invitation_accepted_member()}</p>
						<MemberDisplayView
							userId={detailsInvitation.acceptedByUserId ?? detailsInvitation.id}
							display={display.member}
							detailed
						/>
					</div>
				{:else}<p class="text-sm text-muted-foreground">
						{display?.state === 'redacted'
							? m.settings_invitation_target_removed()
							: m.settings_display_unavailable()}
					</p>{/if}
				<dl class="flex flex-col gap-4">
					<div>
						<dt class="text-xs text-muted-foreground">{m.settings_invitations_col_id()}</dt>
						<dd class="font-mono text-xs [overflow-wrap:anywhere]">{detailsInvitation.id}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">{m.settings_invitations_col_role()}</dt>
						<dd>{roleLabel(detailsInvitation.role)}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">{m.settings_invitations_col_created()}</dt>
						<dd>
							<time datetime={detailsInvitation.createdAt}
								>{formatTimestamp(detailsInvitation.createdAt)}</time
							>
						</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">{m.settings_invitations_col_expires()}</dt>
						<dd>
							<time datetime={detailsInvitation.expiresAt}
								>{formatTimestamp(detailsInvitation.expiresAt)}</time
							>
						</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">{m.settings_invitation_invited_by()}</dt>
						<dd class="font-mono text-xs [overflow-wrap:anywhere]">
							{detailsInvitation.invitedByUserId}
						</dd>
					</div>
					{#if detailsInvitation.acceptedAt}<div>
							<dt class="text-xs text-muted-foreground">{m.settings_invitation_accepted_at()}</dt>
							<dd>
								<time datetime={detailsInvitation.acceptedAt}
									>{formatTimestamp(detailsInvitation.acceptedAt)}</time
								>
							</dd>
						</div>{/if}
					{#if detailsInvitation.acceptedByUserId && !(display?.state === 'accepted' && display.member.state === 'unavailable')}<div
						>
							<dt class="text-xs text-muted-foreground">{m.settings_display_subject()}</dt>
							<dd class="font-mono text-xs [overflow-wrap:anywhere]">
								{detailsInvitation.acceptedByUserId}
							</dd>
						</div>{/if}
					{#if detailsInvitation.revokedAt}<div>
							<dt class="text-xs text-muted-foreground">{m.settings_invitation_revoked_at()}</dt>
							<dd>
								<time datetime={detailsInvitation.revokedAt}
									>{formatTimestamp(detailsInvitation.revokedAt)}</time
								>
							</dd>
						</div>{/if}
				</dl>
			</div>
		</Sheet.Content>
	{/if}
</Sheet.Root>
