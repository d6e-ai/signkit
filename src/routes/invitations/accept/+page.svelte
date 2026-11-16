<script lang="ts">
	import { onMount } from 'svelte';
	import { goto, invalidateAll, afterNavigate } from '$app/navigation';
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
	function captureLink() {
		const nextToken = readInvitationLink(window);
		initialized = true;
		if (nextToken === invitationToken) return;
		invitationToken = nextToken;
		accountChanged = false;
		if (nextToken) void ctx.load();
	}
	onMount(() => {
		captureLink();
		window.addEventListener('hashchange', captureLink);
		return () => window.removeEventListener('hashchange', captureLink);
	});
	afterNavigate(() => {
		if (initialized && window.location.hash) captureLink();
	});
	async function onAccepted(token: string) {
		if (invitationToken !== token) return;
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
	<meta name="referrer" content="same-origin" />
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
					{#key token}<SettingsAcceptInvitationCard
							invitationToken={token}
							account={data.signedInAccount}
							onAccepted={() => onAccepted(token)}
							onAuthenticationRequired={() =>
								invitationToken === token ? refreshAccount() : undefined}
							onAccountChanged={() => (invitationToken === token ? onAccountChanged() : undefined)}
						/>{/key}
				{/snippet}
			</SettingsStatusShell>
		{:else}
			<SettingsInvitationRequiredCard reopenEmail />
		{/if}
	</div>
</div>
