<script lang="ts">
	import { onMount } from 'svelte';
	import MemberDisplayView from './member-display.svelte';
	import type { MemberDisplay } from '$lib/ports/instance-display-store';
	import * as Sheet from '$lib/components/ui/sheet';
	import {
		createInstanceManagementClient,
		type InstanceMemberMetadata,
		type InstanceMemberRole,
		type InstanceMemberStatus
	} from '$lib/client/instance-management';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import * as Empty from '$lib/components/ui/empty';
	import * as Select from '$lib/components/ui/select';
	import * as Table from '$lib/components/ui/table';
	import { Spinner } from '$lib/components/ui/spinner';
	import { IconAlertTriangle, IconRefresh, IconUsers } from '@tabler/icons-svelte';

	let {
		currentUserId,
		isCallerOwner,
		isCallerAdmin
	}: {
		currentUserId: string;
		isCallerOwner: boolean;
		isCallerAdmin: boolean;
	} = $props();

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

	function memberLabel(member: InstanceMemberMetadata): string {
		const display = memberDisplays[member.userId];
		return display?.state === 'available' ? display.name : member.userId;
	}

	function errorMessage(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}

	const client = createInstanceManagementClient();

	let members = $state<InstanceMemberMetadata[]>([]);
	let memberDisplays = $state<Record<string, MemberDisplay>>({});
	let detailsMember = $state<InstanceMemberMetadata | null>(null);
	let membersLoading = $state(false);
	let membersError = $state<string | null>(null);
	let membersNextCursor = $state<string | null>(null);
	let memberRoleDrafts = $state<Record<string, InstanceMemberRole>>({});
	let memberActionPending = $state<Record<string, boolean>>({});
	let listRequestSequence = 0;

	async function loadMembers(cursor?: string | null) {
		const sequence = ++listRequestSequence;
		membersLoading = true;
		membersError = null;
		try {
			const res = await client.listMembers(cursor ? { cursor } : undefined);
			if (sequence !== listRequestSequence) return;
			if (cursor) {
				members = [...members, ...res.members];
			} else {
				members = [...res.members];
			}
			memberDisplays = cursor
				? { ...memberDisplays, ...res.memberDisplays }
				: { ...res.memberDisplays };
			if (detailsMember)
				detailsMember = members.find((member) => member.userId === detailsMember?.userId) ?? null;
			membersNextCursor = res.nextCursor;
			for (const member of res.members) {
				if (!cursor || !(member.userId in memberRoleDrafts)) {
					memberRoleDrafts[member.userId] = member.role;
				}
			}
		} catch (err: unknown) {
			if (sequence !== listRequestSequence) return;
			membersError = errorMessage(err);
		} finally {
			if (sequence === listRequestSequence) membersLoading = false;
		}
	}

	async function handleSetRole(userId: string) {
		const newRole = memberRoleDrafts[userId];
		if (!newRole) return;
		memberActionPending[userId] = true;
		membersError = null;
		try {
			await client.setMemberRole(userId, newRole);
			await loadMembers();
		} catch (err: unknown) {
			membersError = errorMessage(err);
		} finally {
			memberActionPending[userId] = false;
		}
	}

	async function handleSetStatus(userId: string, newStatus: InstanceMemberStatus) {
		memberActionPending[userId] = true;
		membersError = null;
		try {
			await client.setMemberStatus(userId, newStatus);
			await loadMembers();
		} catch (err: unknown) {
			membersError = errorMessage(err);
		} finally {
			memberActionPending[userId] = false;
		}
	}

	onMount(() => {
		void loadMembers();
	});
</script>

<Card.Root>
	<Card.Header class="flex flex-wrap items-center justify-end">
		<Card.Title class="sr-only">{m.settings_members_title()}</Card.Title>
		<Card.Action>
			<Button
				variant="ghost"
				size="sm"
				onclick={() => loadMembers()}
				disabled={membersLoading}
				aria-label={m.settings_members_refresh()}
			>
				<IconRefresh data-icon="inline-start" class={membersLoading ? 'animate-spin' : ''} />
			</Button>
		</Card.Action>
	</Card.Header>
	<Card.Content class="flex flex-col gap-4">
		<!--
			This banner surfaces both list-load failures and mutation failures
			(a rejected role/status change), so its action is labeled as a list
			refresh rather than "Retry": it reloads the list, it never replays
			the failed mutation.
		-->
		{#if membersError}
			<Alert.Root variant="destructive">
				<IconAlertTriangle />
				<Alert.Title>{membersError}</Alert.Title>
				<Alert.Action>
					<Button variant="outline" size="xs" onclick={() => loadMembers()}>
						{m.settings_members_refresh()}
					</Button>
				</Alert.Action>
			</Alert.Root>
		{/if}

		{#if membersLoading && members.length === 0}
			<div class="flex items-center justify-center gap-2 py-8 text-muted-foreground">
				<Spinner class="size-4" />
				<span>{m.settings_members_loading()}</span>
			</div>
		{:else if members.length === 0}
			<Empty.Root>
				<Empty.Header>
					<Empty.Media variant="icon"><IconUsers /></Empty.Media>
					<Empty.Title>{m.settings_members_empty()}</Empty.Title>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<div class="overflow-x-auto">
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>{m.settings_members_col_user()}</Table.Head>
							<Table.Head>{m.settings_members_col_role()}</Table.Head>
							<Table.Head>{m.settings_members_col_status()}</Table.Head>
							<Table.Head class="hidden md:table-cell">{m.settings_members_col_joined()}</Table.Head
							>
							<Table.Head class="text-right">{m.settings_members_col_actions()}</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each members as member (member.userId)}
							{@const isSelf = member.userId === currentUserId}
							{@const isTargetMember = member.role === 'member'}
							{@const canOwnerManageRole = isCallerOwner && !isSelf}
							{@const canOwnerManageStatus = isCallerOwner && !isSelf}
							{@const canAdminManageStatus = isCallerAdmin && isTargetMember && !isSelf}
							{@const canManageStatus = canOwnerManageStatus || canAdminManageStatus}
							{@const isPendingThis = memberActionPending[member.userId] ?? false}

							<Table.Row>
								<Table.Cell class="min-w-52 whitespace-normal">
									<MemberDisplayView
										userId={member.userId}
										display={memberDisplays[member.userId]}
										onselect={() => (detailsMember = member)}
									/>
									{#if isSelf}<Badge variant="secondary" class="mt-2"
											>{m.settings_members_you()}</Badge
										>{/if}
								</Table.Cell>
								<Table.Cell>
									{#if canOwnerManageRole}
										<div class="flex items-center gap-1.5">
											<Select.Root
												type="single"
												bind:value={memberRoleDrafts[member.userId]}
												disabled={isPendingThis}
											>
												<Select.Trigger
													size="sm"
													class="h-7 text-xs font-medium"
													aria-label={m.settings_members_role_aria_label({
														userId: memberLabel(member)
													})}
												>
													{roleLabel(memberRoleDrafts[member.userId])}
												</Select.Trigger>
												<Select.Content>
													<Select.Group>
														<Select.Item value="owner" label={m.settings_members_role_owner()} />
														<Select.Item value="admin" label={m.settings_members_role_admin()} />
														<Select.Item value="member" label={m.settings_members_role_member()} />
													</Select.Group>
												</Select.Content>
											</Select.Root>
											{#if memberRoleDrafts[member.userId] !== member.role}
												<Button
													size="xs"
													variant="outline"
													onclick={() => handleSetRole(member.userId)}
													disabled={isPendingThis}
												>
													{#if isPendingThis}
														<Spinner data-icon="inline-start" class="size-3" />
													{:else}
														{m.settings_members_action_save_role()}
													{/if}
												</Button>
											{/if}
										</div>
									{:else}
										<Badge
											variant={member.role === 'owner'
												? 'default'
												: member.role === 'admin'
													? 'secondary'
													: 'outline'}
										>
											{roleLabel(member.role)}
										</Badge>
									{/if}
								</Table.Cell>
								<Table.Cell>
									<Badge variant={member.status === 'active' ? 'outline' : 'destructive'}>
										{member.status === 'active'
											? m.settings_members_status_active()
											: m.settings_members_status_suspended()}
									</Badge>
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
									{new Date(member.createdAt).toLocaleDateString(getLocale())}
								</Table.Cell>
								<Table.Cell class="text-right">
									{#if canManageStatus}
										{#if member.status === 'active'}
											<Button
												variant="destructive"
												size="xs"
												onclick={() => handleSetStatus(member.userId, 'suspended')}
												disabled={isPendingThis}
											>
												{#if isPendingThis}
													<Spinner data-icon="inline-start" class="size-3" />
												{:else}
													{m.settings_members_action_suspend()}
												{/if}
											</Button>
										{:else}
											<Button
												variant="outline"
												size="xs"
												onclick={() => handleSetStatus(member.userId, 'active')}
												disabled={isPendingThis}
											>
												{#if isPendingThis}
													<Spinner data-icon="inline-start" class="size-3" />
												{:else}
													{m.settings_members_action_activate()}
												{/if}
											</Button>
										{/if}
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		{/if}

		{#if membersNextCursor}
			<div class="flex justify-center">
				<Button
					variant="outline"
					size="sm"
					onclick={() => loadMembers(membersNextCursor)}
					disabled={membersLoading}
				>
					{#if membersLoading}
						<Spinner data-icon="inline-start" />
					{/if}
					{m.settings_members_load_more()}
				</Button>
			</div>
		{/if}
	</Card.Content>
</Card.Root>

<Sheet.Root
	open={detailsMember !== null}
	onOpenChange={(open) => {
		if (!open) detailsMember = null;
	}}
>
	{#if detailsMember}
		<Sheet.Content class="overflow-y-auto pb-6">
			<Sheet.Header
				><Sheet.Title>{m.settings_members_details_title()}</Sheet.Title><Sheet.Description
					>{m.settings_display_snapshot_description()}</Sheet.Description
				></Sheet.Header
			>
			<div class="flex flex-col gap-5 px-6">
				<MemberDisplayView
					userId={detailsMember.userId}
					display={memberDisplays[detailsMember.userId]}
					detailed
				/>
				<dl class="flex flex-col gap-4">
					{#if memberDisplays[detailsMember.userId]?.state === 'available'}
						<div>
							<dt class="text-xs text-muted-foreground">{m.settings_display_subject()}</dt>
							<dd class="font-mono text-xs [overflow-wrap:anywhere]">{detailsMember.userId}</dd>
						</div>
					{/if}
					<div>
						<dt class="text-xs text-muted-foreground">{m.settings_members_col_role()}</dt>
						<dd>{roleLabel(detailsMember.role)}</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">{m.settings_members_col_status()}</dt>
						<dd>
							{detailsMember.status === 'active'
								? m.settings_members_status_active()
								: m.settings_members_status_suspended()}
						</dd>
					</div>
					<div>
						<dt class="text-xs text-muted-foreground">{m.settings_members_col_joined()}</dt>
						<dd>
							<time datetime={detailsMember.createdAt}
								>{new Intl.DateTimeFormat(getLocale(), {
									dateStyle: 'medium',
									timeStyle: 'short'
								}).format(new Date(detailsMember.createdAt))}</time
							>
						</dd>
					</div>
				</dl>
			</div>
		</Sheet.Content>
	{/if}
</Sheet.Root>
