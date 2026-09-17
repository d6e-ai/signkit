<script lang="ts">
	import { tick } from 'svelte';
	import { IconAddressBook, IconSelector } from '@tabler/icons-svelte';
	import { createContactsClient, type Contact } from '$lib/client/contacts';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import * as Command from '$lib/components/ui/command';
	import * as Popover from '$lib/components/ui/popover';
	import * as m from '$lib/paraglide/messages';

	let {
		label,
		onSelect
	}: {
		label: string;
		onSelect: (contact: Contact) => void;
	} = $props();

	const client = createContactsClient();
	let open = $state(false);
	let query = $state('');
	let contacts = $state<readonly Contact[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let triggerRef = $state<HTMLButtonElement>(null!);
	let requestSequence = 0;

	async function loadContacts(searchText: string): Promise<void> {
		const sequence: number = ++requestSequence;
		loading = true;
		error = null;
		try {
			const normalizedQuery: string = searchText.trim();
			const page =
				normalizedQuery.length > 0
					? await client.search({ query: normalizedQuery, limit: 25 })
					: await client.list({ limit: 25 });
			if (sequence !== requestSequence) return;
			contacts = page.items;
		} catch (cause) {
			if (sequence !== requestSequence) return;
			contacts = [];
			error = cause instanceof Error ? cause.message : m.contacts_load_unavailable();
		} finally {
			if (sequence === requestSequence) loading = false;
		}
	}

	function selectContact(contact: Contact): void {
		onSelect(contact);
		open = false;
		query = '';
		void tick().then(() => triggerRef.focus());
	}

	$effect(() => {
		if (!open) return;
		const searchText: string = query;
		const timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
			void loadContacts(searchText);
		}, 200);
		return () => clearTimeout(timeout);
	});
</script>

<Popover.Root bind:open>
	<Popover.Trigger bind:ref={triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="outline"
				size="sm"
				role="combobox"
				aria-label={label}
				aria-expanded={open}
			>
				<IconAddressBook data-icon="inline-start" />
				{label}
				<IconSelector data-icon="inline-end" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 p-0" align="start">
		<Command.Root shouldFilter={false}>
			<Command.Input
				bind:value={query}
				maxlength={200}
				placeholder={m.contacts_search_placeholder()}
				aria-label={m.contacts_search_label()}
			/>
			<Command.List aria-busy={loading}>
				{#if error}
					<Alert.Root variant="destructive" class="m-2">
						<Alert.Title>{m.contacts_load_unavailable()}</Alert.Title>
						<Alert.Description>{error}</Alert.Description>
					</Alert.Root>
				{:else if loading}
					<Command.Loading class="p-4 text-sm text-muted-foreground">
						{m.contacts_loading()}
					</Command.Loading>
				{:else}
					<Command.Empty>{m.contacts_search_empty()}</Command.Empty>
					<Command.Group heading={m.contacts_search_results()}>
						{#each contacts as contact (contact.id)}
							<Command.Item value={contact.id} onSelect={() => selectContact(contact)}>
								<span class="min-w-0">
									<span class="block truncate">{contact.name}</span>
									<span class="block truncate text-xs text-muted-foreground">
										{contact.email} · {contact.locale === 'ja' ? '日本語' : 'English'}
									</span>
								</span>
							</Command.Item>
						{/each}
					</Command.Group>
				{/if}
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
