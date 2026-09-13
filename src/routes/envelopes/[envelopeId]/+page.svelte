<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import IconSend from '@tabler/icons-svelte/icons/send';
	import IconBan from '@tabler/icons-svelte/icons/ban';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Tabs from '$lib/components/ui/tabs';
	import * as Table from '$lib/components/ui/table';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import {
		createEnvelopesClient,
		EnvelopesApiError,
		type DraftWorkspaceResponse,
		type Envelope,
		type FieldGeometry,
		type FieldType,
		type PublicEnvelopeDeliveryStatus,
		type PublicEnvelopeFieldResponse,
		type ReadyRecipientInput,
		type ReadyRecipientPublic,
		type RecipientRole,
		type VoidableEnvelopeStatus
	} from '$lib/client/envelopes';
	import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
	import type { RecipientMarkdownNode } from '$lib/security/recipient-markdown';
	import * as m from '$lib/paraglide/messages';
	import { getLocale, localizeHref } from '$lib/paraglide/runtime';

	const client = createEnvelopesClient();
	const envelopeId = $derived(page.params.envelopeId as string);
	const RECIPIENTS_CACHE_PREFIX = 'signkit:envelope-recipients:';

	let loading = $state(true);
	let authRequired = $state(false);
	let loadError = $state<string | null>(null);
	let envelope = $state<Envelope | null>(null);
	let draft = $state<DraftWorkspaceResponse | null>(null);
	let delivery = $state<PublicEnvelopeDeliveryStatus | null>(null);

	// Documents editor state.
	let editedContent = $state<Record<string, string>>({});
	const dirtyPaths = new SvelteSet<string>();
	let activeDocPath = $state<string | null>(null);
	let newDocumentName = $state('');
	let commitPending = $state(false);
	let commitError = $state<string | null>(null);
	let previewMode = $state<'formatted' | 'source'>('formatted');

	// Recipients / ready state.
	interface RecipientDraft {
		key: string;
		email: string;
		name: string;
		role: RecipientRole;
		locale: 'en' | 'ja';
		routingOrder: number;
	}
	let recipientDrafts = $state<RecipientDraft[]>([]);
	let readyPending = $state(false);
	let readyError = $state<string | null>(null);
	let readyRecipients = $state<readonly ReadyRecipientPublic[]>([]);

	// Field placement state.
	interface FieldDraft {
		key: string;
		recipientId: string;
		documentPath: string;
		fieldType: FieldType;
		label: string;
		required: boolean;
		position: number;
		geometry: FieldGeometry | null;
	}
	let fieldDrafts = $state<FieldDraft[]>([]);
	let placementPending = $state(false);
	let placementError = $state<string | null>(null);
	let placedFields = $state<readonly PublicEnvelopeFieldResponse[]>([]);
	let newField = $state<{
		recipientId: string;
		documentPath: string;
		fieldType: FieldType;
		label: string;
		required: boolean;
		page: number;
		x: number;
		y: number;
		width: number;
		height: number;
	}>({
		recipientId: '',
		documentPath: '',
		fieldType: 'signature',
		label: '',
		required: true,
		page: 1,
		x: 0.1,
		y: 0.1,
		width: 0.25,
		height: 0.06
	});

	let sendPending = $state(false);
	let sendError = $state<string | null>(null);
	let voidPending = $state(false);
	let voidError = $state<string | null>(null);
	let sendDialogOpen = $state(false);
	let voidDialogOpen = $state(false);

	const signInHref = $derived(
		localizeHref(`/auth/login?return=${encodeURIComponent(page.url.pathname)}`)
	);

	function statusLabel(status: Envelope['status']): string {
		switch (status) {
			case 'draft':
				return m.envelope_status_draft();
			case 'ready':
				return m.envelope_status_ready();
			case 'sent':
				return m.envelope_status_sent();
			case 'in_progress':
				return m.envelope_status_in_progress();
			case 'completed':
				return m.envelope_status_completed();
			case 'declined':
				return m.envelope_status_declined();
			case 'expired':
				return m.envelope_status_expired();
			case 'voided':
				return m.envelope_status_voided();
		}
	}

	function documentTitle(path: string): string {
		return path
			.replace(/^documents\//, '')
			.replace(/\.md$/, '')
			.replaceAll(/[-_]+/g, ' ');
	}

	function fieldTypeLabel(fieldType: FieldType): string {
		if (fieldType === 'signature') return m.signing_field_type_signature();
		if (fieldType === 'initials') return m.signing_field_type_initials();
		if (fieldType === 'date') return m.signing_field_type_date();
		if (fieldType === 'checkbox') return m.signing_field_type_checkbox();
		return m.signing_field_type_text();
	}

	function cacheKey(id: string): string {
		return `${RECIPIENTS_CACHE_PREFIX}${id}`;
	}

	function cacheRecipients(id: string, recipients: readonly ReadyRecipientPublic[]): void {
		try {
			sessionStorage.setItem(cacheKey(id), JSON.stringify(recipients));
		} catch {
			// Session storage may be unavailable (private browsing); the cache is
			// best-effort UX continuity, never a source of truth.
		}
	}

	function readCachedRecipients(id: string): readonly ReadyRecipientPublic[] {
		try {
			const raw = sessionStorage.getItem(cacheKey(id));
			if (!raw) return [];
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed) ? (parsed as ReadyRecipientPublic[]) : [];
		} catch {
			return [];
		}
	}

	async function load(): Promise<void> {
		loading = true;
		authRequired = false;
		loadError = null;
		try {
			const found = await client.get(envelopeId);
			envelope = found;
			readyRecipients = readCachedRecipients(envelopeId);
			if (found.status === 'draft' || found.status === 'ready') {
				const workspace = await client.getDraft(envelopeId);
				draft = workspace;
				editedContent = Object.fromEntries(
					workspace.documents.map((document) => [document.path, document.content])
				);
				dirtyPaths.clear();
				activeDocPath ??= workspace.documents[0]?.path ?? null;
			} else {
				draft = await client.getDraft(envelopeId).catch(() => null);
			}
			if (found.status !== 'draft') {
				delivery = await client.deliveries(envelopeId).catch(() => null);
			}
		} catch (cause) {
			if (cause instanceof EnvelopesApiError && cause.status === 401) {
				authRequired = true;
			} else {
				loadError =
					cause instanceof EnvelopesApiError ? cause.detail : m.envelope_detail_unavailable();
			}
		} finally {
			loading = false;
		}
	}

	function addDocument(): void {
		const name = newDocumentName
			.trim()
			.toLowerCase()
			.replaceAll(/[^a-z0-9._-]+/g, '-')
			.replace(/^-+|-+$/g, '');
		if (name.length === 0) return;
		const path = `documents/${name}.md`;
		if (path in editedContent) {
			activeDocPath = path;
			return;
		}
		editedContent = { ...editedContent, [path]: `# ${documentTitle(path)}\n\n` };
		dirtyPaths.add(path);
		activeDocPath = path;
		newDocumentName = '';
	}

	function updateContent(path: string, content: string): void {
		editedContent = { ...editedContent, [path]: content };
		dirtyPaths.add(path);
	}

	async function commitChanges(): Promise<void> {
		if (draft === null || dirtyPaths.size === 0 || commitPending) return;
		commitPending = true;
		commitError = null;
		try {
			const edits = [...dirtyPaths].sort().map((path) => ({
				path: path as `documents/${string}.md`,
				content: editedContent[path]
			}));
			const result = await client.commitDraft(envelopeId, {
				expectedGeneration: draft.generation,
				message:
					dirtyPaths.size === 1
						? m.envelope_commit_message_single()
						: m.envelope_commit_message_multiple({ count: String(dirtyPaths.size) }),
				edits
			});
			draft = {
				generation: result.revision.generation,
				commitSha: result.revision.commitSha,
				archiveSha256: result.revision.archiveSha256,
				documents: Object.entries(editedContent).map(([path, content]) => ({
					path: path as `documents/${string}.md`,
					content
				}))
			};
			dirtyPaths.clear();
		} catch (cause) {
			commitError =
				cause instanceof EnvelopesApiError ? cause.detail : m.envelope_commit_unavailable();
		} finally {
			commitPending = false;
		}
	}

	function addRecipientDraft(): void {
		recipientDrafts = [
			...recipientDrafts,
			{
				key: crypto.randomUUID(),
				email: '',
				name: '',
				role: 'signer',
				locale: getLocale() === 'ja' ? 'ja' : 'en',
				routingOrder: recipientDrafts.length + 1
			}
		];
	}

	function removeRecipientDraft(key: string): void {
		recipientDrafts = recipientDrafts.filter((draftItem) => draftItem.key !== key);
	}

	async function markReady(): Promise<void> {
		if (envelope === null || draft === null || readyPending) return;
		if (recipientDrafts.length === 0) return;
		readyPending = true;
		readyError = null;
		try {
			const recipients: ReadyRecipientInput[] = recipientDrafts.map((draftItem) => ({
				email: draftItem.email.trim(),
				name: draftItem.name.trim(),
				role: draftItem.role,
				locale: draftItem.locale,
				routingOrder: draftItem.routingOrder
			}));
			const result = await client.ready(envelopeId, {
				expectedGeneration: draft.generation,
				recipients
			});
			readyRecipients = result.ready.recipients;
			cacheRecipients(envelopeId, result.ready.recipients);
			try {
				sessionStorage.setItem(
					`signkit:envelope-ready-audit:${envelopeId}`,
					result.ready.auditEventId
				);
			} catch {
				// Best-effort cache only; send() surfaces a clear error if it is missing.
			}
			await load();
		} catch (cause) {
			readyError =
				cause instanceof EnvelopesApiError ? cause.detail : m.envelope_ready_unavailable();
		} finally {
			readyPending = false;
		}
	}

	function signerRecipients(): readonly ReadyRecipientPublic[] {
		return readyRecipients.filter((recipient) => recipient.role === 'signer');
	}

	function addFieldDraft(): void {
		if (
			newField.recipientId === '' ||
			newField.documentPath === '' ||
			newField.label.trim() === ''
		) {
			return;
		}
		fieldDrafts = [
			...fieldDrafts,
			{
				key: crypto.randomUUID(),
				recipientId: newField.recipientId,
				documentPath: newField.documentPath,
				fieldType: newField.fieldType,
				label: newField.label.trim(),
				required: newField.required,
				position: fieldDrafts.length + 1,
				geometry: {
					page: newField.page,
					x: newField.x,
					y: newField.y,
					width: newField.width,
					height: newField.height
				}
			}
		];
		newField = { ...newField, label: '' };
	}

	function removeFieldDraft(key: string): void {
		fieldDrafts = fieldDrafts
			.filter((draftItem) => draftItem.key !== key)
			.map((draftItem, index) => ({ ...draftItem, position: index + 1 }));
	}

	function setNewFieldNumber(key: 'page' | 'x' | 'y' | 'width' | 'height', raw: string): void {
		const parsed = Number(raw);
		if (!Number.isFinite(parsed)) return;
		newField = { ...newField, [key]: parsed };
	}

	function placeOnPage(event: MouseEvent & { currentTarget: HTMLButtonElement }): void {
		const rect = event.currentTarget.getBoundingClientRect();
		const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
		const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
		newField = { ...newField, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
	}

	async function publishFields(): Promise<void> {
		if (envelope === null || draft === null || fieldDrafts.length === 0 || placementPending) return;
		placementPending = true;
		placementError = null;
		try {
			const result = await client.placeFields(envelopeId, {
				expectedGeneration: draft.generation,
				expectedFieldGeneration: envelope.fieldGeneration,
				fields: fieldDrafts.map((draftItem) => ({
					recipientId: draftItem.recipientId,
					documentPath: draftItem.documentPath as `documents/${string}.md`,
					fieldType: draftItem.fieldType,
					label: draftItem.label,
					required: draftItem.required,
					position: draftItem.position,
					geometry: draftItem.geometry
				}))
			});
			placedFields = result.fields.fields;
			envelope = { ...envelope, fieldGeneration: result.fields.fieldGeneration };
			fieldDrafts = [];
		} catch (cause) {
			placementError =
				cause instanceof EnvelopesApiError ? cause.detail : m.envelope_fields_unavailable();
		} finally {
			placementPending = false;
		}
	}

	async function sendEnvelope(): Promise<void> {
		if (envelope === null || draft === null || sendPending) return;
		const readyAuditEventId = readyAuditEventFromCache();
		if (readyAuditEventId === null) {
			sendError = m.envelope_send_missing_ready_audit();
			return;
		}
		sendPending = true;
		sendError = null;
		try {
			await client.send(envelopeId, {
				expectedGeneration: draft.generation,
				expectedReadyAuditEventId: readyAuditEventId
			});
			sendDialogOpen = false;
			await load();
		} catch (cause) {
			sendError = cause instanceof EnvelopesApiError ? cause.detail : m.envelope_send_unavailable();
		} finally {
			sendPending = false;
		}
	}

	function readyAuditEventFromCache(): string | null {
		try {
			const raw = sessionStorage.getItem(`signkit:envelope-ready-audit:${envelopeId}`);
			return raw && raw.length > 0 ? raw : null;
		} catch {
			return null;
		}
	}

	async function voidEnvelopeAction(): Promise<void> {
		if (envelope === null || voidPending) return;
		voidPending = true;
		voidError = null;
		try {
			await client.voidEnvelope(envelopeId, {
				expectedStatus: envelope.status as VoidableEnvelopeStatus,
				expectedGeneration: envelope.repositoryGeneration
			});
			voidDialogOpen = false;
			await load();
		} catch (cause) {
			voidError = cause instanceof EnvelopesApiError ? cause.detail : m.envelope_void_unavailable();
		} finally {
			voidPending = false;
		}
	}

	const isVoidable = $derived(
		envelope !== null &&
			(['draft', 'ready', 'sent', 'in_progress'] as const).includes(
				envelope.status as VoidableEnvelopeStatus
			)
	);
	const preview = $derived(
		activeDocPath !== null && editedContent[activeDocPath] !== undefined
			? renderRecipientMarkdown(editedContent[activeDocPath])
			: null
	);

	onMount(() => {
		void load();
	});
</script>

{#snippet renderMarkdownNode(node: RecipientMarkdownNode)}
	{#if node.type === 'text'}
		{node.value}
	{:else if node.tag === 'br'}
		<br />
	{:else if node.tag === 'hr'}
		<hr />
	{:else}
		<svelte:element this={node.tag} {...node.attributes}>
			{#each node.children as child, childIndex (childIndex)}
				{@render renderMarkdownNode(child)}
			{/each}
		</svelte:element>
	{/if}
{/snippet}

<svelte:head>
	<title>{envelope?.title ?? m.envelope_detail_title()} — {m.app_name()}</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-6xl flex-col gap-6">
	{#if authRequired}
		<Card.Root>
			<Card.Content class="flex flex-col items-center gap-4 py-10 text-center">
				<IconAlertTriangle class="text-muted-foreground" />
				<p class="text-sm text-muted-foreground">{m.envelope_sign_in_required()}</p>
				<Button href={signInHref}>{m.sign_in()}</Button>
			</Card.Content>
		</Card.Root>
	{:else if loading}
		<Skeleton class="h-10 w-1/2" />
		<Skeleton class="h-64 w-full rounded-2xl" />
	{:else if loadError || envelope === null}
		<Card.Root class="border-destructive/30">
			<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
				<p class="text-sm font-medium text-destructive">
					{loadError ?? m.envelope_detail_unavailable()}
				</p>
				<Button variant="outline" onclick={() => void load()}>{m.common_retry()}</Button>
			</Card.Content>
		</Card.Root>
	{:else}
		<section class="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
			<div class="min-w-0">
				<h1 class="truncate text-2xl font-semibold tracking-tight">{envelope.title}</h1>
				<p class="mt-1 text-xs text-muted-foreground">
					{m.envelope_generation_label({ generation: String(envelope.repositoryGeneration) })}
				</p>
			</div>
			<Badge variant="secondary" class="w-fit">{statusLabel(envelope.status)}</Badge>
		</section>

		<Tabs.Root value="documents">
			<Tabs.List>
				<Tabs.Trigger value="documents">{m.envelope_tab_documents()}</Tabs.Trigger>
				<Tabs.Trigger value="recipients">{m.envelope_tab_recipients()}</Tabs.Trigger>
				<Tabs.Trigger value="fields">{m.envelope_tab_fields()}</Tabs.Trigger>
				<Tabs.Trigger value="send">{m.envelope_tab_send()}</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="documents" class="flex flex-col gap-4">
				{#if envelope.status === 'draft'}
					<Card.Root>
						<Card.Header class="flex-row items-center justify-between gap-3">
							<div>
								<Card.Title>{m.envelope_documents_title()}</Card.Title>
								<Card.Description>{m.envelope_documents_description()}</Card.Description>
							</div>
						</Card.Header>
						<Card.Content class="flex flex-col gap-4">
							<div class="flex flex-wrap items-end gap-2">
								<Field.Field class="min-w-48 flex-1">
									<Field.FieldLabel for="new-doc-name">
										{m.envelope_new_document_label()}
									</Field.FieldLabel>
									<Input
										id="new-doc-name"
										bind:value={newDocumentName}
										placeholder={m.envelope_new_document_placeholder()}
									/>
								</Field.Field>
								<Button
									variant="outline"
									onclick={addDocument}
									disabled={newDocumentName.trim().length === 0}
								>
									<IconPlus data-icon="inline-start" />{m.envelope_add_document()}
								</Button>
							</div>

							{#if Object.keys(editedContent).length === 0}
								<p class="text-sm text-muted-foreground">{m.envelope_documents_empty()}</p>
							{:else}
								<div class="flex flex-wrap gap-2">
									{#each Object.keys(editedContent) as path (path)}
										<Button
											size="sm"
											variant={activeDocPath === path ? 'default' : 'outline'}
											onclick={() => (activeDocPath = path)}
										>
											{documentTitle(path)}
											{#if dirtyPaths.has(path)}<span class="ml-1 text-xs">•</span>{/if}
										</Button>
									{/each}
								</div>

								{#if activeDocPath !== null}
									<div class="grid gap-4 lg:grid-cols-2">
										<Field.Field>
											<Field.FieldLabel for="doc-editor"
												>{m.envelope_editor_label()}</Field.FieldLabel
											>
											<Textarea
												id="doc-editor"
												class="min-h-72 font-mono text-sm"
												value={editedContent[activeDocPath]}
												oninput={(event) =>
													activeDocPath && updateContent(activeDocPath, event.currentTarget.value)}
											/>
										</Field.Field>
										<div>
											<div class="mb-2 flex items-center justify-between">
												<span class="text-sm font-medium">{m.envelope_preview_label()}</span>
												<div class="flex gap-1">
													<Button
														size="sm"
														variant={previewMode === 'formatted' ? 'default' : 'ghost'}
														onclick={() => (previewMode = 'formatted')}
													>
														{m.signing_document_formatted_view()}
													</Button>
													<Button
														size="sm"
														variant={previewMode === 'source' ? 'default' : 'ghost'}
														onclick={() => (previewMode = 'source')}
													>
														{m.signing_document_source_view()}
													</Button>
												</div>
											</div>
											<div class="min-h-72 rounded-2xl border p-4">
												{#if previewMode === 'source'}
													<pre
														class="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap">{editedContent[
															activeDocPath
														]}</pre>
												{:else if preview !== null}
													<div class="prose max-w-none prose-neutral dark:prose-invert" dir="auto">
														{#each preview.nodes as node, nodeIndex (nodeIndex)}
															{@render renderMarkdownNode(node)}
														{/each}
													</div>
												{/if}
											</div>
										</div>
									</div>
								{/if}
							{/if}

							{#if commitError}
								<p class="text-sm font-medium text-destructive" role="alert">{commitError}</p>
							{/if}
						</Card.Content>
						<Card.Footer class="justify-end gap-2 border-t bg-muted/20 py-4">
							<Button disabled={dirtyPaths.size === 0 || commitPending} onclick={commitChanges}>
								{#if commitPending}<Spinner data-icon="inline-start" />{/if}
								{m.envelope_commit_action({ count: String(dirtyPaths.size) })}
							</Button>
						</Card.Footer>
					</Card.Root>
				{:else if draft !== null}
					<div class="flex flex-col gap-4">
						{#each draft.documents as document (document.path)}
							<Card.Root>
								<Card.Header>
									<Card.Title>{documentTitle(document.path)}</Card.Title>
								</Card.Header>
								<Card.Content>
									<div class="prose max-w-none prose-neutral dark:prose-invert" dir="auto">
										{#each renderRecipientMarkdown(document.content).nodes as node, nodeIndex (nodeIndex)}
											{@render renderMarkdownNode(node)}
										{/each}
									</div>
								</Card.Content>
							</Card.Root>
						{/each}
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">{m.envelope_documents_immutable()}</p>
				{/if}
			</Tabs.Content>

			<Tabs.Content value="recipients" class="flex flex-col gap-4">
				<Card.Root>
					<Card.Header>
						<Card.Title>{m.envelope_recipients_title()}</Card.Title>
						<Card.Description>{m.envelope_recipients_description()}</Card.Description>
					</Card.Header>
					<Card.Content class="flex flex-col gap-4">
						{#if envelope.status === 'draft'}
							<Table.Root>
								<Table.Header>
									<Table.Row>
										<Table.Head>{m.envelope_recipient_col_email()}</Table.Head>
										<Table.Head>{m.envelope_recipient_col_name()}</Table.Head>
										<Table.Head>{m.envelope_recipient_col_role()}</Table.Head>
										<Table.Head>{m.envelope_recipient_col_locale()}</Table.Head>
										<Table.Head>{m.envelope_recipient_col_order()}</Table.Head>
										<Table.Head class="sr-only">{m.common_remove()}</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each recipientDrafts as draftItem (draftItem.key)}
										<Table.Row>
											<Table.Cell>
												<Input
													type="email"
													bind:value={draftItem.email}
													aria-label={m.envelope_recipient_col_email()}
												/>
											</Table.Cell>
											<Table.Cell>
												<Input
													bind:value={draftItem.name}
													aria-label={m.envelope_recipient_col_name()}
												/>
											</Table.Cell>
											<Table.Cell>
												<select
													bind:value={draftItem.role}
													aria-label={m.envelope_recipient_col_role()}
													class="flex h-9 w-full rounded-2xl border border-input bg-input/50 px-3 py-1.5 text-sm font-medium focus-visible:ring-3 focus-visible:ring-ring/30"
												>
													<option value="signer">{m.signing_role_signer()}</option>
													<option value="approver">{m.signing_role_approver()}</option>
													<option value="viewer">{m.signing_role_viewer()}</option>
													<option value="cc">{m.envelope_role_cc()}</option>
												</select>
											</Table.Cell>
											<Table.Cell>
												<select
													bind:value={draftItem.locale}
													aria-label={m.envelope_recipient_col_locale()}
													class="flex h-9 w-full rounded-2xl border border-input bg-input/50 px-3 py-1.5 text-sm font-medium focus-visible:ring-3 focus-visible:ring-ring/30"
												>
													<option value="en">English</option>
													<option value="ja">日本語</option>
												</select>
											</Table.Cell>
											<Table.Cell>
												<Input
													type="number"
													min="1"
													max="1000"
													value={draftItem.routingOrder}
													oninput={(event) => {
														const parsed = Number(event.currentTarget.value);
														if (Number.isFinite(parsed)) draftItem.routingOrder = parsed;
													}}
													aria-label={m.envelope_recipient_col_order()}
													class="w-20"
												/>
											</Table.Cell>
											<Table.Cell>
												<Button
													size="icon"
													variant="ghost"
													aria-label={m.common_remove()}
													onclick={() => removeRecipientDraft(draftItem.key)}
												>
													<IconTrash />
												</Button>
											</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
							<Button variant="outline" onclick={addRecipientDraft} class="w-fit">
								<IconPlus data-icon="inline-start" />{m.envelope_add_recipient()}
							</Button>
							{#if readyError}
								<p class="text-sm font-medium text-destructive" role="alert">{readyError}</p>
							{/if}
						{:else if readyRecipients.length > 0}
							<Table.Root>
								<Table.Header>
									<Table.Row>
										<Table.Head>{m.envelope_recipient_col_email()}</Table.Head>
										<Table.Head>{m.envelope_recipient_col_name()}</Table.Head>
										<Table.Head>{m.envelope_recipient_col_role()}</Table.Head>
										<Table.Head>{m.envelope_recipient_col_order()}</Table.Head>
										<Table.Head>{m.envelope_recipient_col_status()}</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each readyRecipients as recipient (recipient.id)}
										<Table.Row>
											<Table.Cell>{recipient.email}</Table.Cell>
											<Table.Cell>{recipient.name}</Table.Cell>
											<Table.Cell>{recipient.role}</Table.Cell>
											<Table.Cell>{recipient.routingOrder}</Table.Cell>
											<Table.Cell>{recipient.status}</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						{:else}
							<p class="text-sm text-muted-foreground">{m.envelope_recipients_uncached()}</p>
						{/if}
					</Card.Content>
					{#if envelope.status === 'draft'}
						<Card.Footer class="justify-end border-t bg-muted/20 py-4">
							<Button
								disabled={recipientDrafts.length === 0 || readyPending}
								onclick={() => void markReady()}
							>
								{#if readyPending}<Spinner data-icon="inline-start" />{/if}
								{m.envelope_mark_ready()}
							</Button>
						</Card.Footer>
					{/if}
				</Card.Root>
			</Tabs.Content>

			<Tabs.Content value="fields" class="flex flex-col gap-4">
				{#if envelope.status !== 'ready'}
					<p class="text-sm text-muted-foreground">{m.envelope_fields_requires_ready()}</p>
				{:else if signerRecipients().length === 0}
					<p class="text-sm text-muted-foreground">{m.envelope_recipients_uncached()}</p>
				{:else}
					<Card.Root>
						<Card.Header>
							<Card.Title>{m.envelope_fields_title()}</Card.Title>
							<Card.Description>{m.envelope_fields_description()}</Card.Description>
						</Card.Header>
						<Card.Content class="flex flex-col gap-4">
							<div class="grid gap-3 sm:grid-cols-2">
								<Field.Field>
									<Field.FieldLabel for="field-recipient">
										{m.envelope_field_recipient_label()}
									</Field.FieldLabel>
									<select
										id="field-recipient"
										bind:value={newField.recipientId}
										class="flex h-9 w-full rounded-2xl border border-input bg-input/50 px-3 py-1.5 text-sm font-medium focus-visible:ring-3 focus-visible:ring-ring/30"
									>
										<option value="">{m.envelope_field_select_placeholder()}</option>
										{#each signerRecipients() as recipient (recipient.id)}
											<option value={recipient.id}>{recipient.name}</option>
										{/each}
									</select>
								</Field.Field>
								<Field.Field>
									<Field.FieldLabel for="field-document">
										{m.envelope_field_document_label()}
									</Field.FieldLabel>
									<select
										id="field-document"
										bind:value={newField.documentPath}
										class="flex h-9 w-full rounded-2xl border border-input bg-input/50 px-3 py-1.5 text-sm font-medium focus-visible:ring-3 focus-visible:ring-ring/30"
									>
										<option value="">{m.envelope_field_select_placeholder()}</option>
										{#each draft?.documents ?? [] as document (document.path)}
											<option value={document.path}>{documentTitle(document.path)}</option>
										{/each}
									</select>
								</Field.Field>
								<Field.Field>
									<Field.FieldLabel for="field-type"
										>{m.envelope_field_type_label()}</Field.FieldLabel
									>
									<select
										id="field-type"
										bind:value={newField.fieldType}
										class="flex h-9 w-full rounded-2xl border border-input bg-input/50 px-3 py-1.5 text-sm font-medium focus-visible:ring-3 focus-visible:ring-ring/30"
									>
										<option value="signature">{m.signing_field_type_signature()}</option>
										<option value="initials">{m.signing_field_type_initials()}</option>
										<option value="text">{m.signing_field_type_text()}</option>
										<option value="date">{m.signing_field_type_date()}</option>
										<option value="checkbox">{m.signing_field_type_checkbox()}</option>
									</select>
								</Field.Field>
								<Field.Field>
									<Field.FieldLabel for="field-label"
										>{m.envelope_field_label_label()}</Field.FieldLabel
									>
									<Input id="field-label" bind:value={newField.label} maxlength={200} />
								</Field.Field>
								<Field.Field orientation="horizontal">
									<Checkbox id="field-required" bind:checked={newField.required} />
									<Field.FieldLabel for="field-required" class="font-normal">
										{m.signing_field_required()}
									</Field.FieldLabel>
								</Field.Field>
							</div>

							<div>
								<p class="mb-2 text-sm font-medium">{m.envelope_field_geometry_label()}</p>
								<button
									type="button"
									class="relative aspect-[8.5/11] w-full max-w-64 cursor-crosshair rounded-lg border bg-muted/20"
									aria-label={m.envelope_field_geometry_page_aria()}
									onclick={placeOnPage}
								>
									<span
										class="absolute rounded border-2 border-primary bg-primary/20"
										style={`left:${newField.x * 100}%;top:${newField.y * 100}%;width:${newField.width * 100}%;height:${newField.height * 100}%;`}
									></span>
								</button>
								<div class="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
									<Field.Field>
										<Field.FieldLabel for="geo-page" class="text-xs">
											{m.envelope_field_geometry_page()}
										</Field.FieldLabel>
										<Input
											id="geo-page"
											type="number"
											min="1"
											value={newField.page}
											oninput={(event) => setNewFieldNumber('page', event.currentTarget.value)}
										/>
									</Field.Field>
									<Field.Field>
										<Field.FieldLabel for="geo-x" class="text-xs">x</Field.FieldLabel>
										<Input
											id="geo-x"
											type="number"
											min="0"
											max="1"
											step="0.01"
											value={newField.x}
											oninput={(event) => setNewFieldNumber('x', event.currentTarget.value)}
										/>
									</Field.Field>
									<Field.Field>
										<Field.FieldLabel for="geo-y" class="text-xs">y</Field.FieldLabel>
										<Input
											id="geo-y"
											type="number"
											min="0"
											max="1"
											step="0.01"
											value={newField.y}
											oninput={(event) => setNewFieldNumber('y', event.currentTarget.value)}
										/>
									</Field.Field>
									<Field.Field>
										<Field.FieldLabel for="geo-width" class="text-xs">
											{m.envelope_field_geometry_width()}
										</Field.FieldLabel>
										<Input
											id="geo-width"
											type="number"
											min="0.01"
											max="1"
											step="0.01"
											value={newField.width}
											oninput={(event) => setNewFieldNumber('width', event.currentTarget.value)}
										/>
									</Field.Field>
									<Field.Field>
										<Field.FieldLabel for="geo-height" class="text-xs">
											{m.envelope_field_geometry_height()}
										</Field.FieldLabel>
										<Input
											id="geo-height"
											type="number"
											min="0.01"
											max="1"
											step="0.01"
											value={newField.height}
											oninput={(event) => setNewFieldNumber('height', event.currentTarget.value)}
										/>
									</Field.Field>
								</div>
							</div>

							<Button
								variant="outline"
								class="w-fit"
								disabled={newField.recipientId === '' ||
									newField.documentPath === '' ||
									newField.label.trim() === ''}
								onclick={addFieldDraft}
							>
								<IconPlus data-icon="inline-start" />{m.envelope_add_field()}
							</Button>

							{#if fieldDrafts.length > 0}
								<Table.Root>
									<Table.Header>
										<Table.Row>
											<Table.Head>{m.envelope_field_col_label()}</Table.Head>
											<Table.Head>{m.envelope_field_col_type()}</Table.Head>
											<Table.Head>{m.envelope_field_col_document()}</Table.Head>
											<Table.Head>{m.envelope_field_col_position()}</Table.Head>
											<Table.Head class="sr-only">{m.common_remove()}</Table.Head>
										</Table.Row>
									</Table.Header>
									<Table.Body>
										{#each fieldDrafts as fieldDraft (fieldDraft.key)}
											<Table.Row>
												<Table.Cell>{fieldDraft.label}</Table.Cell>
												<Table.Cell>{fieldTypeLabel(fieldDraft.fieldType)}</Table.Cell>
												<Table.Cell>{documentTitle(fieldDraft.documentPath)}</Table.Cell>
												<Table.Cell>{fieldDraft.position}</Table.Cell>
												<Table.Cell>
													<Button
														size="icon"
														variant="ghost"
														aria-label={m.common_remove()}
														onclick={() => removeFieldDraft(fieldDraft.key)}
													>
														<IconTrash />
													</Button>
												</Table.Cell>
											</Table.Row>
										{/each}
									</Table.Body>
								</Table.Root>
							{/if}

							{#if placementError}
								<p class="text-sm font-medium text-destructive" role="alert">{placementError}</p>
							{/if}
							{#if placedFields.length > 0}
								<p class="text-sm text-muted-foreground">
									{m.envelope_fields_published({ count: String(placedFields.length) })}
								</p>
							{/if}
						</Card.Content>
						<Card.Footer class="justify-end border-t bg-muted/20 py-4">
							<Button
								disabled={fieldDrafts.length === 0 || placementPending}
								onclick={() => void publishFields()}
							>
								{#if placementPending}<Spinner data-icon="inline-start" />{/if}
								{m.envelope_publish_fields()}
							</Button>
						</Card.Footer>
					</Card.Root>
				{/if}
			</Tabs.Content>

			<Tabs.Content value="send" class="flex flex-col gap-4">
				<Card.Root>
					<Card.Header>
						<Card.Title>{m.envelope_send_title()}</Card.Title>
						<Card.Description>{m.envelope_send_description()}</Card.Description>
					</Card.Header>
					<Card.Content class="flex flex-col gap-4">
						{#if envelope.status === 'ready'}
							{#if sendError}
								<p class="text-sm font-medium text-destructive" role="alert">{sendError}</p>
							{/if}
							<AlertDialog.Root bind:open={sendDialogOpen}>
								<AlertDialog.Trigger>
									{#snippet child({ props })}
										<Button {...props} class="w-fit">
											<IconSend data-icon="inline-start" />{m.envelope_send_action()}
										</Button>
									{/snippet}
								</AlertDialog.Trigger>
								<AlertDialog.Content>
									<AlertDialog.Header>
										<AlertDialog.Title>{m.envelope_send_dialog_title()}</AlertDialog.Title>
										<AlertDialog.Description>
											{m.envelope_send_dialog_description()}
										</AlertDialog.Description>
									</AlertDialog.Header>
									<AlertDialog.Footer>
										<AlertDialog.Cancel disabled={sendPending}
											>{m.common_cancel()}</AlertDialog.Cancel
										>
										<AlertDialog.Action
											disabled={sendPending}
											onclick={async (event) => {
												event.preventDefault();
												await sendEnvelope();
											}}
										>
											{#if sendPending}<Spinner data-icon="inline-start" />{/if}
											{m.envelope_send_action()}
										</AlertDialog.Action>
									</AlertDialog.Footer>
								</AlertDialog.Content>
							</AlertDialog.Root>
						{:else}
							<p class="text-sm text-muted-foreground">{m.envelope_send_requires_ready()}</p>
						{/if}

						{#if delivery !== null}
							<Table.Root>
								<Table.Header>
									<Table.Row>
										<Table.Head>{m.envelope_delivery_col_role()}</Table.Head>
										<Table.Head>{m.envelope_delivery_col_order()}</Table.Head>
										<Table.Head>{m.envelope_delivery_col_status()}</Table.Head>
										<Table.Head>{m.envelope_delivery_col_attempts()}</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each delivery.deliveries as item (item.recipientId)}
										<Table.Row>
											<Table.Cell>{item.recipientRole}</Table.Cell>
											<Table.Cell>{item.routingOrder}</Table.Cell>
											<Table.Cell><Badge variant="secondary">{item.status}</Badge></Table.Cell>
											<Table.Cell>{item.attempts}</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						{/if}
					</Card.Content>
				</Card.Root>

				{#if isVoidable}
					<Card.Root class="border-destructive/30">
						<Card.Header>
							<Card.Title>{m.envelope_void_title()}</Card.Title>
							<Card.Description>{m.envelope_void_description()}</Card.Description>
						</Card.Header>
						<Card.Content class="flex flex-col gap-3">
							{#if voidError}
								<p class="text-sm font-medium text-destructive" role="alert">{voidError}</p>
							{/if}
							<AlertDialog.Root bind:open={voidDialogOpen}>
								<AlertDialog.Trigger>
									{#snippet child({ props })}
										<Button {...props} variant="destructive" class="w-fit">
											<IconBan data-icon="inline-start" />{m.envelope_void_action()}
										</Button>
									{/snippet}
								</AlertDialog.Trigger>
								<AlertDialog.Content>
									<AlertDialog.Header>
										<AlertDialog.Title>{m.envelope_void_dialog_title()}</AlertDialog.Title>
										<AlertDialog.Description>
											{m.envelope_void_dialog_description()}
										</AlertDialog.Description>
									</AlertDialog.Header>
									<AlertDialog.Footer>
										<AlertDialog.Cancel disabled={voidPending}
											>{m.common_cancel()}</AlertDialog.Cancel
										>
										<AlertDialog.Action
											variant="destructive"
											disabled={voidPending}
											onclick={async (event) => {
												event.preventDefault();
												await voidEnvelopeAction();
											}}
										>
											{#if voidPending}<Spinner data-icon="inline-start" />{/if}
											{m.envelope_void_dialog_confirm()}
										</AlertDialog.Action>
									</AlertDialog.Footer>
								</AlertDialog.Content>
							</AlertDialog.Root>
						</Card.Content>
					</Card.Root>
				{/if}
			</Tabs.Content>
		</Tabs.Root>
	{/if}
</div>
