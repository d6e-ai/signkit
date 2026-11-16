<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import * as m from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { Spinner } from '$lib/components/ui/spinner';
	import SettingsInvitationNotice from '$lib/components/settings/settings-invitation-notice.svelte';
	import type { PageProps } from './$types';
	import { clearInvitationLink, readInvitationLink } from '$lib/client/invitation-link';
	import SettingsAcceptInvitationCard from '$lib/components/settings/settings-accept-invitation-card.svelte';
	import SettingsInvitationRequiredCard from '$lib/components/settings/settings-invitation-required-card.svelte';
	import SettingsStatusShell from '$lib/components/settings/settings-status-shell.svelte';
	import { createSettingsCallerContext } from '$lib/components/settings/settings-caller-context.svelte';
	let { data }: Pick<PageProps, 'data'> = $props();
	const authResult = $derived(page.url.searchParams.get('auth'));
	const signInHref = $derived(
		localizeHref(
			`/auth/login?prompt=select_account&return=${encodeURIComponent(page.url.pathname)}`
		)
	);

	const ctx = createSettingsCallerContext();
	let invitationToken = $state<string | null>(null);
	let initialized = $state(false);
	let accountChanged = $state(false);
	onMount(() => {
		invitationToken = readInvitationLink(window);
		initialized = true;
		if (invitationToken) void ctx.load();
	});
	async function onAccepted() {
		clearInvitationLink(window);
		await goto(localizeHref('/settings'), { invalidateAll: true, replaceState: true });
	}
	async function refreshAccount() {
		await invalidateAll();
		await ctx.load();
	}
	async function onAccountChanged() {
		accountChanged = true;
		await refreshAccount();
	}
</script>

<svelte:head>
	<title>{m.settings_invitation_accept_title()} — {m.app_name()}</title>
	<meta name="referrer" content="no-referrer" />
	<meta name="robots" content="noindex,nofollow,noarchive" />
</svelte:head>

<div class="flex min-h-[70svh] items-center justify-center p-4">
	<div class="flex w-full flex-col gap-4">
		{#if accountChanged || authResult === 'cancelled' || authResult === 'failed' || authResult === 'same-account'}
			<SettingsInvitationNotice
				message={accountChanged
					? m.settings_invitation_account_changed()
					: authResult === 'same-account'
						? m.settings_invitation_same_account()
						: m.settings_invitation_login_incomplete()}
			/>
		{/if}
		{#if !initialized}
			<p class="flex items-center gap-2" role="status">
				<Spinner aria-hidden="true" />{m.nav_loading()}
			</p>
		{:else if invitationToken}
			{@const token = invitationToken}
			<SettingsStatusShell {ctx} {signInHref}>
				{#snippet ready()}
					<SettingsAcceptInvitationCard
						invitationToken={token}
						account={data.signedInAccount}
						{onAccepted}
						onAuthenticationRequired={refreshAccount}
						{onAccountChanged}
					/>
				{/snippet}
			</SettingsStatusShell>
		{:else}
			<SettingsInvitationRequiredCard reopenEmail />
		{/if}
	</div>
</div>
