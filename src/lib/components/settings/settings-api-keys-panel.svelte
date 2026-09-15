<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		createInstanceManagementClient,
		type ApiKeyMetadata,
		type ApiKeyScope
	} from '$lib/client/instance-management';
	import {
		API_KEY_DEFAULT_EXPIRY_DAYS,
		API_KEY_MAX_EXPIRY_DAYS,
		API_KEY_SCOPES
	} from '$lib/security/api-key';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import * as Table from '$lib/components/ui/table';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Spinner } from '$lib/components/ui/spinner';
	import { settingsRevealState } from './settings-reveal-state.svelte';
	import {
		IconAlertTriangle,
		IconCheck,
		IconCopy,
		IconKey,
		IconPlus,
		IconRefresh,
		IconX
	} from '@tabler/icons-svelte';

	const client = createInstanceManagementClient();

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
	let revokeKeyPending = $state<Record<string, boolean>>({});

	const EXPIRY_CLOCK_SKEW_SAFETY_BUFFER_MS = 5 * 60 * 1000;

	function isApiKeyExpired(key: ApiKeyMetadata): boolean {
		return key.revokedAt === null && Date.parse(key.expiresAt) <= Date.now();
	}

	async function loadApiKeys(cursor?: string | null) {
		apiKeysLoading = true;
		apiKeysError = null;
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
			// Same one-time discipline as the invitation token: only a response
			// carrying a fresh secret may displace the previous reveal.
			if (secret) {
				settingsRevealState.setRevealedApiKey({
					secret,
					keyId: res.apiKey.id,
					keyName: res.apiKey.name
				});
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

	onMount(() => {
		void loadApiKeys();
	});

	onDestroy(() => {
		settingsRevealState.teardownApiKeysPanel();
	});
</script>

<div class="flex flex-col gap-6">
	<!-- Create API Key Form -->
	<Card.Root>
		<Card.Header>
			<Card.Title>{m.settings_api_keys_create_title()}</Card.Title>
		</Card.Header>
		<Card.Content>
			<form onsubmit={handleCreateApiKey}>
				<Field.FieldGroup>
					<div class="grid gap-4 sm:grid-cols-2">
						<Field.Field data-invalid={keyCreateError !== null} data-disabled={keyPending}>
							<Field.FieldLabel for="key-name">
								{m.settings_api_keys_name_label()}
							</Field.FieldLabel>
							<Input
								id="key-name"
								type="text"
								placeholder={m.settings_api_keys_name_placeholder()}
								bind:value={newKeyName}
								disabled={keyPending}
								aria-invalid={keyCreateError !== null}
								required
							/>
							<!-- The create failure isn't provably scoped to one input (it
							     could be the name, the scopes, or a server-side rejection),
							     but the name field is the one most often at fault and the one
							     with a visible invalid state, so the message is associated
							     here rather than floating unassociated at the form level. -->
							{#if keyCreateError}
								<Field.FieldError>{keyCreateError}</Field.FieldError>
							{/if}
						</Field.Field>
						<Field.Field data-disabled={keyPending}>
							<Field.FieldLabel for="key-expiry">
								{m.settings_api_keys_expiry_label()}
							</Field.FieldLabel>
							<Input
								id="key-expiry"
								type="number"
								min="1"
								max={API_KEY_MAX_EXPIRY_DAYS}
								placeholder={m.settings_api_keys_expiry_placeholder()}
								bind:value={keyExpiryDays}
								disabled={keyPending}
							/>
						</Field.Field>
					</div>

					<Field.FieldSet data-disabled={keyPending}>
						<Field.FieldLegend variant="label">
							{m.settings_api_keys_scopes_label()}
						</Field.FieldLegend>
						<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
							{#each API_KEY_SCOPES as scope (scope)}
								<Field.Field
									orientation="horizontal"
									class="rounded-xl border border-border p-2.5 hover:bg-muted/50"
								>
									<Checkbox
										id="scope-{scope}"
										bind:checked={selectedScopes[scope]}
										disabled={keyPending}
									/>
									<Field.FieldLabel for="scope-{scope}" class="cursor-pointer font-mono text-xs">
										<span class="truncate">{scope}</span>
									</Field.FieldLabel>
								</Field.Field>
							{/each}
						</div>
					</Field.FieldSet>

					<Button
						type="submit"
						disabled={keyPending ||
							!newKeyName.trim() ||
							Object.values(selectedScopes).every((v) => !v)}
					>
						{#if keyPending}
							<Spinner data-icon="inline-start" />
							<span>{m.settings_api_keys_create_pending()}</span>
						{:else}
							<IconPlus data-icon="inline-start" />
							<span>{m.settings_api_keys_create_action()}</span>
						{/if}
					</Button>
				</Field.FieldGroup>
			</form>
		</Card.Content>
	</Card.Root>

	<!-- One-Time API Key Reveal Warning Banner -->
	{#if settingsRevealState.revealedApiKey}
		<div class="rounded-2xl border-2 border-primary bg-primary/5 p-4 shadow-xs sm:p-5" role="alert">
			<div class="flex items-start justify-between gap-3">
				<div class="flex items-center gap-2 text-primary">
					<IconKey class="size-5 shrink-0" />
					<h2 class="text-base font-semibold">{m.settings_api_keys_secret_reveal_title()}</h2>
				</div>
				<Button
					variant="ghost"
					size="xs"
					onclick={() => settingsRevealState.dismissRevealedApiKey()}
					aria-label={m.settings_api_keys_dismiss()}
				>
					<IconX data-icon="inline-start" />
				</Button>
			</div>
			<p class="mt-1 text-xs text-muted-foreground">
				{m.settings_api_keys_secret_reveal_warning()}
			</p>
			<p class="mt-1 text-xs font-medium text-foreground">
				{m.settings_api_keys_secret_reveal_metadata({
					name: settingsRevealState.revealedApiKey.keyName,
					keyId: settingsRevealState.revealedApiKey.keyId
				})}
			</p>
			<div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
				<div
					class="flex-1 rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs break-all select-all"
				>
					{settingsRevealState.revealedApiKey.secret}
				</div>
				<Button
					variant="default"
					size="sm"
					class="shrink-0"
					onclick={() =>
						settingsRevealState.copyApiKeySecret(settingsRevealState.revealedApiKey!.secret)}
				>
					{#if settingsRevealState.apiKeyCopied}
						<IconCheck data-icon="inline-start" />
						<span>{m.settings_api_keys_secret_copied()}</span>
					{:else}
						<IconCopy data-icon="inline-start" />
						<span>{m.settings_api_keys_copy_secret()}</span>
					{/if}
				</Button>
			</div>
			{#if settingsRevealState.apiKeyCopyError}
				<p class="mt-2 text-xs font-medium text-destructive" role="alert">
					{settingsRevealState.apiKeyCopyError}
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
				<IconRefresh data-icon="inline-start" class={apiKeysLoading ? 'animate-spin' : ''} />
			</Button>
		</Card.Header>
		<Card.Content>
			<div
				class="mb-4 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
				role="note"
				aria-label={m.settings_api_keys_grant_durability_title()}
			>
				<IconAlertTriangle class="size-5 shrink-0" />
				<div class="flex flex-col gap-1">
					<p class="text-sm font-semibold">{m.settings_api_keys_grant_durability_title()}</p>
					<p class="text-xs">{m.settings_api_keys_grant_durability_warning()}</p>
				</div>
			</div>
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
											<Badge variant="destructive">{m.settings_api_keys_status_revoked()}</Badge>
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
													<Spinner data-icon="inline-start" class="size-3" />
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
							<Spinner data-icon="inline-start" />
						{/if}
						{m.settings_api_keys_load_more()}
					</Button>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
