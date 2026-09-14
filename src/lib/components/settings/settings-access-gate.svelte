<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as m from '$lib/paraglide/messages';
	import type { InstanceMemberMetadata } from '$lib/client/instance-management';
	import { createSettingsCallerContext } from './settings-caller-context.svelte';
	import SettingsStatusShell from './settings-status-shell.svelte';

	let {
		require,
		children
	}: {
		require: 'owner-or-admin' | 'any';
		children: Snippet<
			[
				{
					member: InstanceMemberMetadata;
					isOwnerOrAdmin: boolean;
					isCallerOwner: boolean;
					isCallerAdmin: boolean;
					reload: () => Promise<void>;
				}
			]
		>;
	} = $props();

	const ctx = createSettingsCallerContext();
	onMount(() => {
		void ctx.load();
	});

	const currentMember = $derived(ctx.callerContext?.member ?? null);
	const isActiveMember = $derived(currentMember?.status === 'active');
	const isOwnerOrAdmin = $derived(
		isActiveMember && (currentMember?.role === 'owner' || currentMember?.role === 'admin')
	);
	const isCallerOwner = $derived(currentMember?.role === 'owner');
	const isCallerAdmin = $derived(currentMember?.role === 'admin');
	// API keys are scoped to the caller's own account, so any active member may
	// reach that route; members/invitations administration stays owner/admin-only.
	const authorized = $derived(isActiveMember && (require === 'any' || isOwnerOrAdmin));

	// A caller who cannot use this route -- not an active member, or an active
	// plain member on an owner/admin-only route -- is bounced to `/settings`,
	// which is the one page that already knows how to route a non-member to the
	// invitation-accept card, a suspended member to the restricted-access card,
	// and an active member to their own authorized destination.
	$effect(() => {
		if (ctx.initialLoading || ctx.authRequired || ctx.globalError) return;
		if (!authorized) {
			void goto(localizeHref('/settings'));
		}
	});
</script>

<SettingsStatusShell {ctx}>
	{#snippet ready()}
		{#if authorized && currentMember}
			{@render children({
				member: currentMember,
				isOwnerOrAdmin,
				isCallerOwner,
				isCallerAdmin,
				reload: () => ctx.load()
			})}
		{:else}
			<div
				class="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground"
				aria-live="polite"
			>
				<Spinner class="size-8" />
				<p class="text-sm font-medium">{m.nav_loading()}</p>
			</div>
		{/if}
	{/snippet}
</SettingsStatusShell>
