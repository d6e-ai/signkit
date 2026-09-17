<script lang="ts">
	import { onMount } from 'svelte';
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
	import * as Card from '$lib/components/ui/card';
	import * as Select from '$lib/components/ui/select';
	import * as Table from '$lib/components/ui/table';
	import { Spinner } from '$lib/components/ui/spinner';
	import { IconRefresh, IconUser } from '@tabler/icons-svelte';

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

	const client = createInstanceManagementClient();

	let members = $state<InstanceMemberMetadata[]>([]);
	let membersLoading = $state(false);
	let membersError = $state<string | null>(null);
	let membersNextCursor = $state<string | null>(null);
	let memberRoleDrafts = $state<Record<string, InstanceMemberRole>>({});
	let memberActionPending = $state<Record<string, boolean>>({});

	async function loadMembers(cursor?: string | null) {
		membersLoading = true;
		membersError = null;
		try {
			const res = await client.listMembers(cursor ? { cursor } : undefined);
			if (cursor) {
				members = [...members, ...res.members];
			} else {
				members = [...res.members];
			}
			membersNextCursor = res.nextCursor;
			for (const member of res.members) {
				if (!cursor || !(member.userId in memberRoleDrafts)) {
					memberRoleDrafts[member.userId] = member.role;
				}
			}
		} catch (err: unknown) {
			membersError = err instanceof Error ? err.message : String(err);
		} finally {
			membersLoading = false;
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
			membersError = err instanceof Error ? err.message : String(err);
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
			membersError = err instanceof Error ? err.message : String(err);
		} finally {
			memberActionPending[userId] = false;
		}
	}

	onMount(() => {
		void loadMembers();
	});
</script>

<Card.Root>
	<Card.Header class="flex flex-row items-center justify-between">
		<div>
			<Card.Title>{m.settings_members_title()}</Card.Title>
			<Card.Description>{m.settings_members_description()}</Card.Description>
		</div>
		<Button
			variant="ghost"
			size="sm"
			onclick={() => loadMembers()}
			disabled={membersLoading}
			aria-label={m.settings_members_refresh()}
		>
			<IconRefresh data-icon="inline-start" class={membersLoading ? 'animate-spin' : ''} />
		</Button>
	</Card.Header>
	<Card.Content>
		<!--
			This banner surfaces both list-load failures and mutation failures
			(a rejected role/status change), so its action is labeled as a list
			refresh rather than "Retry": it reloads the list, it never replays
			the failed mutation.
		-->
		{#if membersError}
			<div
				class="mb-4 flex items-center justify-between rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-destructive"
				role="alert"
			>
				<span class="text-sm font-medium">{membersError}</span>
				<Button variant="outline" size="xs" onclick={() => loadMembers()}
					>{m.settings_members_refresh()}</Button
				>
			</div>
		{/if}

		<div class="overflow-x-auto">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>{m.settings_members_col_user()}</Table.Head>
						<Table.Head>{m.settings_members_col_role()}</Table.Head>
						<Table.Head>{m.settings_members_col_status()}</Table.Head>
						<Table.Head class="hidden md:table-cell">{m.settings_members_col_joined()}</Table.Head>
						<Table.Head class="text-right">{m.settings_members_col_actions()}</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#if membersLoading && members.length === 0}
						<Table.Row>
							<Table.Cell colspan={5} class="h-24 text-center">
								<div class="flex items-center justify-center gap-2 text-muted-foreground">
									<Spinner class="size-4" />
									<span>{m.settings_members_loading()}</span>
								</div>
							</Table.Cell>
						</Table.Row>
					{:else if members.length === 0}
						<Table.Row>
							<Table.Cell colspan={5} class="h-24 text-center text-muted-foreground">
								{m.settings_members_empty()}
							</Table.Cell>
						</Table.Row>
					{:else}
						{#each members as member (member.userId)}
							{@const isSelf = member.userId === currentUserId}
							{@const isTargetMember = member.role === 'member'}
							{@const canOwnerManageRole = isCallerOwner && !isSelf}
							{@const canOwnerManageStatus = isCallerOwner && !isSelf}
							{@const canAdminManageStatus = isCallerAdmin && isTargetMember && !isSelf}
							{@const canManageStatus = canOwnerManageStatus || canAdminManageStatus}
							{@const isPendingThis = memberActionPending[member.userId] ?? false}

							<Table.Row>
								<Table.Cell class="font-mono text-xs">
									<div class="flex items-center gap-1.5">
										<IconUser class="size-3.5 text-muted-foreground" />
										<span class="max-w-[140px] truncate sm:max-w-[220px]">{member.userId}</span>
										{#if isSelf}
											<Badge variant="secondary" class="text-[10px]"
												>{m.settings_members_you()}</Badge
											>
										{/if}
									</div>
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
														userId: member.userId
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
											{member.role}
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
					{/if}
				</Table.Body>
			</Table.Root>
		</div>

		{#if membersNextCursor}
			<div class="mt-4 flex justify-center">
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
