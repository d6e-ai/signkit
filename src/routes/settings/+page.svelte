<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		createInstanceManagementClient,
		InstanceManagementApiError,
		type InstanceCallerContext,
		type InstanceMemberMetadata,
		type InstanceMemberRole,
		type InstanceMemberStatus,
		type InstanceInvitationMetadata,
		type ApiKeyMetadata,
		type ApiKeyScope
	} from '$lib/client/instance-management';
	import {
		API_KEY_DEFAULT_EXPIRY_DAYS,
		API_KEY_MAX_EXPIRY_DAYS,
		API_KEY_SCOPES
	} from '$lib/security/api-key';
	import * as m from '$lib/paraglide/messages';
	import { getLocale, localizeHref } from '$lib/paraglide/runtime';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Table from '$lib/components/ui/table';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Spinner } from '$lib/components/ui/spinner';
	import {
		IconAlertTriangle,
		IconCheck,
		IconCopy,
		IconKey,
		IconLock,
		IconMail,
		IconPlus,
		IconRefresh,
		IconShield,
		IconUser,
		IconX
	} from '@tabler/icons-svelte';

	const client = createInstanceManagementClient();

	let initialLoading = $state(true);
	let authRequired = $state(false);
	let callerContext = $state<InstanceCallerContext | null>(null);
	let globalError = $state<string | null>(null);

	// Tracks whether a load attempt has been made for the active tab, success or
	// failure, so a failed request is never retried automatically: only an
	// explicit Retry/Refresh click (which calls the load function directly,
	// bypassing this flag) tries again.
	let membersLoadAttempted = $state(false);
	let invitationsLoadAttempted = $state(false);
	let apiKeysLoadAttempted = $state(false);

	const signInHref = $derived(
		localizeHref(`/auth/login?return=${encodeURIComponent(page.url.pathname)}`)
	);

	// Invitation Accept State
	let invitationToken = $state('');
	let acceptPending = $state(false);
	let acceptError = $state<string | null>(null);
	let acceptSuccess = $state<string | null>(null);

	// Active tab
	let activeTab = $state('members');

	// Members Tab State
	let members = $state<InstanceMemberMetadata[]>([]);
	let membersLoading = $state(false);
	let membersError = $state<string | null>(null);
	let membersNextCursor = $state<string | null>(null);
	let memberRoleDrafts = $state<Record<string, InstanceMemberRole>>({});
	let memberActionPending = $state<Record<string, boolean>>({});

	interface RevealedInvitation {
		token: string;
		invitationId: string;
		email: string;
	}

	interface RevealedApiKey {
		secret: string;
		keyId: string;
		keyName: string;
	}

	// Invitations Tab State
	let invitations = $state<InstanceInvitationMetadata[]>([]);
	let invitationsLoading = $state(false);
	let invitationsError = $state<string | null>(null);
	let invitationsNextCursor = $state<string | null>(null);
	let inviteEmail = $state('');
	let inviteRole = $state<InstanceMemberRole>('member');
	let invitePending = $state(false);
	let inviteCreateError = $state<string | null>(null);
	let revealedInvitation = $state<RevealedInvitation | null>(null);
	let invitationCopied = $state(false);
	let invitationCopyError = $state<string | null>(null);
	let invitationCopyTimeoutId: ReturnType<typeof setTimeout> | undefined;
	let revokeInvitePending = $state<Record<string, boolean>>({});

	// API Keys Tab State
	let apiKeys = $state<ApiKeyMetadata[]>([]);
	let apiKeysLoading = $state(false);
	let apiKeysError = $state<string | null>(null);
	let apiKeysNextCursor = $state<string | null>(null);
	let newKeyName = $state('');
	function defaultSelectedScopes(): Record<ApiKeyScope, boolean> {
		return Object.fromEntries(API_KEY_SCOPES.map((scope) => [scope, false])) as Record<
			ApiKeyScope,
			boolean
		>;
	}
	let selectedScopes = $state<Record<ApiKeyScope, boolean>>(defaultSelectedScopes());
	let keyExpiryDays = $state<number | ''>(API_KEY_DEFAULT_EXPIRY_DAYS);
	let keyPending = $state(false);
	let keyCreateError = $state<string | null>(null);
	let revealedApiKey = $state<RevealedApiKey | null>(null);
	let apiKeyCopied = $state(false);
	let apiKeyCopyError = $state<string | null>(null);
	let apiKeyCopyTimeoutId: ReturnType<typeof setTimeout> | undefined;
	let revokeKeyPending = $state<Record<string, boolean>>({});

	const EXPIRY_CLOCK_SKEW_SAFETY_BUFFER_MS = 5 * 60 * 1000;

	function isInvitationExpired(invitation: InstanceInvitationMetadata): boolean {
		return invitation.status === 'pending' && Date.parse(invitation.expiresAt) <= Date.now();
	}

	function isApiKeyExpired(key: ApiKeyMetadata): boolean {
		return key.revokedAt === null && Date.parse(key.expiresAt) <= Date.now();
	}

	const currentMember = $derived(callerContext?.member ?? null);
	const isActiveMember = $derived(currentMember?.status === 'active');
	const isOwnerOrAdmin = $derived(
		isActiveMember && (currentMember?.role === 'owner' || currentMember?.role === 'admin')
	);
	const isCallerOwner = $derived(currentMember?.role === 'owner');
	const isCallerAdmin = $derived(currentMember?.role === 'admin');

	async function loadContext() {
		initialLoading = true;
		globalError = null;
		authRequired = false;
		membersLoadAttempted = false;
		invitationsLoadAttempted = false;
		apiKeysLoadAttempted = false;
		try {
			callerContext = await client.getCurrentMember();
			// The root layout guard already redirects an unbootstrapped instance to
			// /setup before this page can render. `member` is always null pre-
			// bootstrap, so on the unreachable path where this still executes, it
			// falls through to the same invitation-accept card as a non-member.
			const member = callerContext.member;
			if (member && member.status === 'active' && member.role === 'member') {
				// Only the API keys tab exists for a plain active member.
				activeTab = 'api-keys';
			}
		} catch (err: unknown) {
			if (err instanceof InstanceManagementApiError && err.status === 401) {
				authRequired = true;
			} else {
				globalError = err instanceof Error ? err.message : String(err);
			}
		} finally {
			initialLoading = false;
		}
	}

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
			await loadContext();
		} catch (err: unknown) {
			acceptError = err instanceof Error ? err.message : String(err);
		} finally {
			acceptPending = false;
		}
	}

	async function loadMembers(cursor?: string | null) {
		membersLoading = true;
		membersError = null;
		membersLoadAttempted = true;
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
			const res = await client.setMemberRole(userId, newRole);
			if (res.revokedInvitationCount > 0) {
				invitationsLoadAttempted = false;
			}
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
			const res = await client.setMemberStatus(userId, newStatus);
			if (res.revokedInvitationCount > 0) {
				invitationsLoadAttempted = false;
			}
			await loadMembers();
		} catch (err: unknown) {
			membersError = err instanceof Error ? err.message : String(err);
		} finally {
			memberActionPending[userId] = false;
		}
	}

	async function loadInvitations(cursor?: string | null) {
		invitationsLoading = true;
		invitationsError = null;
		invitationsLoadAttempted = true;
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
			// Replace the revealed secret only once a fresh token has actually
			// arrived. A failed request, or a replay that discloses no token, must
			// leave the previous one-time token on screen: clearing it up front
			// would destroy the only copy the inviter will ever be shown.
			if (res.token) {
				resetInvitationCopyFeedback();
				revealedInvitation = { token: res.token, invitationId: res.invitation.id, email };
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

	async function loadApiKeys(cursor?: string | null) {
		apiKeysLoading = true;
		apiKeysError = null;
		apiKeysLoadAttempted = true;
		try {
			const res = await client.listApiKeys(cursor ? { cursor } : undefined);
			if (cursor) {
				apiKeys = [...apiKeys, ...res.page.items];
			} else {
				apiKeys = [...res.page.items];
			}
			apiKeysNextCursor = res.page.nextCursor;
		} catch (err: unknown) {
			apiKeysError = err instanceof Error ? err.message : String(err);
		} finally {
			apiKeysLoading = false;
		}
	}

	async function handleCreateApiKey(event: SubmitEvent) {
		event.preventDefault();
		const name = newKeyName.trim();
		const scopes = Object.entries(selectedScopes)
			.filter(([, active]) => active)
			.map(([scope]) => scope as ApiKeyScope);

		if (!name || scopes.length === 0) return;
		keyPending = true;
		keyCreateError = null;
		try {
			// Omit expiresAt entirely for a blank/default value so the server
			// applies its own default rather than rejecting an explicit null.
			// A safety buffer absorbs clock skew between this browser's clock
			// and the server's, so a requested max-length expiry never lands
			// just past the server's own max-expiry boundary.
			let expiresAt: string | undefined;
			if (typeof keyExpiryDays === 'number' && keyExpiryDays > 0) {
				const requestedMs = keyExpiryDays * 24 * 60 * 60 * 1000;
				expiresAt = new Date(
					Date.now() + requestedMs - EXPIRY_CLOCK_SKEW_SAFETY_BUFFER_MS
				).toISOString();
			}
			const res = await client.createApiKey({ name, scopes, expiresAt });
			const secret = res.secret || res.token;
			// Same one-time discipline as the invitation token above: only a
			// response carrying a fresh secret may displace the previous reveal.
			if (secret) {
				resetApiKeyCopyFeedback();
				revealedApiKey = { secret, keyId: res.apiKey.id, keyName: res.apiKey.name };
			}
			newKeyName = '';
			selectedScopes = defaultSelectedScopes();
			keyExpiryDays = API_KEY_DEFAULT_EXPIRY_DAYS;
			await loadApiKeys();
		} catch (err: unknown) {
			keyCreateError = err instanceof Error ? err.message : String(err);
		} finally {
			keyPending = false;
		}
	}

	async function handleRevokeApiKey(id: string) {
		revokeKeyPending[id] = true;
		apiKeysError = null;
		try {
			await client.revokeApiKey(id);
			await loadApiKeys();
		} catch (err: unknown) {
			apiKeysError = err instanceof Error ? err.message : String(err);
		} finally {
			revokeKeyPending[id] = false;
		}
	}

	// Copy feedback belongs to exactly one revealed secret. A stale "Copied!"
	// or copy error must never carry onto the next reveal: a user who trusts a
	// carried-over "Copied!" would dismiss a one-time secret that was never
	// actually placed on the clipboard. These run in the same synchronous step
	// that installs the replacement reveal, so secret and feedback are never
	// rendered out of sync, and only ever on an explicit dismiss or a response
	// that actually carried a fresh secret.
	function resetInvitationCopyFeedback() {
		clearTimeout(invitationCopyTimeoutId);
		invitationCopyTimeoutId = undefined;
		invitationCopied = false;
		invitationCopyError = null;
	}

	function resetApiKeyCopyFeedback() {
		clearTimeout(apiKeyCopyTimeoutId);
		apiKeyCopyTimeoutId = undefined;
		apiKeyCopied = false;
		apiKeyCopyError = null;
	}

	function dismissRevealedInvitation() {
		revealedInvitation = null;
		resetInvitationCopyFeedback();
	}

	function dismissRevealedApiKey() {
		revealedApiKey = null;
		resetApiKeyCopyFeedback();
	}

	async function copyToClipboard(text: string, kind: 'invitation' | 'apiKey') {
		if (kind === 'invitation') {
			invitationCopyError = null;
		} else {
			apiKeyCopyError = null;
		}
		try {
			await navigator.clipboard.writeText(text);
			if (kind === 'invitation') {
				invitationCopied = true;
				clearTimeout(invitationCopyTimeoutId);
				invitationCopyTimeoutId = setTimeout(() => {
					invitationCopied = false;
					invitationCopyTimeoutId = undefined;
				}, 2000);
			} else {
				apiKeyCopied = true;
				clearTimeout(apiKeyCopyTimeoutId);
				apiKeyCopyTimeoutId = setTimeout(() => {
					apiKeyCopied = false;
					apiKeyCopyTimeoutId = undefined;
				}, 2000);
			}
		} catch {
			const message = m.settings_clipboard_copy_failed();
			if (kind === 'invitation') {
				invitationCopyError = message;
			} else {
				apiKeyCopyError = message;
			}
		}
	}

	$effect(() => {
		if (!isActiveMember) return;
		if (isOwnerOrAdmin && activeTab === 'members' && !membersLoadAttempted && !membersLoading) {
			loadMembers();
		} else if (
			isOwnerOrAdmin &&
			activeTab === 'invitations' &&
			!invitationsLoadAttempted &&
			!invitationsLoading
		) {
			loadInvitations();
		} else if (activeTab === 'api-keys' && !apiKeysLoadAttempted && !apiKeysLoading) {
			loadApiKeys();
		}
	});

	onMount(() => {
		loadContext();
	});

	onDestroy(() => {
		clearTimeout(invitationCopyTimeoutId);
		clearTimeout(apiKeyCopyTimeoutId);
	});
</script>

<svelte:head>
	<title>{m.settings_title()} — {m.app_name()}</title>
</svelte:head>

<div class="mx-auto max-w-6xl space-y-6">
	<div class="space-y-1">
		<h1 class="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
			{m.settings_title()}
		</h1>
		<p class="text-sm text-muted-foreground">
			{m.settings_description()}
		</p>
	</div>

	{#if initialLoading}
		<div
			class="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground"
			aria-live="polite"
		>
			<Spinner class="size-8" />
			<p class="text-sm font-medium">{m.settings_members_loading()}</p>
		</div>
	{:else if authRequired}
		<Card.Root class="mx-auto max-w-md">
			<Card.Header>
				<div
					class="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"
				>
					<IconLock class="size-5" />
				</div>
				<Card.Title>{m.settings_sign_in_title()}</Card.Title>
				<Card.Description>{m.settings_sign_in_description()}</Card.Description>
			</Card.Header>
			<Card.Footer>
				<Button href={signInHref} class="w-full">
					{m.settings_sign_in_action()}
				</Button>
			</Card.Footer>
		</Card.Root>
	{:else if globalError}
		<div
			class="flex items-center gap-3 rounded-2xl border border-destructive/20 bg-destructive/10 p-4 text-destructive"
			role="alert"
		>
			<IconAlertTriangle class="size-5 shrink-0" />
			<div class="flex-1 text-sm font-medium">{globalError}</div>
			<Button variant="outline" size="sm" onclick={() => loadContext()}>
				{m.common_retry()}
			</Button>
		</div>
	{:else if !currentMember}
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
				<form onsubmit={handleAcceptInvitation} class="space-y-4">
					<div class="space-y-1.5">
						<label for="invitation-token" class="text-sm font-medium text-foreground">
							{m.settings_invitation_token_label()}
						</label>
						<Input
							id="invitation-token"
							type="text"
							placeholder={m.settings_invitation_token_placeholder()}
							bind:value={invitationToken}
							disabled={acceptPending}
							required
						/>
					</div>

					{#if acceptError}
						<p class="text-xs font-medium text-destructive" role="alert">{acceptError}</p>
					{/if}
					{#if acceptSuccess}
						<p class="text-xs font-medium text-emerald-600 dark:text-emerald-400">
							{acceptSuccess}
						</p>
					{/if}

					<Button type="submit" class="w-full" disabled={acceptPending || !invitationToken.trim()}>
						{#if acceptPending}
							<Spinner class="size-4" />
							<span>{m.settings_invitation_accept_pending()}</span>
						{:else}
							<span>{m.settings_invitation_accept_action()}</span>
						{/if}
					</Button>
				</form>
			</Card.Content>
		</Card.Root>
	{:else if !isActiveMember}
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
					<Badge variant="outline">{currentMember.role}</Badge>
					<span class="text-muted-foreground">{m.settings_members_col_status()}:</span>
					<Badge variant={currentMember.status === 'active' ? 'secondary' : 'destructive'}>
						{currentMember.status}
					</Badge>
				</div>
			</Card.Content>
		</Card.Root>
	{:else}
		<Tabs.Root bind:value={activeTab} class="space-y-6">
			<Tabs.List
				class={isOwnerOrAdmin
					? 'grid w-full grid-cols-3 sm:inline-grid sm:w-auto'
					: 'grid w-full grid-cols-1 sm:inline-grid sm:w-auto'}
			>
				{#if isOwnerOrAdmin}
					<Tabs.Trigger value="members">{m.settings_tab_members()}</Tabs.Trigger>
					<Tabs.Trigger value="invitations">{m.settings_tab_invitations()}</Tabs.Trigger>
				{/if}
				<Tabs.Trigger value="api-keys">{m.settings_tab_api_keys()}</Tabs.Trigger>
			</Tabs.List>

			{#if isOwnerOrAdmin}
				<!-- MEMBERS TAB -->
				<Tabs.Content value="members" class="space-y-6">
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
								<IconRefresh class={membersLoading ? 'animate-spin' : ''} />
							</Button>
						</Card.Header>
						<Card.Content>
							<!--
								This banner surfaces both list-load failures and mutation failures
								(a rejected role/status change), so its action is labeled as a list
								refresh rather than "Retry": it reloads the list, it never replays
								the failed mutation. The same holds for the invitation and API key
								list banners below.
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
											<Table.Head class="hidden md:table-cell"
												>{m.settings_members_col_joined()}</Table.Head
											>
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
												{@const isSelf = member.userId === currentMember?.userId}
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
															<span class="max-w-[140px] truncate sm:max-w-[220px]"
																>{member.userId}</span
															>
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
																<select
																	aria-label={m.settings_members_role_aria_label({
																		userId: member.userId
																	})}
																	bind:value={memberRoleDrafts[member.userId]}
																	class="h-7 rounded-lg border border-input bg-background px-2 text-xs font-medium focus-visible:ring-1 focus-visible:ring-ring"
																	disabled={isPendingThis}
																>
																	<option value="owner">{m.settings_members_role_owner()}</option>
																	<option value="admin">{m.settings_members_role_admin()}</option>
																	<option value="member">{m.settings_members_role_member()}</option>
																</select>
																{#if memberRoleDrafts[member.userId] !== member.role}
																	<Button
																		size="xs"
																		variant="outline"
																		onclick={() => handleSetRole(member.userId)}
																		disabled={isPendingThis}
																	>
																		{#if isPendingThis}
																			<Spinner class="size-3" />
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
																		<Spinner class="size-3" />
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
																		<Spinner class="size-3" />
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
											<Spinner class="size-4" />
										{/if}
										{m.settings_members_load_more()}
									</Button>
								</div>
							{/if}
						</Card.Content>
					</Card.Root>
				</Tabs.Content>

				<!-- INVITATIONS TAB -->
				<Tabs.Content value="invitations" class="space-y-6">
					<!-- Create Form -->
					<Card.Root>
						<Card.Header>
							<Card.Title>{m.settings_invitations_create_title()}</Card.Title>
						</Card.Header>
						<Card.Content>
							<form onsubmit={handleCreateInvitation} class="space-y-4">
								<div class="grid gap-4 sm:grid-cols-2">
									<div class="space-y-1.5">
										<label for="invite-email" class="text-sm font-medium text-foreground">
											{m.settings_invitations_email_label()}
										</label>
										<Input
											id="invite-email"
											type="email"
											placeholder={m.settings_invitations_email_placeholder()}
											bind:value={inviteEmail}
											disabled={invitePending}
											required
										/>
									</div>
									<div class="space-y-1.5">
										<label for="invite-role" class="text-sm font-medium text-foreground">
											{m.settings_invitations_role_label()}
										</label>
										<select
											id="invite-role"
											bind:value={inviteRole}
											disabled={invitePending}
											class="flex h-9 w-full rounded-2xl border border-input bg-input/50 px-3 py-1.5 text-sm font-medium focus-visible:ring-3 focus-visible:ring-ring/30"
										>
											<option value="member">{m.settings_members_role_member()}</option>
											{#if isCallerOwner}
												<option value="admin">{m.settings_members_role_admin()}</option>
												<option value="owner">{m.settings_members_role_owner()}</option>
											{/if}
										</select>
									</div>
								</div>

								{#if inviteCreateError}
									<p class="text-xs font-medium text-destructive" role="alert">
										{inviteCreateError}
									</p>
								{/if}

								<Button type="submit" disabled={invitePending || !inviteEmail.trim()}>
									{#if invitePending}
										<Spinner class="size-4" />
										<span>{m.settings_invitations_create_pending()}</span>
									{:else}
										<IconPlus class="size-4" />
										<span>{m.settings_invitations_create_action()}</span>
									{/if}
								</Button>
							</form>
						</Card.Content>
					</Card.Root>

					<!-- One-Time Token Reveal Warning Banner -->
					{#if revealedInvitation}
						<div
							class="rounded-2xl border-2 border-primary bg-primary/5 p-4 shadow-xs sm:p-5"
							role="alert"
						>
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
									onclick={dismissRevealedInvitation}
									aria-label={m.settings_invitations_dismiss()}
								>
									<IconX class="size-4" />
								</Button>
							</div>
							<p class="mt-1 text-xs text-muted-foreground">
								{m.settings_invitations_token_reveal_warning()}
							</p>
							<p class="mt-1 text-xs font-medium text-foreground">
								{m.settings_invitations_token_reveal_metadata({
									email: revealedInvitation.email,
									invitationId: revealedInvitation.invitationId
								})}
							</p>
							<div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
								<div
									class="flex-1 rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs break-all select-all"
								>
									{revealedInvitation.token}
								</div>
								<Button
									variant="default"
									size="sm"
									class="shrink-0"
									onclick={() => copyToClipboard(revealedInvitation!.token, 'invitation')}
								>
									{#if invitationCopied}
										<IconCheck class="size-4" />
										<span>{m.settings_invitations_token_copied()}</span>
									{:else}
										<IconCopy class="size-4" />
										<span>{m.settings_invitations_copy_token()}</span>
									{/if}
								</Button>
							</div>
							{#if invitationCopyError}
								<p class="mt-2 text-xs font-medium text-destructive" role="alert">
									{invitationCopyError}
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
								<IconRefresh class={invitationsLoading ? 'animate-spin' : ''} />
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
											<Table.Head class="text-right"
												>{m.settings_invitations_col_actions()}</Table.Head
											>
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
															<Badge variant="outline"
																>{m.settings_invitations_status_expired()}</Badge
															>
														{:else if invitation.status === 'pending'}
															<Badge variant="secondary"
																>{m.settings_invitations_status_pending()}</Badge
															>
														{:else if invitation.status === 'accepted'}
															<Badge variant="outline"
																>{m.settings_invitations_status_accepted()}</Badge
															>
														{:else}
															<Badge variant="destructive"
																>{m.settings_invitations_status_revoked()}</Badge
															>
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
																	<Spinner class="size-3" />
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
											<Spinner class="size-4" />
										{/if}
										{m.settings_invitations_load_more()}
									</Button>
								</div>
							{/if}
						</Card.Content>
					</Card.Root>
				</Tabs.Content>
			{/if}

			<!-- API KEYS TAB -->
			<Tabs.Content value="api-keys" class="space-y-6">
				<!-- Create API Key Form -->
				<Card.Root>
					<Card.Header>
						<Card.Title>{m.settings_api_keys_create_title()}</Card.Title>
					</Card.Header>
					<Card.Content>
						<form onsubmit={handleCreateApiKey} class="space-y-4">
							<div class="grid gap-4 sm:grid-cols-2">
								<div class="space-y-1.5">
									<label for="key-name" class="text-sm font-medium text-foreground">
										{m.settings_api_keys_name_label()}
									</label>
									<Input
										id="key-name"
										type="text"
										placeholder={m.settings_api_keys_name_placeholder()}
										bind:value={newKeyName}
										disabled={keyPending}
										required
									/>
								</div>
								<div class="space-y-1.5">
									<label for="key-expiry" class="text-sm font-medium text-foreground">
										{m.settings_api_keys_expiry_label()}
									</label>
									<Input
										id="key-expiry"
										type="number"
										min="1"
										max={API_KEY_MAX_EXPIRY_DAYS}
										placeholder={m.settings_api_keys_expiry_placeholder()}
										bind:value={keyExpiryDays}
										disabled={keyPending}
									/>
								</div>
							</div>

							<div class="space-y-2">
								<span class="block text-sm font-medium text-foreground">
									{m.settings_api_keys_scopes_label()}
								</span>
								<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
									{#each API_KEY_SCOPES as scope (scope)}
										<label
											for="scope-{scope}"
											class="flex cursor-pointer items-center gap-2 rounded-xl border border-border p-2.5 font-mono text-xs hover:bg-muted/50"
										>
											<Checkbox
												id="scope-{scope}"
												bind:checked={selectedScopes[scope]}
												disabled={keyPending}
											/>
											<span class="truncate">{scope}</span>
										</label>
									{/each}
								</div>
							</div>

							{#if keyCreateError}
								<p class="text-xs font-medium text-destructive" role="alert">{keyCreateError}</p>
							{/if}

							<Button
								type="submit"
								disabled={keyPending ||
									!newKeyName.trim() ||
									Object.values(selectedScopes).every((v) => !v)}
							>
								{#if keyPending}
									<Spinner class="size-4" />
									<span>{m.settings_api_keys_create_pending()}</span>
								{:else}
									<IconPlus class="size-4" />
									<span>{m.settings_api_keys_create_action()}</span>
								{/if}
							</Button>
						</form>
					</Card.Content>
				</Card.Root>

				<!-- One-Time API Key Reveal Warning Banner -->
				{#if revealedApiKey}
					<div
						class="rounded-2xl border-2 border-primary bg-primary/5 p-4 shadow-xs sm:p-5"
						role="alert"
					>
						<div class="flex items-start justify-between gap-3">
							<div class="flex items-center gap-2 text-primary">
								<IconKey class="size-5 shrink-0" />
								<h2 class="text-base font-semibold">{m.settings_api_keys_secret_reveal_title()}</h2>
							</div>
							<Button
								variant="ghost"
								size="xs"
								onclick={dismissRevealedApiKey}
								aria-label={m.settings_api_keys_dismiss()}
							>
								<IconX class="size-4" />
							</Button>
						</div>
						<p class="mt-1 text-xs text-muted-foreground">
							{m.settings_api_keys_secret_reveal_warning()}
						</p>
						<p class="mt-1 text-xs font-medium text-foreground">
							{m.settings_api_keys_secret_reveal_metadata({
								name: revealedApiKey.keyName,
								keyId: revealedApiKey.keyId
							})}
						</p>
						<div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
							<div
								class="flex-1 rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs break-all select-all"
							>
								{revealedApiKey.secret}
							</div>
							<Button
								variant="default"
								size="sm"
								class="shrink-0"
								onclick={() => copyToClipboard(revealedApiKey!.secret, 'apiKey')}
							>
								{#if apiKeyCopied}
									<IconCheck class="size-4" />
									<span>{m.settings_api_keys_secret_copied()}</span>
								{:else}
									<IconCopy class="size-4" />
									<span>{m.settings_api_keys_copy_secret()}</span>
								{/if}
							</Button>
						</div>
						{#if apiKeyCopyError}
							<p class="mt-2 text-xs font-medium text-destructive" role="alert">
								{apiKeyCopyError}
							</p>
						{/if}
					</div>
				{/if}

				<!-- API Keys List -->
				<Card.Root>
					<Card.Header class="flex flex-row items-center justify-between">
						<div>
							<Card.Title>{m.settings_api_keys_title()}</Card.Title>
							<Card.Description>{m.settings_api_keys_description()}</Card.Description>
						</div>
						<Button
							variant="ghost"
							size="sm"
							onclick={() => loadApiKeys()}
							disabled={apiKeysLoading}
							aria-label={m.settings_api_keys_refresh()}
						>
							<IconRefresh class={apiKeysLoading ? 'animate-spin' : ''} />
						</Button>
					</Card.Header>
					<Card.Content>
						{#if apiKeysError}
							<div
								class="mb-4 flex items-center justify-between rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-destructive"
								role="alert"
							>
								<span class="text-sm font-medium">{apiKeysError}</span>
								<Button variant="outline" size="xs" onclick={() => loadApiKeys()}
									>{m.settings_api_keys_refresh()}</Button
								>
							</div>
						{/if}

						<div class="overflow-x-auto">
							<Table.Root>
								<Table.Header>
									<Table.Row>
										<Table.Head>{m.settings_api_keys_col_name()}</Table.Head>
										<Table.Head>{m.settings_api_keys_col_prefix()}</Table.Head>
										<Table.Head class="hidden sm:table-cell"
											>{m.settings_api_keys_col_scopes()}</Table.Head
										>
										<Table.Head class="hidden md:table-cell"
											>{m.settings_api_keys_col_created()}</Table.Head
										>
										<Table.Head class="hidden md:table-cell"
											>{m.settings_api_keys_col_expires()}</Table.Head
										>
										<Table.Head>{m.settings_api_keys_col_status()}</Table.Head>
										<Table.Head class="text-right">{m.settings_api_keys_col_actions()}</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#if apiKeysLoading && apiKeys.length === 0}
										<Table.Row>
											<Table.Cell colspan={7} class="h-24 text-center">
												<div class="flex items-center justify-center gap-2 text-muted-foreground">
													<Spinner class="size-4" />
													<span>{m.settings_api_keys_loading()}</span>
												</div>
											</Table.Cell>
										</Table.Row>
									{:else if apiKeys.length === 0}
										<Table.Row>
											<Table.Cell colspan={7} class="h-24 text-center text-muted-foreground">
												{m.settings_api_keys_empty()}
											</Table.Cell>
										</Table.Row>
									{:else}
										{#each apiKeys as key (key.id)}
											{@const isRevoking = revokeKeyPending[key.id] ?? false}
											{@const isRevoked = Boolean(key.revokedAt)}
											{@const isExpiredKey = isApiKeyExpired(key)}
											<Table.Row>
												<Table.Cell class="text-xs font-medium">
													<div class="flex items-center gap-1.5">
														<IconKey class="size-3.5 shrink-0 text-muted-foreground" />
														<span class="max-w-[120px] truncate sm:max-w-[160px]">{key.name}</span>
													</div>
												</Table.Cell>
												<Table.Cell class="font-mono text-xs text-muted-foreground">
													{key.keyPrefix}…
												</Table.Cell>
												<Table.Cell class="hidden sm:table-cell">
													<div class="flex flex-wrap gap-1">
														{#each key.scopes as scope (scope)}
															<Badge variant="outline" class="font-mono text-[10px]">{scope}</Badge>
														{/each}
													</div>
												</Table.Cell>
												<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
													{new Date(key.createdAt).toLocaleDateString(getLocale())}
												</Table.Cell>
												<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
													{new Date(key.expiresAt).toLocaleDateString(getLocale())}
												</Table.Cell>
												<Table.Cell>
													{#if isRevoked}
														<Badge variant="destructive"
															>{m.settings_api_keys_status_revoked()}</Badge
														>
													{:else if isExpiredKey}
														<Badge variant="outline">{m.settings_api_keys_status_expired()}</Badge>
													{:else}
														<Badge variant="outline">{m.settings_api_keys_status_active()}</Badge>
													{/if}
												</Table.Cell>
												<Table.Cell class="text-right">
													{#if !isRevoked}
														<Button
															variant="destructive"
															size="xs"
															onclick={() => handleRevokeApiKey(key.id)}
															disabled={isRevoking}
														>
															{#if isRevoking}
																<Spinner class="size-3" />
															{:else}
																{m.settings_api_keys_action_revoke()}
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

						{#if apiKeysNextCursor}
							<div class="mt-4 flex justify-center">
								<Button
									variant="outline"
									size="sm"
									onclick={() => loadApiKeys(apiKeysNextCursor)}
									disabled={apiKeysLoading}
								>
									{#if apiKeysLoading}
										<Spinner class="size-4" />
									{/if}
									{m.settings_api_keys_load_more()}
								</Button>
							</div>
						{/if}
					</Card.Content>
				</Card.Root>
			</Tabs.Content>
		</Tabs.Root>
	{/if}
</div>
