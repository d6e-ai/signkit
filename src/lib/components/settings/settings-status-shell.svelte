<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Spinner } from '$lib/components/ui/spinner';
	import { IconAlertTriangle, IconLock } from '@tabler/icons-svelte';
	import * as m from '$lib/paraglide/messages';
	import type { SettingsCallerContext } from './settings-caller-context.svelte';

	let {
		ctx,
		ready
	}: {
		ctx: SettingsCallerContext;
		ready: Snippet;
	} = $props();

	const signInHref = $derived(
		localizeHref(`/auth/login?return=${encodeURIComponent(page.url.pathname)}`)
	);
</script>

{#if ctx.initialLoading}
	<div
		class="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground"
		aria-live="polite"
	>
		<Spinner class="size-8" />
		<p class="text-sm font-medium">{m.nav_loading()}</p>
	</div>
{:else if ctx.authRequired}
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
{:else if ctx.globalError}
	<div
		class="flex items-center gap-3 rounded-2xl border border-destructive/20 bg-destructive/10 p-4 text-destructive"
		role="alert"
	>
		<IconAlertTriangle class="size-5 shrink-0" />
		<div class="flex-1 text-sm font-medium">{ctx.globalError}</div>
		<Button variant="outline" size="sm" onclick={() => ctx.load()}>
			{m.common_retry()}
		</Button>
	</div>
{:else}
	{@render ready()}
{/if}
