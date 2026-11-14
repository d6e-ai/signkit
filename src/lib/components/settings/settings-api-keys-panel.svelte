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
	import * as Alert from '$lib/components/ui/alert';
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Empty from '$lib/components/ui/empty';
	import * as Field from '$lib/components/ui/field';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as Table from '$lib/components/ui/table';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Spinner } from '$lib/components/ui/spinner';
	import { settingsRevealState } from './settings-reveal-state.svelte';
	import {
		IconAlertTriangle,
		IconCheck,
		IconCopy,
		IconInfoCircle,
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
	let createOpen = $state(false);
	let detailsKey = $state<ApiKeyMetadata | null>(null);
	let revokeKeyPending = $state<Record<string, boolean>>({});
	let listRequestSequence = 0;

	const EXPIRY_CLOCK_SKEW_SAFETY_BUFFER_MS = 5 * 60 * 1000;

	function errorMessage(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}

	function isApiKeyExpired(key: ApiKeyMetadata): boolean {
		return key.revokedAt === null && Date.parse(key.expiresAt) <= Date.now();
	}

	function handleCreateOpenChange(nextOpen: boolean): void {
		if (!nextOpen && keyPending) return;
		createOpen = nextOpen;
	}

	function guardCreateDismiss(event: Event): void {
		if (!keyPending) return;
		event.preventDefault();
	}

	function formatTimestamp(value: string): string {
		return new Date(value).toLocaleDateString(getLocale());
	}

	function formatDetailTimestamp(value: string): string {
		return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
			new Date(value)
		);
	}

	async function loadApiKeys(cursor?: string | null) {
		const sequence = ++listRequestSequence;
		apiKeysLoading = true;
		apiKeysError = null;
		try {
			const res = await client.listApiKeys(cursor ? { cursor } : undefined);
			if (sequence !== listRequestSequence) return;
			if (cursor) {
				apiKeys = [...apiKeys, ...res.page.items];
			} else {
				apiKeys = [...res.page.items];
			}
			apiKeysNextCursor = res.page.nextCursor;
			if (detailsKey) {
				detailsKey = apiKeys.find((key) => key.id === detailsKey?.id) ?? null;
			}
		} catch (err: unknown) {
			if (sequence !== listRequestSequence) return;
			apiKeysError = errorMessage(err);
		} finally {
			if (sequence === listRequestSequence) apiKeysLoading = false;
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
		let created = false;
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
			created = true;
		} catch (err: unknown) {
			keyCreateError = errorMessage(err);
		} finally {
			keyPending = false;
		}
		if (created) {
			createOpen = false;
			await loadApiKeys();
		}
	}

	async function handleRevokeApiKey(id: string) {
		revokeKeyPending[id] = true;
		apiKeysError = null;
		try {
			await client.revokeApiKey(id);
			await loadApiKeys();
		} catch (err: unknown) {
			apiKeysError = errorMessage(err);
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
	{#if settingsRevealState.revealedApiKey}
		<Alert.Root>
			<IconKey />
			<Alert.Title>{m.settings_api_keys_secret_reveal_title()}</Alert.Title>
			<Alert.Description>
				{m.settings_api_keys_secret_reveal_warning()}
			</Alert.Description>
			<Alert.Action>
				<Button
					variant="ghost"
					size="xs"
					onclick={() => settingsRevealState.dismissRevealedApiKey()}
					aria-label={m.settings_api_keys_dismiss()}
				>
					<IconX data-icon="inline-start" />
				</Button>
			</Alert.Action>
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
		</Alert.Root>
	{/if}

	<Card.Root>
		<Card.Header class="flex flex-wrap items-center justify-end">
			<Card.Title class="sr-only">{m.settings_api_keys_title()}</Card.Title>
			<Card.Action>
				<div class="flex items-center gap-2">
					<Button
						variant="ghost"
						size="sm"
						onclick={() => loadApiKeys()}
						disabled={apiKeysLoading}
						aria-label={m.settings_api_keys_refresh()}
					>
						<IconRefresh data-icon="inline-start" class={apiKeysLoading ? 'animate-spin' : ''} />
					</Button>
					<Button size="sm" onclick={() => (createOpen = true)}>
						<IconPlus data-icon="inline-start" />
						{m.settings_api_keys_create_title()}
					</Button>
				</div>
			</Card.Action>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if apiKeysError}
				<Alert.Root variant="destructive">
					<IconAlertTriangle />
					<Alert.Title>{apiKeysError}</Alert.Title>
					<Alert.Action>
						<Button variant="outline" size="xs" onclick={() => loadApiKeys()}>
							{m.settings_api_keys_refresh()}
						</Button>
					</Alert.Action>
				</Alert.Root>
			{/if}

			{#if apiKeysLoading && apiKeys.length === 0}
				<div class="flex items-center justify-center gap-2 py-8 text-muted-foreground">
					<Spinner class="size-4" />
					<span>{m.settings_api_keys_loading()}</span>
				</div>
			{:else if apiKeys.length === 0}
				<Empty.Root>
					<Empty.Header>
						<Empty.Media variant="icon"><IconKey /></Empty.Media>
						<Empty.Title>{m.settings_api_keys_empty()}</Empty.Title>
					</Empty.Header>
				</Empty.Root>
			{:else}
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
										{formatTimestamp(key.createdAt)}
									</Table.Cell>
									<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
										{formatTimestamp(key.expiresAt)}
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
										<div class="flex justify-end gap-1">
											<Button variant="outline" size="xs" onclick={() => (detailsKey = key)}>
												<IconInfoCircle data-icon="inline-start" />
												{m.settings_api_keys_details_action()}
											</Button>
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
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}

			{#if apiKeysNextCursor}
				<div class="flex justify-center">
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

<Dialog.Root bind:open={() => createOpen, handleCreateOpenChange}>
	<Dialog.Content
		class="sm:max-w-lg"
		showCloseButton={!keyPending}
		closeLabel={m.common_cancel()}
		interactOutsideBehavior={keyPending ? 'ignore' : 'close'}
		escapeKeydownBehavior={keyPending ? 'ignore' : 'close'}
		onInteractOutside={guardCreateDismiss}
		onEscapeKeydown={guardCreateDismiss}
	>
		<Dialog.Header>
			<Dialog.Title>{m.settings_api_keys_create_title()}</Dialog.Title>
			<Dialog.Description>{m.settings_api_keys_description()}</Dialog.Description>
		</Dialog.Header>
		<form class="flex flex-col gap-6" onsubmit={handleCreateApiKey}>
			<Field.FieldGroup>
				{#if keyCreateError}
					<Alert.Root variant="destructive">
						<IconAlertTriangle />
						<Alert.Title>{keyCreateError}</Alert.Title>
					</Alert.Root>
				{/if}
				<Field.Field data-disabled={keyPending}>
					<Field.FieldLabel for="key-name">
						{m.settings_api_keys_name_label()}
					</Field.FieldLabel>
					<Input
						id="key-name"
						type="text"
						placeholder={m.settings_api_keys_name_placeholder()}
						bind:value={newKeyName}
						disabled={keyPending}
						required
					/>
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
				<Field.FieldSet data-disabled={keyPending}>
					<Field.FieldLegend variant="label">
						{m.settings_api_keys_scopes_label()}
					</Field.FieldLegend>
					<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
			</Field.FieldGroup>
			<Dialog.Footer>
				<Button
					type="button"
					variant="outline"
					disabled={keyPending}
					onclick={() => handleCreateOpenChange(false)}
				>
					{m.common_cancel()}
				</Button>
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
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Sheet.Root
	open={detailsKey !== null}
	onOpenChange={(nextOpen) => {
		if (!nextOpen) detailsKey = null;
	}}
>
	{#if detailsKey}
		{@const isRevoked = Boolean(detailsKey.revokedAt)}
		{@const isExpiredKey = isApiKeyExpired(detailsKey)}
		<Sheet.Content class="overflow-y-auto pb-6">
			<Sheet.Header>
				<Sheet.Title>{m.settings_api_keys_details_title()}</Sheet.Title>
				<Sheet.Description>{m.settings_api_keys_details_description()}</Sheet.Description>
			</Sheet.Header>
			<div class="flex flex-col gap-4 px-6">
				<div class="flex flex-col gap-1">
					<p class="text-muted-foreground">{m.settings_api_keys_col_name()}</p>
					<p class="[overflow-wrap:anywhere]">{detailsKey.name}</p>
				</div>
				<div class="flex flex-col gap-1">
					<p class="text-muted-foreground">{m.settings_api_keys_col_id()}</p>
					<p class="font-mono text-xs break-all">{detailsKey.id}</p>
				</div>
				<div class="flex flex-col gap-1">
					<p class="text-muted-foreground">{m.settings_api_keys_col_prefix()}</p>
					<p class="font-mono text-xs">{detailsKey.keyPrefix}…</p>
				</div>
				<div class="flex flex-col gap-1">
					<p class="text-muted-foreground">{m.settings_api_keys_col_scopes()}</p>
					<div class="flex flex-wrap gap-1">
						{#each detailsKey.scopes as scope (scope)}
							<Badge variant="outline"><code>{scope}</code></Badge>
						{/each}
					</div>
				</div>
				<div class="flex flex-col gap-1">
					<p class="text-muted-foreground">{m.settings_api_keys_col_created()}</p>
					<time datetime={detailsKey.createdAt}>{formatDetailTimestamp(detailsKey.createdAt)}</time>
				</div>
				<div class="flex flex-col gap-1">
					<p class="text-muted-foreground">{m.settings_api_keys_col_expires()}</p>
					<time datetime={detailsKey.expiresAt}>{formatDetailTimestamp(detailsKey.expiresAt)}</time>
				</div>
				<div class="flex flex-col gap-1">
					<p class="text-muted-foreground">{m.settings_api_keys_col_last_used()}</p>
					{#if detailsKey.lastUsedAt}
						<time datetime={detailsKey.lastUsedAt}
							>{formatDetailTimestamp(detailsKey.lastUsedAt)}</time
						>
					{:else}<p>{m.settings_api_keys_never_used()}</p>{/if}
				</div>
				<div class="flex flex-col gap-1">
					<p class="text-muted-foreground">{m.settings_api_keys_col_status()}</p>
					{#if isRevoked}
						<Badge variant="destructive">{m.settings_api_keys_status_revoked()}</Badge>
					{:else if isExpiredKey}
						<Badge variant="outline">{m.settings_api_keys_status_expired()}</Badge>
					{:else}
						<Badge variant="outline">{m.settings_api_keys_status_active()}</Badge>
					{/if}
				</div>
			</div>
		</Sheet.Content>
	{/if}
</Sheet.Root>
