<script lang="ts">
	import {
		IconAddressBook,
		IconAlertTriangle,
		IconArrowLeft,
		IconEdit,
		IconPlus,
		IconTrash
	} from '@tabler/icons-svelte';
	import {
		ContactsApiError,
		createContactMutationAttempt,
		createContactsClient,
		type Contact,
		type ContactLocale
	} from '$lib/client/contacts';
	import * as Alert from '$lib/components/ui/alert';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Empty from '$lib/components/ui/empty';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Table from '$lib/components/ui/table';
	import * as m from '$lib/paraglide/messages';

	let { open = $bindable(false) }: { open?: boolean } = $props();
	const client = createContactsClient();
	const saveAttempt = createContactMutationAttempt();
	const deleteAttempt = createContactMutationAttempt();

	let contacts = $state<readonly Contact[]>([]);
	let nextCursor = $state<string | null>(null);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let view = $state<'list' | 'form'>('list');
	let editing = $state<Contact | null>(null);
	let name = $state('');
	let email = $state('');
	let locale = $state<ContactLocale>('en');
	let savePending = $state(false);
	let saveError = $state<string | null>(null);
	let deleteTarget = $state<Contact | null>(null);
	let deletePending = $state(false);
	let deleteError = $state<string | null>(null);
	let loadedForOpen = false;
	let listRequestSequence = 0;

	const mutationLocked = $derived(savePending || deletePending);
	const closeLocked = $derived(mutationLocked || deleteTarget !== null);
	const dismissLocked = $derived(closeLocked || view === 'form');

	function resetForm(): void {
		saveAttempt.invalidate();
		editing = null;
		name = '';
		email = '';
		locale = 'en';
		saveError = null;
	}

	function markFormChanged(): void {
		saveAttempt.invalidate();
		saveError = null;
	}

	function returnToList(): void {
		if (mutationLocked) return;
		resetForm();
		view = 'list';
	}

	function openCreate(): void {
		if (mutationLocked) return;
		resetForm();
		view = 'form';
	}

	function editContact(contact: Contact): void {
		if (mutationLocked) return;
		saveAttempt.invalidate();
		editing = contact;
		name = contact.name;
		email = contact.email;
		locale = contact.locale;
		saveError = null;
		view = 'form';
	}

	function chooseDeleteContact(contact: Contact): void {
		if (mutationLocked) return;
		deleteAttempt.invalidate();
		deleteError = null;
		deleteTarget = contact;
	}

	function closeDeleteDialog(): void {
		if (deletePending) return;
		deleteAttempt.invalidate();
		deleteError = null;
		deleteTarget = null;
	}

	function handleManagementOpenChange(nextOpen: boolean): void {
		if (nextOpen) {
			open = true;
			return;
		}
		if (mutationLocked) return;
		open = false;
		view = 'list';
		resetForm();
		closeDeleteDialog();
	}

	function guardDismiss(event: Event): void {
		if (!dismissLocked) return;
		event.preventDefault();
	}

	async function loadContacts(cursor?: string): Promise<void> {
		const sequence: number = ++listRequestSequence;
		loading = true;
		loadError = null;
		try {
			const page = await client.list({ ...(cursor ? { cursor } : {}), limit: 25 });
			if (sequence !== listRequestSequence) return;
			contacts = cursor ? [...contacts, ...page.items] : page.items;
			nextCursor = page.nextCursor;
		} catch (cause) {
			if (sequence !== listRequestSequence) return;
			loadError = cause instanceof Error ? cause.message : m.contacts_load_unavailable();
		} finally {
			if (sequence === listRequestSequence) loading = false;
		}
	}

	async function saveContact(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (savePending || name.trim().length === 0 || email.trim().length === 0) return;
		savePending = true;
		saveError = null;
		const idempotencyKey: string = saveAttempt.key();
		try {
			const input = { name: name.trim(), email: email.trim(), locale };
			if (editing === null) {
				await client.create(input, { idempotencyKey });
			} else {
				await client.update(
					editing.id,
					{ ...input, expectedVersion: editing.version },
					{ idempotencyKey }
				);
			}
			saveAttempt.succeeded();
			editing = null;
			name = '';
			email = '';
			locale = 'en';
			saveError = null;
			view = 'list';
			await loadContacts();
		} catch (cause) {
			saveAttempt.failed(cause);
			saveError = cause instanceof ContactsApiError ? cause.detail : m.contacts_save_unavailable();
		} finally {
			savePending = false;
		}
	}

	async function deleteContact(): Promise<void> {
		if (deleteTarget === null || deletePending) return;
		deletePending = true;
		deleteError = null;
		const idempotencyKey: string = deleteAttempt.key();
		try {
			await client.delete(deleteTarget.id, deleteTarget.version, { idempotencyKey });
			deleteAttempt.succeeded();
			if (editing?.id === deleteTarget.id) {
				resetForm();
				view = 'list';
			}
			deleteTarget = null;
			await loadContacts();
		} catch (cause) {
			deleteAttempt.failed(cause);
			deleteError =
				cause instanceof ContactsApiError ? cause.detail : m.contacts_delete_unavailable();
		} finally {
			deletePending = false;
		}
	}

	$effect(() => {
		if (open && !loadedForOpen) {
			loadedForOpen = true;
			void loadContacts();
		}
		if (!open) loadedForOpen = false;
	});
</script>

<Dialog.Root bind:open={() => open, handleManagementOpenChange}>
	<Dialog.Content
		class="max-h-[calc(100svh-2rem)] overflow-y-auto"
		closeLabel={m.common_cancel()}
		showCloseButton={!dismissLocked}
		interactOutsideBehavior={dismissLocked ? 'ignore' : 'close'}
		escapeKeydownBehavior={dismissLocked ? 'ignore' : 'close'}
		onInteractOutside={guardDismiss}
		onEscapeKeydown={guardDismiss}
	>
		{#if view === 'form'}
			<Dialog.Header>
				<Dialog.Title>
					{editing === null ? m.contacts_create_title() : m.contacts_edit_title()}
				</Dialog.Title>
				<Dialog.Description>{m.contacts_manage_description()}</Dialog.Description>
			</Dialog.Header>
			<Button type="button" variant="outline" onclick={returnToList} disabled={savePending}>
				<IconArrowLeft data-icon="inline-start" />
				{m.contacts_back_to_list()}
			</Button>
			<form class="flex flex-col gap-6" onsubmit={saveContact}>
				<Field.FieldGroup>
					{#if saveError}
						<Alert.Root variant="destructive">
							<IconAlertTriangle />
							<Alert.Title>{saveError}</Alert.Title>
						</Alert.Root>
					{/if}
					<Field.Field data-disabled={savePending}>
						<Field.FieldLabel for="contact-name">{m.contacts_name_label()}</Field.FieldLabel>
						<Input
							id="contact-name"
							bind:value={name}
							maxlength={200}
							disabled={savePending}
							oninput={markFormChanged}
							required
						/>
					</Field.Field>
					<Field.Field data-disabled={savePending}>
						<Field.FieldLabel for="contact-email">{m.contacts_email_label()}</Field.FieldLabel>
						<Input
							id="contact-email"
							type="email"
							bind:value={email}
							maxlength={320}
							disabled={savePending}
							oninput={markFormChanged}
							required
						/>
					</Field.Field>
					<Field.Field data-disabled={savePending}>
						<Field.FieldLabel for="contact-locale">{m.contacts_locale_label()}</Field.FieldLabel>
						<Select.Root
							type="single"
							bind:value={locale}
							disabled={savePending}
							onValueChange={markFormChanged}
						>
							<Select.Trigger id="contact-locale" class="w-full">
								{locale === 'ja' ? '日本語' : 'English'}
							</Select.Trigger>
							<Select.Content>
								<Select.Group>
									<Select.Item value="en" label="English">English</Select.Item>
									<Select.Item value="ja" label="日本語">日本語</Select.Item>
								</Select.Group>
							</Select.Content>
						</Select.Root>
					</Field.Field>
				</Field.FieldGroup>
				<Button type="submit" disabled={savePending || !name.trim() || !email.trim()}>
					{#if savePending}<Spinner data-icon="inline-start" />{:else}<IconPlus
							data-icon="inline-start"
						/>{/if}
					{editing === null ? m.contacts_create_action() : m.contacts_update_action()}
				</Button>
			</form>
		{:else}
			<Dialog.Header>
				<Dialog.Title>{m.contacts_manage_title()}</Dialog.Title>
				<Dialog.Description>{m.contacts_manage_description()}</Dialog.Description>
			</Dialog.Header>
			<div class="flex justify-end">
				<Button type="button" onclick={openCreate} disabled={mutationLocked}>
					<IconPlus data-icon="inline-start" />
					{m.contacts_add_action()}
				</Button>
			</div>

			{#if loadError}
				<Alert.Root variant="destructive">
					<Alert.Title>{m.contacts_load_unavailable()}</Alert.Title>
					<Alert.Description>{loadError}</Alert.Description>
					<Alert.Action
						><Button variant="outline" size="sm" onclick={() => void loadContacts()}
							>{m.common_retry()}</Button
						></Alert.Action
					>
				</Alert.Root>
			{:else if loading && contacts.length === 0}
				<div class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
					<Spinner />{m.contacts_loading()}
				</div>
			{:else if contacts.length === 0}
				<Empty.Root>
					<Empty.Header>
						<Empty.Media variant="icon"><IconAddressBook /></Empty.Media>
						<Empty.Title>{m.contacts_empty_title()}</Empty.Title>
						<Empty.Description>{m.contacts_empty_description()}</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{:else}
				<div class="overflow-x-auto">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>{m.contacts_name_label()}</Table.Head>
								<Table.Head>{m.contacts_email_label()}</Table.Head>
								<Table.Head>{m.contacts_locale_label()}</Table.Head>
								<Table.Head class="sr-only">{m.contacts_actions_label()}</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each contacts as contact (contact.id)}
								<Table.Row>
									<Table.Cell>{contact.name}</Table.Cell>
									<Table.Cell>{contact.email}</Table.Cell>
									<Table.Cell>{contact.locale === 'ja' ? '日本語' : 'English'}</Table.Cell>
									<Table.Cell>
										<div class="flex justify-end gap-1">
											<Button
												size="icon"
												variant="ghost"
												aria-label={m.contacts_edit_action()}
												disabled={mutationLocked}
												onclick={() => editContact(contact)}><IconEdit /></Button
											>
											<Button
												size="icon"
												variant="ghost"
												aria-label={m.contacts_delete_action()}
												disabled={mutationLocked}
												onclick={() => chooseDeleteContact(contact)}><IconTrash /></Button
											>
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
				{#if nextCursor}
					<Button
						variant="outline"
						onclick={() => void loadContacts(nextCursor!)}
						disabled={loading || mutationLocked}
					>
						{#if loading}<Spinner data-icon="inline-start" />{/if}{m.contacts_load_more()}
					</Button>
				{/if}
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root
	open={deleteTarget !== null}
	onOpenChange={(nextOpen) => !nextOpen && closeDeleteDialog()}
>
	<AlertDialog.Content escapeKeydownBehavior={deletePending ? 'ignore' : 'close'}>
		<AlertDialog.Header>
			<AlertDialog.Title>{m.contacts_delete_title()}</AlertDialog.Title>
			<AlertDialog.Description>{m.contacts_delete_description()}</AlertDialog.Description>
		</AlertDialog.Header>
		{#if deleteError}
			<Alert.Root variant="destructive">
				<Alert.Title>{m.contacts_delete_unavailable()}</Alert.Title>
				<Alert.Description>{deleteError}</Alert.Description>
			</Alert.Root>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={deletePending}>{m.common_cancel()}</AlertDialog.Cancel>
			<AlertDialog.Action
				disabled={deletePending}
				onclick={(event) => {
					event.preventDefault();
					void deleteContact();
				}}
			>
				{#if deletePending}<Spinner data-icon="inline-start" />{/if}{m.contacts_delete_action()}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
