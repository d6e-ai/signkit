<script lang="ts">
	import { onMount } from 'svelte';
	import {
		createInstanceManagementClient,
		InstanceManagementApiError
	} from '$lib/client/instance-management';
	import * as m from '$lib/paraglide/messages';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Spinner } from '$lib/components/ui/spinner';
	import { IconShield } from '@tabler/icons-svelte';

	const client = createInstanceManagementClient();

	let checking = $state(true);
	let claimPending = $state(false);
	let claimError = $state<string | null>(null);

	async function checkState(): Promise<void> {
		checking = true;
		try {
			const context = await client.getCurrentMember();
			// The root layout guard already keeps an authenticated caller off this
			// page once the instance is bootstrapped; this only catches the race
			// where someone else claimed ownership between that check and this
			// page finishing its own mount. A full navigation (rather than
			// client-side goto) forces a fresh server round-trip through that same
			// guard, which is what decides where this caller belongs next.
			if (context.bootstrapped) {
				window.location.href = localizeHref('/');
				return;
			}
		} catch {
			// Fall through: the claim action below will surface any real failure.
		} finally {
			checking = false;
		}
	}

	async function handleClaim(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		claimPending = true;
		claimError = null;
		try {
			await client.bootstrapOwner();
			window.location.href = localizeHref('/');
		} catch (err: unknown) {
			if (err instanceof InstanceManagementApiError && err.status === 409) {
				// Someone else claimed ownership first: route through the normal
				// access gate instead of leaving a stale claim form on screen.
				window.location.href = localizeHref('/');
				return;
			}
			claimError = err instanceof Error ? err.message : String(err);
		} finally {
			claimPending = false;
		}
	}

	onMount(() => {
		void checkState();
	});
</script>

<svelte:head>
	<title>{m.setup_title()} — {m.app_name()}</title>
</svelte:head>

<div class="mx-auto flex min-h-[60vh] max-w-lg items-center">
	<Card.Root class="w-full">
		<Card.Header>
			<div
				class="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"
			>
				<IconShield class="size-5" />
			</div>
			<Card.Title>{m.setup_title()}</Card.Title>
			<Card.Description>{m.setup_description()}</Card.Description>
		</Card.Header>
		<Card.Content>
			{#if checking}
				<div class="flex items-center gap-2 text-sm text-muted-foreground">
					<Spinner />
					<span>{m.setup_checking()}</span>
				</div>
			{:else}
				<form onsubmit={handleClaim} class="flex flex-col gap-4">
					{#if claimError}
						<p class="text-xs font-medium text-destructive" role="alert">{claimError}</p>
					{/if}
					<Button type="submit" class="w-full" disabled={claimPending}>
						{#if claimPending}
							<Spinner data-icon="inline-start" />
							<span>{m.setup_pending()}</span>
						{:else}
							<span>{m.setup_action()}</span>
						{/if}
					</Button>
				</form>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
