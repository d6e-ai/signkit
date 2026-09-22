<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import IconPlus from '@tabler/icons-svelte/icons/plus';
	import IconTrash from '@tabler/icons-svelte/icons/trash';
	import IconChevronUp from '@tabler/icons-svelte/icons/chevron-up';
	import IconChevronDown from '@tabler/icons-svelte/icons/chevron-down';
	import IconSend from '@tabler/icons-svelte/icons/send';
	import IconBan from '@tabler/icons-svelte/icons/ban';
	import IconDownload from '@tabler/icons-svelte/icons/download';
	import IconFileTypeDocx from '@tabler/icons-svelte/icons/file-type-docx';
	import IconFileTypePdf from '@tabler/icons-svelte/icons/file-type-pdf';
	import IconAddressBook from '@tabler/icons-svelte/icons/address-book';
	import ContactCombobox from '$lib/components/contacts/contact-combobox.svelte';
	import ContactManagementDialog from '$lib/components/contacts/contact-management-dialog.svelte';
	import {
		ContactsApiError,
		createContactMutationAttempt,
		createContactsClient,
		type Contact,
		type ContactMutationAttempt
	} from '$lib/client/contacts';
	import PdfDocumentView, { type PdfRenderedPage } from '$lib/components/pdf-document-view.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
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
		type PublicCompletionArtifactStatus,
		type PublicEnvelopeDeliveryStatus,
		type PublicEnvelopeFieldResponse,
		type ReadyRecipientInput,
		type ReadyRecipientPublic,
		type RecipientRole,
		type VoidableEnvelopeStatus
	} from '$lib/client/envelopes';
	import type { DocumentSetLeaf, DocumentSetManifest } from '$lib/domain/document-set';
	import { isMarkdownPath, type MarkdownPath, type RecipientStatus } from '$lib/domain/envelope';
	import {
		isValidRecipientEmail,
		isValidRecipientName,
		normalizeRecipientEmail,
		normalizeRecipientName
	} from '$lib/domain/recipient-identity';
	import { envelopeBreadcrumbTitle } from '$lib/navigation/envelope-breadcrumb-title';
	import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
	import type { RecipientMarkdownNode } from '$lib/security/recipient-markdown';
	import * as m from '$lib/paraglide/messages';
	import { getLocale, localizeHref } from '$lib/paraglide/runtime';
	import {
		type EnvelopeDocumentPageMap,
		fieldPlacementReady,
		invalidateDocumentPageMap,
		type PageMapRevision,
		refreshDocumentPageMap,
		refreshDocumentPageMapAfterReload
	} from './document-page-map';

	const client = createEnvelopesClient();
	const contactsClient = createContactsClient();
	const envelopeId = $derived(page.params.envelopeId as string);

	let loading = $state(true);
	let authRequired = $state(false);
	let loadError = $state<string | null>(null);
	let envelope = $state<Envelope | null>(null);
	let draft = $state<DraftWorkspaceResponse | null>(null);
	let delivery = $state<PublicEnvelopeDeliveryStatus | null>(null);
	let completionStatus = $state<PublicCompletionArtifactStatus | null>(null);
	let completionStatusError = $state<string | null>(null);
	let completionDownloadError = $state<string | null>(null);
	let completionPdfDownloadPending = $state(false);
	let completionEvidenceDownloadPending = $state<'json' | 'markdown' | null>(null);

	// Documents editor state.
	let editedContent = $state<Record<string, string>>({});
	const dirtyPaths = new SvelteSet<string>();
	let activeDocPath = $state<string | null>(null);
	let addDocumentDialogOpen = $state(false);
	let docxInput = $state<HTMLInputElement | null>(null);
	let pdfInput = $state<HTMLInputElement | null>(null);
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
		savedContact: Contact | null;
		contactSaveAttempt: ContactMutationAttempt;
	}
	let recipientDrafts = $state<RecipientDraft[]>([]);
	let contactManagementOpen = $state(false);
	let contactSavePending = $state<Record<string, boolean>>({});
	let contactSaveError = $state<Record<string, string | null>>({});
	let contactSaveSucceeded = $state<Record<string, boolean>>({});
	// A field's invalid state is shown once its own input has been blurred,
	// or once a ready/submit attempt has touched every row - otherwise every
	// freshly added row would open already showing errors.
	let recipientNameTouched = $state<Record<string, boolean>>({});
	let recipientEmailTouched = $state<Record<string, boolean>>({});
	let recipientValidationAttempted = $state(false);
	let readyPending = $state(false);
	let readyError = $state<string | null>(null);
	let readyRecipients = $state<readonly ReadyRecipientPublic[]>([]);
	let readyAuditEventId = $state<string | null>(null);
	const recipientsHaveInvalidIdentity = $derived(
		recipientDrafts.some(
			(draftItem) => recipientEmailInvalid(draftItem) || recipientNameInvalid(draftItem)
		)
	);
	let importPending = $state(false);
	let importError = $state<string | null>(null);
	let exportPending = $state(false);
	let exportError = $state<string | null>(null);

	// Field placement state.
	interface FieldDraft {
		key: string;
		recipientId: string;
		documentId: string;
		fieldType: FieldType;
		label: string;
		required: boolean;
		position: number;
		/** Always set: a draft is only ever created by dropping a box on a page. */
		geometry: FieldGeometry;
	}
	let fieldDrafts = $state<FieldDraft[]>([]);
	let placementPending = $state(false);
	let placementError = $state<string | null>(null);
	let placedFields = $state<readonly PublicEnvelopeFieldResponse[]>([]);
	/**
	 * Placement replaces the entire field set, and the public read model omits
	 * labels, so a persisted field can never be safely folded back into a
	 * republishable draft. Once any field is persisted, further placement is
	 * fully locked in this revision rather than risking a partial-set publish
	 * that silently deletes everything already there.
	 */
	const placementLocked = $derived(placedFields.length > 0);
	let selectedPublishedFieldId = $state<string | null>(null);
	let keyboardAddPage = $state(1);
	let geometryAnnouncement = $state('');
	/**
	 * Raw text currently being typed into the Left/Top/Width/Height percentage
	 * inputs, keyed by axis. Displaying this instead of a freshly rounded
	 * value while the field has an in-progress edit is what lets an
	 * intermediate value like "8." survive to become "8.5" - echoing the
	 * rounded number back on every keystroke would silently drop the trailing
	 * decimal point before a digit after it could be typed.
	 */
	let selectedGeometryFieldText = $state<Partial<Record<'x' | 'y' | 'width' | 'height', string>>>(
		{}
	);
	let newField = $state<{
		recipientId: string;
		fieldType: FieldType;
		label: string;
		required: boolean;
	}>({
		recipientId: '',
		fieldType: 'signature',
		label: '',
		required: true
	});

	/**
	 * The page geometry of the exact document rendering a recipient will be
	 * shown. Placement is expressed against this, not against the Markdown
	 * source, so a box the sender drops on page 3 is the box the signer sees on
	 * page 3. Null until the current ready revision's map has loaded.
	 */
	let documentPages = $state<EnvelopeDocumentPageMap | null>(null);
	let documentPagesLoading = $state(false);
	let selectedFieldKey = $state<string | null>(null);
	let selectedPlacementDocumentId = $state<string | null>(null);
	let pdfUploadPending = $state(false);
	let pdfUploadError = $state<string | null>(null);
	let documentOrderPending = $state(false);
	let documentOrderError = $state<string | null>(null);
	let removeDocumentId = $state<string | null>(null);
	let removeDialogOpen = $state(false);
	let activeDocumentKey = $state<string | null>(null);
	/** Default box, as a fraction of one page: roughly a signature line. */
	const DEFAULT_FIELD_WIDTH = 0.26;
	const DEFAULT_FIELD_HEIGHT = 0.05;
	const MIN_FIELD_SIZE = 0.02;
	/** Arrow = fine step; Shift+Arrow = coarse step. Matches the displayed hint exactly. */
	const FINE_STEP = 0.005;
	const COARSE_STEP = 0.025;
	/** Inset (from the page's top-left corner) for zero-click keyboard field creation - deliberately not centered, so it never lands under an existing centered box. */
	const KEYBOARD_ADD_INSET = 0.08;
	let dragState: {
		key: string;
		mode: 'move' | 'resize';
		pointerId: number;
		originX: number;
		originY: number;
		geometry: FieldGeometry;
		pageWidth: number;
		pageHeight: number;
	} | null = null;

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

	type AuthoringDocument =
		| { source: 'set'; leaf: DocumentSetLeaf; key: string }
		| { source: 'pending'; path: MarkdownPath; key: string };

	const authoringDocuments = $derived.by((): AuthoringDocument[] => {
		const set: DocumentSetManifest | null = draft?.documentSet ?? null;
		if (set !== null && set.documents.length > 0) {
			const committedPaths = new Set(
				set.documents.flatMap((leaf) => (leaf.kind === 'markdown' ? [leaf.path] : []))
			);
			const pending = Object.keys(editedContent)
				.filter((path): path is MarkdownPath => isMarkdownPath(path) && !committedPaths.has(path))
				.map((path): AuthoringDocument => ({
					source: 'pending',
					path,
					key: `pending:${path}`
				}));
			return [
				...set.documents.map((leaf): AuthoringDocument => ({
					source: 'set',
					leaf,
					key: `set:${leaf.id}`
				})),
				...pending
			];
		}
		return Object.keys(editedContent)
			.filter((path): path is MarkdownPath => isMarkdownPath(path))
			.map((path): AuthoringDocument => ({ source: 'pending', path, key: `pending:${path}` }));
	});

	const activePdfLeaf = $derived.by((): DocumentSetLeaf | null => {
		if (activeDocumentKey === null || !activeDocumentKey.startsWith('set:')) return null;
		const id = activeDocumentKey.slice(4);
		const leaf = draft?.documentSet?.documents.find((entry) => entry.id === id);
		return leaf?.kind === 'pdf' ? leaf : null;
	});

	function selectAuthoringDocument(entry: AuthoringDocument): void {
		activeDocumentKey = entry.key;
		if (entry.source === 'pending') {
			activeDocPath = entry.path;
			return;
		}
		if (entry.leaf.kind === 'markdown') {
			activeDocPath = entry.leaf.path;
			return;
		}
		activeDocPath = null;
	}

	function authoringDocumentTitle(entry: AuthoringDocument): string {
		if (entry.source === 'pending') return documentTitle(entry.path);
		return entry.leaf.title;
	}

	function placedDocumentTitle(documentId: string): string {
		const fromPages = documentPages?.documents.find((entry) => entry.documentId === documentId);
		if (fromPages !== undefined) return fromPages.title;
		return documentId.slice(0, 8);
	}

	function fieldTypeLabel(fieldType: FieldType): string {
		if (fieldType === 'signature') return m.signing_field_type_signature();
		if (fieldType === 'initials') return m.signing_field_type_initials();
		if (fieldType === 'date') return m.signing_field_type_date();
		if (fieldType === 'checkbox') return m.signing_field_type_checkbox();
		return m.signing_field_type_text();
	}

	function recipientRoleLabel(role: RecipientRole): string {
		switch (role) {
			case 'signer':
				return m.signing_role_signer();
			case 'approver':
				return m.signing_role_approver();
			case 'viewer':
				return m.signing_role_viewer();
			case 'cc':
				return m.envelope_role_cc();
			case 'prefill':
				return m.signing_role_prefill();
		}
	}

	function recipientLocaleLabel(locale: 'en' | 'ja'): string {
		return locale === 'ja' ? '日本語' : 'English';
	}

	function recipientWorkflowStatusLabel(status: string): string {
		const workflowStatus: RecipientStatus | null =
			status === 'pending' || status === 'viewed' || status === 'completed' || status === 'declined'
				? status
				: null;
		if (workflowStatus === null) return m.envelope_recipient_status_unknown();
		switch (workflowStatus) {
			case 'pending':
				return m.envelope_recipient_status_pending();
			case 'viewed':
				return m.envelope_recipient_status_viewed();
			case 'completed':
				return m.envelope_recipient_status_completed();
			case 'declined':
				return m.envelope_recipient_status_declined();
		}
	}

	type InvitationDeliveryStatus = PublicEnvelopeDeliveryStatus['deliveries'][number]['status'];

	function deliveryStateLabel(status: InvitationDeliveryStatus): string {
		switch (status) {
			case 'blocked':
				return m.envelope_delivery_status_blocked();
			case 'pending':
				return m.envelope_delivery_status_pending();
			case 'processing':
				return m.envelope_delivery_status_processing();
			case 'delivered':
				return m.envelope_delivery_status_delivered();
			case 'failed':
				return m.envelope_delivery_status_failed();
		}
	}

	function recipientForDelivery(recipientId: string): ReadyRecipientPublic | undefined {
		return readyRecipients.find((recipient) => recipient.id === recipientId);
	}

	async function load(): Promise<void> {
		loading = true;
		authRequired = false;
		loadError = null;
		try {
			const detail = await client.getDetail(envelopeId);
			envelope = detail.envelope;
			readyRecipients = detail.recipients;
			readyAuditEventId = detail.readyAuditEventId;
			placedFields = detail.fields;
			if (detail.envelope.status === 'draft' || detail.envelope.status === 'ready') {
				const workspace = await client.getDraft(envelopeId);
				draft = workspace;
				editedContent = Object.fromEntries(
					workspace.documents.map((document) => [document.path, document.content])
				);
				dirtyPaths.clear();
				activeDocPath ??= workspace.documents[0]?.path ?? null;
				if (activeDocumentKey === null) {
					const first = workspace.documentSet?.documents[0];
					activeDocumentKey =
						first !== undefined
							? `set:${first.id}`
							: workspace.documents[0]?.path
								? `pending:${workspace.documents[0].path}`
								: null;
				}
			} else {
				draft = await client.getDraft(envelopeId).catch(() => null);
			}
			if (
				detail.recipients.some((recipient) => recipient.role === 'signer') &&
				newField.recipientId === ''
			) {
				const firstSigner = detail.recipients.find((recipient) => recipient.role === 'signer');
				if (firstSigner) newField = { ...newField, recipientId: firstSigner.id };
			}
			if (detail.envelope.status !== 'draft') {
				delivery = await client.deliveries(envelopeId).catch(() => null);
			}
			if (detail.envelope.status === 'completed') {
				completionStatusError = null;
				try {
					completionStatus = await client.completionArtifactStatus(envelopeId);
				} catch {
					completionStatus = null;
					completionStatusError = m.envelope_completed_status_unavailable();
				}
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
				documentSet: draft.documentSet,
				documents: Object.entries(editedContent).map(([path, content]) => ({
					path: path as `documents/${string}.md`,
					content
				}))
			};
			dirtyPaths.clear();
			documentPages = invalidateDocumentPageMap();
			await load();
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
				routingOrder: recipientDrafts.length + 1,
				savedContact: null,
				contactSaveAttempt: createContactMutationAttempt()
			}
		];
	}

	function removeRecipientDraft(key: string): void {
		recipientDrafts = recipientDrafts.filter((draftItem) => draftItem.key !== key);
		delete recipientNameTouched[key];
		delete recipientEmailTouched[key];
	}

	// Both checks reuse the exact predicates the server applies after the same
	// trim/lowercase normalization (see ready.ts's canonicalizeRecipients), so
	// a whitespace-only value is blank here for the identical reason it is
	// blank there, and nothing can pass client-side that the server rejects.
	function recipientNameInvalid(draftItem: RecipientDraft): boolean {
		return !isValidRecipientName(normalizeRecipientName(draftItem.name));
	}

	function recipientEmailInvalid(draftItem: RecipientDraft): boolean {
		return !isValidRecipientEmail(normalizeRecipientEmail(draftItem.email));
	}

	function recipientNameErrorVisible(draftItem: RecipientDraft): boolean {
		return (
			recipientNameInvalid(draftItem) &&
			(recipientNameTouched[draftItem.key] === true || recipientValidationAttempted)
		);
	}

	function recipientEmailErrorVisible(draftItem: RecipientDraft): boolean {
		return (
			recipientEmailInvalid(draftItem) &&
			(recipientEmailTouched[draftItem.key] === true || recipientValidationAttempted)
		);
	}

	function markRecipientNameTouched(key: string): void {
		recipientNameTouched[key] = true;
	}

	function markRecipientEmailTouched(key: string): void {
		recipientEmailTouched[key] = true;
	}

	interface InvalidRecipientField {
		key: string;
		field: 'email' | 'name';
	}

	/**
	 * Row by row, in the same left-to-right order the columns render (email
	 * before name), so "the first invalid input" always means what it looks
	 * like it means on screen.
	 */
	function firstInvalidRecipientField(): InvalidRecipientField | undefined {
		for (const draftItem of recipientDrafts) {
			if (recipientEmailInvalid(draftItem)) return { key: draftItem.key, field: 'email' };
			if (recipientNameInvalid(draftItem)) return { key: draftItem.key, field: 'name' };
		}
		return undefined;
	}

	function focusRecipientField(target: InvalidRecipientField): void {
		document.getElementById(`recipient-${target.field}-${target.key}`)?.focus();
	}

	/**
	 * The shared gate for both the Ready button and a keyboard submission
	 * attempt: a disabled button never dispatches a click or an implicit form
	 * submission, so pressing Enter in a recipient field has to reach this
	 * directly to move focus to the first invalid field instead of silently
	 * doing nothing.
	 */
	function attemptMarkReady(): void {
		recipientValidationAttempted = true;
		const invalidField = firstInvalidRecipientField();
		if (invalidField !== undefined) {
			focusRecipientField(invalidField);
			return;
		}
		void markReady();
	}

	function handleRecipientRowKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter') return;
		// isComposing (and the legacy keyCode 229) excludes the Enter that
		// confirms an IME conversion - treating that as a submission attempt
		// would make it impossible to finish typing a Japanese recipient name.
		if (event.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		attemptMarkReady();
	}

	function applyContactToRecipient(key: string, contact: Contact): void {
		const draftItem: RecipientDraft | undefined = recipientDrafts.find((item) => item.key === key);
		if (draftItem === undefined) return;
		// Contact reuse is identity-only. Workflow authority remains an explicit
		// choice on this envelope and is never copied from the address book.
		draftItem.email = contact.email;
		draftItem.name = contact.name;
		draftItem.locale = contact.locale;
		draftItem.savedContact = contact;
		draftItem.contactSaveAttempt.invalidate();
		contactSaveError[key] = null;
		contactSaveSucceeded[key] = false;
	}

	function markRecipientContactChanged(draftItem: RecipientDraft): void {
		// Only an email edit that actually diverges from the linked contact's
		// address breaks the link: email is the owner-scoped unique key, so
		// changing it to a different address means the next save must create a
		// separate contact. Name and locale edits (and an email edit that ends
		// up unchanged) still describe the same contact, so the next save stays
		// an update instead of colliding with the contact's own email.
		if (
			draftItem.savedContact !== null &&
			normalizeRecipientEmail(draftItem.email) !== draftItem.savedContact.email
		) {
			draftItem.savedContact = null;
		}
		draftItem.contactSaveAttempt.invalidate();
		contactSaveError[draftItem.key] = null;
		contactSaveSucceeded[draftItem.key] = false;
	}

	async function saveRecipientToContacts(draftItem: RecipientDraft): Promise<void> {
		if (contactSavePending[draftItem.key]) return;
		contactSavePending[draftItem.key] = true;
		contactSaveError[draftItem.key] = null;
		contactSaveSucceeded[draftItem.key] = false;
		const idempotencyKey: string = draftItem.contactSaveAttempt.key();
		try {
			const input = {
				name: draftItem.name.trim(),
				email: draftItem.email.trim(),
				locale: draftItem.locale
			};
			const result =
				draftItem.savedContact === null
					? await contactsClient.create(input, { idempotencyKey })
					: await contactsClient.update(
							draftItem.savedContact.id,
							{
								...input,
								expectedVersion: draftItem.savedContact.version
							},
							{ idempotencyKey }
						);
			draftItem.contactSaveAttempt.succeeded();
			draftItem.savedContact = result.contact;
			contactSaveSucceeded[draftItem.key] = true;
		} catch (cause) {
			draftItem.contactSaveAttempt.failed(cause);
			contactSaveError[draftItem.key] =
				cause instanceof ContactsApiError ? cause.detail : m.contacts_save_unavailable();
		} finally {
			contactSavePending[draftItem.key] = false;
		}
	}

	async function markReady(): Promise<void> {
		if (envelope === null || draft === null || readyPending) return;
		if (recipientDrafts.length === 0 || recipientsHaveInvalidIdentity) return;
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
			readyAuditEventId = result.ready.auditEventId;
			await reloadAuthoringSurface();
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

	function currentPageMapRevision(): PageMapRevision | null {
		if (envelope === null) return null;
		return {
			status: envelope.status,
			repositoryHead: envelope.repositoryHead,
			repositoryGeneration: envelope.repositoryGeneration
		};
	}

	async function fetchDocumentPages(): Promise<EnvelopeDocumentPageMap | null> {
		const documentId: string | null =
			selectedPlacementDocumentId ??
			documentPages?.documentId ??
			draft?.documentSet?.documents[0]?.id ??
			null;
		if (documentId === null) return null;
		const response = await fetch(
			`/api/v1/envelopes/${envelopeId}/document-pdf/pages?documentId=${encodeURIComponent(documentId)}`,
			{
				credentials: 'same-origin',
				headers: { accept: 'application/json' }
			}
		);
		if (!response.ok) return null;
		const pageMap = (await response.json()) as EnvelopeDocumentPageMap;
		if (pageMap.documentId !== documentId) return null;
		return pageMap;
	}

	async function loadDocumentPages(): Promise<void> {
		documentPages = invalidateDocumentPageMap();
		documentPagesLoading = true;
		try {
			documentPages = await refreshDocumentPageMap({
				revision: currentPageMapRevision(),
				loadPages: fetchDocumentPages
			});
		} finally {
			documentPagesLoading = false;
		}
	}

	async function reloadAuthoringSurface(): Promise<void> {
		documentPages = invalidateDocumentPageMap();
		documentPagesLoading = true;
		try {
			documentPages = await refreshDocumentPageMapAfterReload({
				reload: async (): Promise<PageMapRevision | null> => {
					await load();
					return currentPageMapRevision();
				},
				loadPages: fetchDocumentPages
			});
		} finally {
			documentPagesLoading = false;
		}
	}

	/**
	 * Which document a page belongs to. Deriving the path from the page rather
	 * than asking the sender to pick one separately is what makes it impossible
	 * to place a field on a page outside the document it claims.
	 */
	function documentIdForPlacement(): string | null {
		return selectedPlacementDocumentId ?? documentPages?.documentId ?? null;
	}

	function roundFraction(value: number): number {
		return Math.round(value * 10_000) / 10_000;
	}

	/** Percentages shown in the geometry panel: tenths, not raw 0..1 fractions. */
	function round1(value: number): number {
		return Math.round(value * 10) / 10;
	}

	/** Keeps every box finite, non-degenerate, and fully inside its page. */
	function clampGeometry(geometry: FieldGeometry): FieldGeometry {
		const width = Math.min(1, Math.max(MIN_FIELD_SIZE, geometry.width));
		const height = Math.min(1, Math.max(MIN_FIELD_SIZE, geometry.height));
		return {
			page: geometry.page,
			x: roundFraction(Math.min(1 - width, Math.max(0, geometry.x))),
			y: roundFraction(Math.min(1 - height, Math.max(0, geometry.y))),
			width: roundFraction(width),
			height: roundFraction(height)
		};
	}

	/** The page count of the document currently open for placement, for clamping page input/selection. */
	function currentDocumentPageCount(): number {
		const documentId = documentIdForPlacement();
		const fromDocuments = documentPages?.documents.find(
			(entry) => entry.documentId === documentId
		)?.pageCount;
		return fromDocuments ?? documentPages?.pageCount ?? 1;
	}

	function announceGeometry(label: string, geometry: FieldGeometry): void {
		geometryAnnouncement = m.envelope_placement_geometry_announcement({
			label,
			left: String(round1(geometry.x * 100)),
			top: String(round1(geometry.y * 100)),
			width: String(round1(geometry.width * 100)),
			height: String(round1(geometry.height * 100)),
			page: String(geometry.page)
		});
	}

	function addFieldAt(page: number, x: number, y: number): void {
		if (placementLocked) return;
		const documentId = documentIdForPlacement();
		if (newField.recipientId === '' || documentId === null) return;
		const key = crypto.randomUUID();
		const label = newField.label.trim() || fieldTypeLabel(newField.fieldType);
		const geometry = clampGeometry({
			page,
			x: x - DEFAULT_FIELD_WIDTH / 2,
			y: y - DEFAULT_FIELD_HEIGHT / 2,
			width: DEFAULT_FIELD_WIDTH,
			height: DEFAULT_FIELD_HEIGHT
		});
		fieldDrafts = [
			...fieldDrafts,
			{
				key,
				recipientId: newField.recipientId,
				documentId,
				fieldType: newField.fieldType,
				label,
				required: newField.required,
				position: fieldDrafts.length + 1,
				geometry
			}
		];
		selectedFieldKey = key;
		selectedPublishedFieldId = null;
		newField = { ...newField, label: '' };
		announceGeometry(label, geometry);
	}

	function handlePageClick(
		event: MouseEvent & { currentTarget: EventTarget & HTMLElement },
		page: number
	): void {
		if (placementLocked) return;
		const rect = event.currentTarget.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		addFieldAt(
			page,
			(event.clientX - rect.left) / rect.width,
			(event.clientY - rect.top) / rect.height
		);
	}

	/**
	 * Zero-click field creation: places a field of the currently selected
	 * recipient/type at a deterministic, bounded inset on the chosen page,
	 * then moves focus onto the new box so arrow-key editing can continue
	 * without ever touching a pointer. Shares clampGeometry/addFieldAt with
	 * pointer-driven placement, so both paths agree on bounds.
	 */
	async function addFieldViaKeyboard(): Promise<void> {
		if (placementLocked) return;
		const pageCount = currentDocumentPageCount();
		const page = Math.min(Math.max(1, Math.round(keyboardAddPage) || 1), pageCount);
		keyboardAddPage = page;
		addFieldAt(
			page,
			KEYBOARD_ADD_INSET + DEFAULT_FIELD_WIDTH / 2,
			KEYBOARD_ADD_INSET + DEFAULT_FIELD_HEIGHT / 2
		);
		const key = selectedFieldKey;
		if (key === null) return;
		await focusFieldBoxWhenMounted(key);
	}

	/**
	 * The field box lives inside PdfDocumentView's overlay, which only mounts
	 * once PDF.js finishes loading - the Add field control is available as
	 * soon as the page map JSON loads, well before that. A single tick is not
	 * enough to wait out that race, so poll a bounded number of frames for the
	 * box to actually mount before giving up.
	 */
	async function focusFieldBoxWhenMounted(key: string, maxAttempts = 50): Promise<void> {
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			await tick();
			const element = document.getElementById(`field-box-${key}`);
			if (element !== null) {
				element.focus();
				return;
			}
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		}
	}

	function updateGeometry(key: string, next: FieldGeometry): void {
		fieldDrafts = fieldDrafts.map((draftItem) =>
			draftItem.key === key ? { ...draftItem, geometry: clampGeometry(next) } : draftItem
		);
		const updated = fieldDrafts.find((draftItem) => draftItem.key === key);
		if (updated) announceGeometry(updated.label, updated.geometry);
	}

	function geometryOf(key: string): FieldGeometry | null {
		return fieldDrafts.find((draftItem) => draftItem.key === key)?.geometry ?? null;
	}

	interface SelectedFieldGeometryPanel {
		key: string;
		label: string;
		geometry: FieldGeometry;
		editable: boolean;
	}

	/**
	 * Backs the Page/Left/Top/Width/Height FieldSet. Resolves to whichever of
	 * the two mutually exclusive selections (a mutable draft, or a read-only
	 * persisted field) is active, so the panel has one source regardless of
	 * which kind of box the operator focused.
	 */
	const selectedFieldPanel = $derived.by((): SelectedFieldGeometryPanel | null => {
		const activeDocumentId = documentIdForPlacement();
		if (selectedFieldKey !== null) {
			const draftItem = fieldDrafts.find((item) => item.key === selectedFieldKey);
			if (draftItem !== undefined && draftItem.documentId === activeDocumentId) {
				return {
					key: draftItem.key,
					label: draftItem.label,
					geometry: draftItem.geometry,
					editable: true
				};
			}
		}
		if (selectedPublishedFieldId !== null) {
			const field = placedFields.find((item) => item.id === selectedPublishedFieldId);
			if (field !== undefined && field.documentId === activeDocumentId && field.geometry !== null) {
				return {
					key: field.id,
					label: fieldTypeLabel(field.fieldType),
					geometry: field.geometry,
					editable: false
				};
			}
		}
		return null;
	});

	function updateSelectedGeometry(patch: Partial<FieldGeometry>): void {
		const panel = selectedFieldPanel;
		if (panel === null || !panel.editable) return;
		updateGeometry(panel.key, { ...panel.geometry, ...patch });
	}

	function updateSelectedPage(value: number): void {
		if (!Number.isFinite(value)) return;
		const pageCount = currentDocumentPageCount();
		updateSelectedGeometry({ page: Math.min(Math.max(1, Math.round(value)), pageCount) });
	}

	function updateSelectedPercent(field: 'x' | 'y' | 'width' | 'height', percent: number): void {
		if (!Number.isFinite(percent)) return;
		updateSelectedGeometry({ [field]: percent / 100 } as Partial<FieldGeometry>);
	}

	/** What the Left/Top/Width/Height inputs show: the in-progress typed text, or the stored value once it isn't being edited. */
	function selectedGeometryDisplayValue(
		field: 'x' | 'y' | 'width' | 'height',
		geometry: FieldGeometry
	): string {
		return selectedGeometryFieldText[field] ?? String(round1(geometry[field] * 100));
	}

	function handleSelectedGeometryPercentInput(
		field: 'x' | 'y' | 'width' | 'height',
		raw: string
	): void {
		selectedGeometryFieldText = { ...selectedGeometryFieldText, [field]: raw };
		updateSelectedPercent(field, Number(raw));
	}

	function commitSelectedGeometryPercentInput(field: 'x' | 'y' | 'width' | 'height'): void {
		if (!(field in selectedGeometryFieldText)) return;
		const next = { ...selectedGeometryFieldText };
		delete next[field];
		selectedGeometryFieldText = next;
	}

	function togglePublishedFieldSelection(id: string): void {
		const nextSelected = selectedPublishedFieldId === id ? null : id;
		selectedPublishedFieldId = nextSelected;
		selectedFieldKey = null;
		if (nextSelected === null) return;
		const field = placedFields.find((item) => item.id === nextSelected);
		if (field?.geometry) announceGeometry(fieldTypeLabel(field.fieldType), field.geometry);
	}

	function startDrag(event: PointerEvent, key: string, mode: 'move' | 'resize'): void {
		const target = event.currentTarget as HTMLElement;
		const page = target.closest('[data-pdf-page]');
		const geometry = geometryOf(key);
		if (!(page instanceof HTMLElement) || geometry === null) return;
		const rect = page.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		event.preventDefault();
		event.stopPropagation();
		target.setPointerCapture(event.pointerId);
		selectedFieldKey = key;
		selectedPublishedFieldId = null;
		dragState = {
			key,
			mode,
			pointerId: event.pointerId,
			originX: event.clientX,
			originY: event.clientY,
			geometry,
			pageWidth: rect.width,
			pageHeight: rect.height
		};
	}

	function continueDrag(event: PointerEvent): void {
		const state = dragState;
		if (state === null || state.pointerId !== event.pointerId) return;
		const deltaX = (event.clientX - state.originX) / state.pageWidth;
		const deltaY = (event.clientY - state.originY) / state.pageHeight;
		updateGeometry(
			state.key,
			state.mode === 'move'
				? { ...state.geometry, x: state.geometry.x + deltaX, y: state.geometry.y + deltaY }
				: {
						...state.geometry,
						width: state.geometry.width + deltaX,
						height: state.geometry.height + deltaY
					}
		);
	}

	function endDrag(event: PointerEvent): void {
		if (dragState?.pointerId !== event.pointerId) return;
		dragState = null;
	}

	function handleFieldKeydown(event: KeyboardEvent, key: string): void {
		const geometry = geometryOf(key);
		if (geometry === null) return;
		if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault();
			removeFieldDraft(key);
			return;
		}
		const step = event.shiftKey ? COARSE_STEP : FINE_STEP;
		let next: FieldGeometry | null = null;
		const resizing = event.altKey;
		if (event.key === 'ArrowLeft') {
			next = resizing
				? { ...geometry, width: geometry.width - step }
				: { ...geometry, x: geometry.x - step };
		} else if (event.key === 'ArrowRight') {
			next = resizing
				? { ...geometry, width: geometry.width + step }
				: { ...geometry, x: geometry.x + step };
		} else if (event.key === 'ArrowUp') {
			next = resizing
				? { ...geometry, height: geometry.height - step }
				: { ...geometry, y: geometry.y - step };
		} else if (event.key === 'ArrowDown') {
			next = resizing
				? { ...geometry, height: geometry.height + step }
				: { ...geometry, y: geometry.y + step };
		}
		if (next === null) return;
		event.preventDefault();
		selectedFieldKey = key;
		updateGeometry(key, next);
	}

	function removeFieldDraft(key: string): void {
		fieldDrafts = fieldDrafts
			.filter((draftItem) => draftItem.key !== key)
			.map((draftItem, index) => ({ ...draftItem, position: index + 1 }));
		if (selectedFieldKey === key) selectedFieldKey = null;
	}

	async function publishFields(): Promise<void> {
		if (placementLocked) return;
		if (envelope === null || draft === null || fieldDrafts.length === 0 || placementPending) return;
		placementPending = true;
		placementError = null;
		try {
			const result = await client.placeFields(envelopeId, {
				expectedGeneration: draft.generation,
				expectedFieldGeneration: envelope.fieldGeneration,
				fields: fieldDrafts.map((draftItem) => ({
					recipientId: draftItem.recipientId,
					documentId: draftItem.documentId,
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
			await reloadAuthoringSurface();
		} catch (cause) {
			sendError = cause instanceof EnvelopesApiError ? cause.detail : m.envelope_send_unavailable();
		} finally {
			sendPending = false;
		}
	}

	async function importDocx(file: File | null): Promise<void> {
		if (file === null || draft === null || importPending) return;
		const sourceName = file.name.replace(/\.docx$/i, '');
		const slug = sourceName
			.trim()
			.toLowerCase()
			.replaceAll(/[^a-z0-9._-]+/g, '-')
			.replace(/^-+|-+$/g, '');
		const targetPath = uniqueImportedDocumentPath(slug.length > 0 ? slug : 'imported');
		importPending = true;
		importError = null;
		try {
			await client.importDocx(envelopeId, {
				expectedGeneration: draft.generation,
				targetPath,
				file
			});
			activeDocPath = targetPath;
			activeDocumentKey = `pending:${targetPath}`;
			await reloadAuthoringSurface();
			const importedDocument = draft?.documentSet?.documents.find(
				(document) => document.kind === 'markdown' && document.path === targetPath
			);
			activeDocumentKey =
				importedDocument !== undefined ? `set:${importedDocument.id}` : `pending:${targetPath}`;
		} catch (cause) {
			importError =
				cause instanceof EnvelopesApiError ? cause.detail : m.envelope_import_unavailable();
		} finally {
			importPending = false;
		}
	}

	function uniqueImportedDocumentPath(slug: string): `documents/${string}.md` {
		const occupied = new Set<string>([
			...Object.keys(editedContent),
			...(draft?.documentSet?.documents.flatMap((document) =>
				document.kind === 'markdown' ? [document.path] : []
			) ?? [])
		]);
		let suffix = 1;
		let path = `documents/${slug}.md` as `documents/${string}.md`;
		while (occupied.has(path)) {
			suffix += 1;
			path = `documents/${slug}-${suffix}.md`;
		}
		return path;
	}

	async function exportDocx(): Promise<void> {
		if (exportPending) return;
		exportPending = true;
		exportError = null;
		try {
			const exported = await client.exportDocx(envelopeId);
			const body = new Uint8Array(exported.bytes.byteLength);
			body.set(exported.bytes);
			const blob = new Blob([body], {
				type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
			});
			const href = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = href;
			link.download = exported.filename;
			link.click();
			URL.revokeObjectURL(href);
		} catch (cause) {
			exportError =
				cause instanceof EnvelopesApiError ? cause.detail : m.envelope_export_unavailable();
		} finally {
			exportPending = false;
		}
	}

	function triggerDownload(content: BlobPart, filename: string, type: string): void {
		const blob = new Blob([content], { type });
		const href = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = href;
		link.download = filename;
		link.click();
		URL.revokeObjectURL(href);
	}

	async function downloadCompletionPdf(): Promise<void> {
		if (completionPdfDownloadPending) return;
		completionPdfDownloadPending = true;
		completionDownloadError = null;
		try {
			const result = await client.completionPdf(envelopeId);
			const body = new Uint8Array(result.bytes.byteLength);
			body.set(result.bytes);
			triggerDownload(body, result.filename, 'application/pdf');
		} catch (cause) {
			completionDownloadError =
				cause instanceof EnvelopesApiError ? cause.detail : m.envelope_completed_download_error();
		} finally {
			completionPdfDownloadPending = false;
		}
	}

	async function downloadCompletionEvidence(format: 'json' | 'markdown'): Promise<void> {
		if (completionEvidenceDownloadPending !== null) return;
		completionEvidenceDownloadPending = format;
		completionDownloadError = null;
		try {
			const result = await client.completionEvidence(envelopeId, format);
			triggerDownload(result.content, result.filename, result.contentType);
		} catch (cause) {
			completionDownloadError =
				cause instanceof EnvelopesApiError ? cause.detail : m.envelope_completed_download_error();
		} finally {
			completionEvidenceDownloadPending = null;
		}
	}

	async function uploadPdf(file: File | null): Promise<void> {
		if (file === null || draft === null || pdfUploadPending) return;
		pdfUploadPending = true;
		pdfUploadError = null;
		try {
			await client.uploadPdf(envelopeId, {
				expectedGeneration: draft.generation,
				file,
				title: file.name.replace(/\.pdf$/i, '')
			});
			await reloadAuthoringSurface();
		} catch (cause) {
			pdfUploadError =
				cause instanceof EnvelopesApiError ? cause.detail : m.envelope_pdf_upload_unavailable();
		} finally {
			pdfUploadPending = false;
		}
	}

	async function persistDocumentOrder(documentIds: readonly string[]): Promise<void> {
		if (draft === null || documentOrderPending) return;
		documentOrderPending = true;
		documentOrderError = null;
		try {
			await client.orderDocuments(envelopeId, {
				expectedGeneration: draft.generation,
				documentIds
			});
			await reloadAuthoringSurface();
		} catch (cause) {
			documentOrderError =
				cause instanceof EnvelopesApiError ? cause.detail : m.envelope_document_order_unavailable();
		} finally {
			documentOrderPending = false;
		}
	}

	function committedDocumentIds(): string[] {
		return (draft?.documentSet?.documents ?? []).map((leaf) => leaf.id);
	}

	async function moveCommittedDocument(documentId: string, direction: -1 | 1): Promise<void> {
		const ids = committedDocumentIds();
		const index = ids.indexOf(documentId);
		const next = index + direction;
		if (index < 0 || next < 0 || next >= ids.length) return;
		const swapped = [...ids];
		const current = swapped[index];
		swapped[index] = swapped[next];
		swapped[next] = current;
		await persistDocumentOrder(swapped);
	}

	async function confirmRemoveDocument(): Promise<void> {
		if (removeDocumentId === null) return;
		const remaining = committedDocumentIds().filter((id) => id !== removeDocumentId);
		if (remaining.length === 0) {
			removeDocumentId = null;
			removeDialogOpen = false;
			return;
		}
		const removedId = removeDocumentId;
		removeDocumentId = null;
		removeDialogOpen = false;
		await persistDocumentOrder(remaining);
		if (activeDocumentKey === `set:${removedId}`) {
			activeDocumentKey = remaining[0] !== undefined ? `set:${remaining[0]}` : null;
			activeDocPath = null;
		}
	}

	function removePendingMarkdown(path: string): void {
		const next = { ...editedContent };
		delete next[path];
		editedContent = next;
		dirtyPaths.delete(path);
		if (activeDocPath === path) {
			activeDocPath = Object.keys(next)[0] ?? null;
			activeDocumentKey = activeDocPath !== null ? `pending:${activeDocPath}` : null;
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
			await reloadAuthoringSurface();
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
	const placementReady = $derived(
		fieldPlacementReady({
			status: envelope?.status,
			hasSigners: signerRecipients().length > 0,
			pageMap: documentPages
		})
	);

	function draftsOnPage(page: number): readonly FieldDraft[] {
		const documentId = documentIdForPlacement();
		return fieldDrafts.filter(
			(draftItem) => draftItem.documentId === documentId && draftItem.geometry?.page === page
		);
	}

	function publishedOnPage(page: number): readonly PublicEnvelopeFieldResponse[] {
		const documentId = documentIdForPlacement();
		return placedFields.filter(
			(field) => field.documentId === documentId && field.geometry?.page === page
		);
	}

	function recipientName(recipientId: string): string {
		return readyRecipients.find((recipient) => recipient.id === recipientId)?.name ?? recipientId;
	}

	onMount(() => {
		void reloadAuthoringSurface();
	});

	$effect(() => {
		envelopeBreadcrumbTitle.set(envelope?.title.trim() || null);
		return () => envelopeBreadcrumbTitle.set(null);
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

<div class="flex w-full flex-col gap-6">
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
				<Button variant="outline" onclick={() => void reloadAuthoringSurface()}
					>{m.common_retry()}</Button
				>
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
							<div class="min-w-0">
								<Card.Title>{m.envelope_documents_title()}</Card.Title>
								<Card.Description>{m.envelope_documents_description()}</Card.Description>
							</div>
							<Button
								variant="outline"
								disabled={importPending || pdfUploadPending || draft === null}
								onclick={() => (addDocumentDialogOpen = true)}
							>
								{#if importPending || pdfUploadPending}
									<Spinner data-icon="inline-start" />
								{:else}
									<IconPlus data-icon="inline-start" />
								{/if}
								{m.envelope_add_document()}
							</Button>
						</Card.Header>
						<Card.Content class="flex flex-col gap-4">
							<Dialog.Root bind:open={addDocumentDialogOpen}>
								<Dialog.Content closeLabel={m.common_cancel()}>
									<Dialog.Header>
										<Dialog.Title>{m.envelope_add_document_title()}</Dialog.Title>
										<Dialog.Description>{m.envelope_add_document_description()}</Dialog.Description>
									</Dialog.Header>
									<div class="flex flex-col gap-3">
										<Button
											variant="outline"
											class="h-auto justify-start py-4"
											onclick={() => pdfInput?.click()}
										>
											<IconFileTypePdf data-icon="inline-start" />
											{m.envelope_upload_pdf_action()}
										</Button>
										<Button
											variant="outline"
											class="h-auto justify-start py-4"
											onclick={() => docxInput?.click()}
										>
											<IconFileTypeDocx data-icon="inline-start" />
											{m.envelope_upload_docx_action()}
										</Button>
									</div>
									<Input
										bind:ref={pdfInput}
										class="sr-only"
										type="file"
										accept="application/pdf,.pdf"
										aria-label={m.envelope_upload_pdf_action()}
										onchange={(event) => {
											const file = event.currentTarget.files?.[0] ?? null;
											event.currentTarget.value = '';
											addDocumentDialogOpen = false;
											void uploadPdf(file);
										}}
									/>
									<Input
										bind:ref={docxInput}
										class="sr-only"
										type="file"
										accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
										aria-label={m.envelope_upload_docx_action()}
										onchange={(event) => {
											const file = event.currentTarget.files?.[0] ?? null;
											event.currentTarget.value = '';
											addDocumentDialogOpen = false;
											void importDocx(file);
										}}
									/>
								</Dialog.Content>
							</Dialog.Root>

							{#if authoringDocuments.length === 0}
								<p class="text-sm text-muted-foreground">{m.envelope_documents_empty()}</p>
							{:else}
								<div class="flex flex-col gap-2">
									{#each authoringDocuments as entry, index (entry.key)}
										<div class="flex flex-wrap items-center gap-2">
											<Button
												size="sm"
												variant={activeDocumentKey === entry.key ? 'default' : 'outline'}
												onclick={() => selectAuthoringDocument(entry)}
											>
												{authoringDocumentTitle(entry)}
												{#if entry.source === 'pending' && dirtyPaths.has(entry.path)}
													<span class="ml-1 text-xs">•</span>
												{/if}
											</Button>
											<Badge variant="secondary">
												{entry.source === 'set' && entry.leaf.kind === 'pdf'
													? m.envelope_document_kind_pdf()
													: m.envelope_document_kind_markdown()}
											</Badge>
											{#if entry.source === 'set'}
												<Button
													size="sm"
													variant="ghost"
													disabled={documentOrderPending || index === 0}
													onclick={() => void moveCommittedDocument(entry.leaf.id, -1)}
												>
													<IconChevronUp />
													<span class="sr-only">{m.envelope_document_move_up()}</span>
												</Button>
												<Button
													size="sm"
													variant="ghost"
													disabled={documentOrderPending ||
														index >= committedDocumentIds().length - 1}
													onclick={() => void moveCommittedDocument(entry.leaf.id, 1)}
												>
													<IconChevronDown />
													<span class="sr-only">{m.envelope_document_move_down()}</span>
												</Button>
												<Button
													size="sm"
													variant="ghost"
													disabled={documentOrderPending || committedDocumentIds().length < 2}
													onclick={() => {
														removeDocumentId = entry.leaf.id;
														removeDialogOpen = true;
													}}
												>
													<IconTrash />
													<span class="sr-only">{m.envelope_document_remove()}</span>
												</Button>
											{:else}
												<Button
													size="sm"
													variant="ghost"
													onclick={() => removePendingMarkdown(entry.path)}
												>
													<IconTrash />
													<span class="sr-only">{m.envelope_document_remove()}</span>
												</Button>
											{/if}
										</div>
									{/each}
								</div>

								{#if activePdfLeaf !== null && activePdfLeaf.kind === 'pdf'}
									<div class="rounded-2xl border p-4">
										<div class="flex items-center gap-2">
											<span class="text-sm font-medium">{activePdfLeaf.title}</span>
											<Badge variant="secondary">{m.envelope_document_kind_pdf()}</Badge>
										</div>
										<p class="mt-2 text-sm text-muted-foreground">
											{m.envelope_pdf_pages_label({ count: String(activePdfLeaf.pageCount) })}
										</p>
										<p class="mt-1 font-mono text-xs text-muted-foreground">
											{m.envelope_pdf_digest_label({
												digest: `${activePdfLeaf.sha256.slice(0, 12)}…`
											})}
										</p>
									</div>
								{:else if activeDocPath !== null}
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
													<!-- Shown only when the document actually contains them, and
													     shown here because this is where an author can still fix it. -->
													{#if preview.hasVisibleUnicodeControls}
														<p class="mt-3 text-xs font-medium text-amber-700 dark:text-amber-300">
															{m.envelope_document_unicode_warning()}
														</p>
													{/if}
												{/if}
											</div>
										</div>
									</div>
								{/if}
							{/if}

							{#if documentOrderError}
								<p class="text-sm font-medium text-destructive" role="alert">
									{documentOrderError}
								</p>
							{/if}
							{#if commitError}
								<p class="text-sm font-medium text-destructive" role="alert">{commitError}</p>
							{/if}
							{#if pdfUploadError}
								<p class="text-sm font-medium text-destructive" role="alert">{pdfUploadError}</p>
							{/if}
							{#if importError}
								<p class="text-sm font-medium text-destructive" role="alert">{importError}</p>
							{/if}
							{#if exportError}
								<p class="text-sm font-medium text-destructive" role="alert">{exportError}</p>
							{/if}
							<AlertDialog.Root bind:open={removeDialogOpen}>
								<AlertDialog.Content>
									<AlertDialog.Header>
										<AlertDialog.Title>{m.envelope_document_remove_title()}</AlertDialog.Title>
										<AlertDialog.Description>
											{m.envelope_document_remove_description()}
										</AlertDialog.Description>
									</AlertDialog.Header>
									<AlertDialog.Footer>
										<AlertDialog.Cancel disabled={documentOrderPending}
											>{m.common_cancel()}</AlertDialog.Cancel
										>
										<AlertDialog.Action
											disabled={documentOrderPending}
											onclick={(event) => {
												event.preventDefault();
												void confirmRemoveDocument();
											}}
										>
											{#if documentOrderPending}<Spinner data-icon="inline-start" />{/if}
											{m.envelope_document_remove()}
										</AlertDialog.Action>
									</AlertDialog.Footer>
								</AlertDialog.Content>
							</AlertDialog.Root>
						</Card.Content>
						<Card.Footer class="justify-end gap-2 border-t bg-muted/20 py-4">
							<Button
								variant="outline"
								disabled={exportPending ||
									(draft?.commitSha == null && envelope.repositoryHead == null)}
								onclick={() => void exportDocx()}
							>
								{#if exportPending}
									<Spinner data-icon="inline-start" />
								{:else}
									<IconDownload data-icon="inline-start" />
								{/if}
								{m.envelope_export_docx()}
							</Button>
							<Button disabled={dirtyPaths.size === 0 || commitPending} onclick={commitChanges}>
								{#if commitPending}<Spinner data-icon="inline-start" />{/if}
								{m.envelope_commit_action({ count: String(dirtyPaths.size) })}
							</Button>
						</Card.Footer>
					</Card.Root>
				{:else if draft !== null}
					<div class="flex flex-col gap-4">
						<div class="flex justify-end">
							<Button variant="outline" disabled={exportPending} onclick={() => void exportDocx()}>
								{#if exportPending}
									<Spinner data-icon="inline-start" />
								{:else}
									<IconDownload data-icon="inline-start" />
								{/if}
								{m.envelope_export_docx()}
							</Button>
						</div>
						{#if exportError}
							<p class="text-sm font-medium text-destructive" role="alert">{exportError}</p>
						{/if}
						{#each draft.documents as document (document.path)}
							{@const title = documentTitle(document.path)}
							{@const rendered = renderRecipientMarkdown(document.content)}
							<Card.Root>
								<!-- A document with no readable authored title renders no header at
								     all, rather than an empty one: an empty header leaves a band of
								     padding above the text that reads like a layout bug. -->
								{#if title.length > 0}
									<Card.Header>
										<Card.Title>{title}</Card.Title>
									</Card.Header>
								{/if}
								<Card.Content class={title.length > 0 ? undefined : 'pt-6'}>
									<div class="prose max-w-none prose-neutral dark:prose-invert" dir="auto">
										{#each rendered.nodes as node, nodeIndex (nodeIndex)}
											{@render renderMarkdownNode(node)}
										{/each}
									</div>
									{#if rendered.hasVisibleUnicodeControls}
										<p class="mt-3 text-xs font-medium text-amber-700 dark:text-amber-300">
											{m.envelope_document_unicode_warning()}
										</p>
									{/if}
								</Card.Content>
							</Card.Root>
						{/each}
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">{m.envelope_documents_immutable()}</p>
				{/if}

				{#if envelope.status === 'completed'}
					<Card.Root>
						<Card.Header>
							<Card.Title>{m.envelope_completed_title()}</Card.Title>
							<Card.Description>{m.envelope_completed_description()}</Card.Description>
						</Card.Header>
						<Card.Content class="flex flex-col gap-4">
							{#if completionStatusError}
								<p class="text-sm font-medium text-destructive" role="alert">
									{completionStatusError}
								</p>
							{:else if completionStatus === null}
								<Skeleton class="h-9 w-48" />
							{:else if completionStatus.status === 'failed'}
								<p class="text-sm text-muted-foreground">{m.envelope_completed_status_failed()}</p>
							{:else if completionStatus.status === 'pending' || completionStatus.status === 'processing'}
								<p class="text-sm text-muted-foreground">{m.envelope_completed_status_pending()}</p>
							{:else if completionStatus.status === 'published'}
								{#if completionDownloadError}
									<p class="text-sm font-medium text-destructive" role="alert">
										{completionDownloadError}
									</p>
								{/if}
								{#if completionStatus.pdfStatus === 'published'}
									<Button
										variant="outline"
										class="w-fit"
										disabled={completionPdfDownloadPending}
										onclick={() => void downloadCompletionPdf()}
									>
										{#if completionPdfDownloadPending}
											<Spinner data-icon="inline-start" />
										{:else}
											<IconFileTypePdf data-icon="inline-start" />
										{/if}
										{m.envelope_completed_pdf_download()}
									</Button>
								{:else}
									<p class="text-sm text-muted-foreground">
										{completionStatus.pdfStatus === 'pending'
											? m.envelope_completed_pdf_pending()
											: m.envelope_completed_pdf_unavailable()}
									</p>
								{/if}
								<div class="flex flex-wrap gap-2">
									<Button
										variant="outline"
										disabled={completionEvidenceDownloadPending !== null}
										onclick={() => void downloadCompletionEvidence('json')}
									>
										{#if completionEvidenceDownloadPending === 'json'}
											<Spinner data-icon="inline-start" />
										{:else}
											<IconDownload data-icon="inline-start" />
										{/if}
										{m.envelope_completed_evidence_json_download()}
									</Button>
									<Button
										variant="outline"
										disabled={completionEvidenceDownloadPending !== null}
										onclick={() => void downloadCompletionEvidence('markdown')}
									>
										{#if completionEvidenceDownloadPending === 'markdown'}
											<Spinner data-icon="inline-start" />
										{:else}
											<IconDownload data-icon="inline-start" />
										{/if}
										{m.envelope_completed_evidence_markdown_download()}
									</Button>
								</div>
							{/if}
						</Card.Content>
					</Card.Root>
				{/if}
			</Tabs.Content>

			<Tabs.Content value="recipients" class="flex flex-col gap-4">
				<Card.Root>
					<Card.Header class="flex-row items-center justify-between gap-3">
						<div class="min-w-0">
							<Card.Title>{m.envelope_recipients_title()}</Card.Title>
							<Card.Description>{m.envelope_recipients_description()}</Card.Description>
						</div>
						<Button variant="outline" onclick={() => (contactManagementOpen = true)}>
							<IconAddressBook data-icon="inline-start" />{m.contacts_manage_action()}
						</Button>
					</Card.Header>
					<Card.Content class="flex flex-col gap-4">
						{#if envelope.status === 'draft'}
							<Field.FieldGroup>
								<div class="overflow-x-auto">
									<Table.Root>
										<Table.Header>
											<Table.Row>
												<Table.Head>{m.contacts_search_results()}</Table.Head>
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
														<Field.Field>
															<Field.FieldTitle class="sr-only">
																{m.contacts_choose_action()}
															</Field.FieldTitle>
															<ContactCombobox
																label={m.contacts_choose_action()}
																onSelect={(contact) =>
																	applyContactToRecipient(draftItem.key, contact)}
															/>
														</Field.Field>
													</Table.Cell>
													<Table.Cell>
														<Field.Field data-invalid={recipientEmailErrorVisible(draftItem)}>
															<Field.FieldLabel
																class="contents"
																for={`recipient-email-${draftItem.key}`}
															>
																<span class="sr-only">{m.envelope_recipient_col_email()}</span>
															</Field.FieldLabel>
															<Input
																id={`recipient-email-${draftItem.key}`}
																type="email"
																maxlength={320}
																bind:value={draftItem.email}
																aria-invalid={recipientEmailErrorVisible(draftItem)}
																aria-describedby={recipientEmailErrorVisible(draftItem)
																	? `recipient-email-error-${draftItem.key}`
																	: undefined}
																oninput={() => markRecipientContactChanged(draftItem)}
																onblur={() => markRecipientEmailTouched(draftItem.key)}
																onkeydown={handleRecipientRowKeydown}
															/>
															{#if recipientEmailErrorVisible(draftItem)}
																<Field.FieldError id={`recipient-email-error-${draftItem.key}`}>
																	{m.envelope_recipient_email_invalid()}
																</Field.FieldError>
															{/if}
														</Field.Field>
													</Table.Cell>
													<Table.Cell>
														<Field.Field data-invalid={recipientNameErrorVisible(draftItem)}>
															<Field.FieldLabel
																class="contents"
																for={`recipient-name-${draftItem.key}`}
															>
																<span class="sr-only">{m.envelope_recipient_col_name()}</span>
															</Field.FieldLabel>
															<Input
																id={`recipient-name-${draftItem.key}`}
																maxlength={200}
																bind:value={draftItem.name}
																aria-invalid={recipientNameErrorVisible(draftItem)}
																aria-describedby={recipientNameErrorVisible(draftItem)
																	? `recipient-name-error-${draftItem.key}`
																	: undefined}
																oninput={() => markRecipientContactChanged(draftItem)}
																onblur={() => markRecipientNameTouched(draftItem.key)}
																onkeydown={handleRecipientRowKeydown}
															/>
															{#if recipientNameErrorVisible(draftItem)}
																<Field.FieldError id={`recipient-name-error-${draftItem.key}`}>
																	{m.envelope_recipient_name_required()}
																</Field.FieldError>
															{/if}
														</Field.Field>
													</Table.Cell>
													<Table.Cell>
														<Field.Field>
															<Field.FieldLabel
																class="contents"
																for={`recipient-role-${draftItem.key}`}
															>
																<span class="sr-only">{m.envelope_recipient_col_role()}</span>
															</Field.FieldLabel>
															<Select.Root type="single" bind:value={draftItem.role}>
																<Select.Trigger
																	id={`recipient-role-${draftItem.key}`}
																	class="w-full"
																	aria-label={m.envelope_recipient_col_role()}
																>
																	{recipientRoleLabel(draftItem.role)}
																</Select.Trigger>
																<Select.Content>
																	<Select.Group>
																		<Select.Item value="signer" label={m.signing_role_signer()}>
																			{m.signing_role_signer()}
																		</Select.Item>
																		<Select.Item value="approver" label={m.signing_role_approver()}>
																			{m.signing_role_approver()}
																		</Select.Item>
																		<Select.Item value="viewer" label={m.signing_role_viewer()}>
																			{m.signing_role_viewer()}
																		</Select.Item>
																		<Select.Item value="cc" label={m.envelope_role_cc()}>
																			{m.envelope_role_cc()}
																		</Select.Item>
																	</Select.Group>
																</Select.Content>
															</Select.Root>
														</Field.Field>
													</Table.Cell>
													<Table.Cell>
														<Field.Field>
															<Field.FieldLabel
																class="contents"
																for={`recipient-locale-${draftItem.key}`}
															>
																<span class="sr-only">{m.envelope_recipient_col_locale()}</span>
															</Field.FieldLabel>
															<Select.Root
																type="single"
																bind:value={draftItem.locale}
																onValueChange={() => markRecipientContactChanged(draftItem)}
															>
																<Select.Trigger
																	id={`recipient-locale-${draftItem.key}`}
																	class="w-full"
																	aria-label={m.envelope_recipient_col_locale()}
																>
																	{recipientLocaleLabel(draftItem.locale)}
																</Select.Trigger>
																<Select.Content>
																	<Select.Group>
																		<Select.Item value="en" label="English">English</Select.Item>
																		<Select.Item value="ja" label="日本語">日本語</Select.Item>
																	</Select.Group>
																</Select.Content>
															</Select.Root>
														</Field.Field>
													</Table.Cell>
													<Table.Cell>
														<Field.Field>
															<Field.FieldLabel
																class="contents"
																for={`recipient-order-${draftItem.key}`}
															>
																<span class="sr-only">{m.envelope_recipient_col_order()}</span>
															</Field.FieldLabel>
															<Input
																id={`recipient-order-${draftItem.key}`}
																type="number"
																min="1"
																max="1000"
																value={draftItem.routingOrder}
																oninput={(event) => {
																	const parsed = Number(event.currentTarget.value);
																	if (Number.isFinite(parsed)) draftItem.routingOrder = parsed;
																}}
																class="w-20"
															/>
														</Field.Field>
													</Table.Cell>
													<Table.Cell>
														<div class="flex items-center justify-end gap-1">
															<Button
																size="sm"
																variant="outline"
																disabled={contactSavePending[draftItem.key] ||
																	!draftItem.email.trim() ||
																	!draftItem.name.trim()}
																onclick={() => void saveRecipientToContacts(draftItem)}
															>
																{#if contactSavePending[draftItem.key]}
																	<Spinner data-icon="inline-start" />
																{:else}
																	<IconAddressBook data-icon="inline-start" />
																{/if}
																{contactSaveSucceeded[draftItem.key]
																	? m.contacts_saved()
																	: m.contacts_save_recipient_action()}
															</Button>
															<Button
																size="icon"
																variant="ghost"
																aria-label={m.common_remove()}
																onclick={() => removeRecipientDraft(draftItem.key)}
															>
																<IconTrash />
															</Button>
														</div>
														{#if contactSaveError[draftItem.key]}
															<p class="mt-1 text-xs text-destructive" role="alert">
																{contactSaveError[draftItem.key]}
															</p>
														{/if}
													</Table.Cell>
												</Table.Row>
											{/each}
										</Table.Body>
									</Table.Root>
								</div>
								<Button variant="outline" onclick={addRecipientDraft} class="w-fit">
									<IconPlus data-icon="inline-start" />{m.envelope_add_recipient()}
								</Button>
							</Field.FieldGroup>
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
										<Table.Head>{m.envelope_recipient_col_locale()}</Table.Head>
										<Table.Head>{m.envelope_recipient_col_status()}</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each readyRecipients as recipient (recipient.id)}
										<Table.Row>
											<Table.Cell>{recipient.email}</Table.Cell>
											<Table.Cell>{recipient.name}</Table.Cell>
											<Table.Cell>{recipientRoleLabel(recipient.role)}</Table.Cell>
											<Table.Cell>{recipientLocaleLabel(recipient.locale)}</Table.Cell>
											<Table.Cell>{recipientWorkflowStatusLabel(recipient.status)}</Table.Cell>
										</Table.Row>
									{/each}
								</Table.Body>
							</Table.Root>
						{:else}
							<p class="text-sm text-muted-foreground">{m.envelope_recipients_empty()}</p>
						{/if}
					</Card.Content>
					{#if envelope.status === 'draft'}
						<Card.Footer class="justify-end border-t bg-muted/20 py-4">
							<Button
								disabled={recipientDrafts.length === 0 ||
									readyPending ||
									recipientsHaveInvalidIdentity}
								onclick={attemptMarkReady}
							>
								{#if readyPending}<Spinner data-icon="inline-start" />{/if}
								{m.envelope_mark_ready()}
							</Button>
						</Card.Footer>
					{/if}
				</Card.Root>
				<ContactManagementDialog bind:open={contactManagementOpen} />
			</Tabs.Content>

			<Tabs.Content value="fields" class="flex flex-col gap-4">
				{#if envelope.status !== 'ready'}
					<p class="text-sm text-muted-foreground">{m.envelope_fields_requires_ready()}</p>
				{:else if signerRecipients().length === 0}
					<p class="text-sm text-muted-foreground">{m.envelope_recipients_empty()}</p>
				{:else if documentPages === null}
					{#if documentPagesLoading}
						<Skeleton class="h-64 w-full rounded-2xl" />
					{:else}
						<Card.Root>
							<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
								<p class="text-sm font-medium text-destructive">
									{m.signing_document_error_description()}
								</p>
								<Button variant="outline" onclick={() => void loadDocumentPages()}>
									{m.common_retry()}
								</Button>
							</Card.Content>
						</Card.Root>
					{/if}
				{:else}
					<Card.Root>
						<Card.Header>
							<Card.Title>{m.envelope_fields_title()}</Card.Title>
							<Card.Description>{m.envelope_fields_description()}</Card.Description>
						</Card.Header>
						<Card.Content class="flex flex-col gap-4">
							{#if placementLocked}
								<p class="text-sm text-muted-foreground" role="status">
									{m.envelope_fields_locked_notice()}
								</p>
							{:else}
								<Field.FieldGroup class="grid gap-3 sm:grid-cols-2">
									<Field.Field>
										<Field.FieldLabel for="field-recipient">
											{m.envelope_field_recipient_label()}
										</Field.FieldLabel>
										<Select.Root type="single" bind:value={newField.recipientId}>
											<Select.Trigger id="field-recipient" class="w-full">
												{signerRecipients().find(
													(recipient) => recipient.id === newField.recipientId
												)?.name ?? m.envelope_field_select_placeholder()}
											</Select.Trigger>
											<Select.Content>
												<Select.Group>
													{#each signerRecipients() as recipient (recipient.id)}
														<Select.Item value={recipient.id} label={recipient.name}>
															{recipient.name}
														</Select.Item>
													{/each}
												</Select.Group>
											</Select.Content>
										</Select.Root>
									</Field.Field>
									<Field.Field>
										<Field.FieldLabel for="field-type">
											{m.envelope_field_type_label()}
										</Field.FieldLabel>
										<Select.Root type="single" bind:value={newField.fieldType}>
											<Select.Trigger id="field-type" class="w-full">
												{fieldTypeLabel(newField.fieldType)}
											</Select.Trigger>
											<Select.Content>
												<Select.Group>
													<Select.Item value="signature" label={m.signing_field_type_signature()}>
														{m.signing_field_type_signature()}
													</Select.Item>
													<Select.Item value="initials" label={m.signing_field_type_initials()}>
														{m.signing_field_type_initials()}
													</Select.Item>
													<Select.Item value="text" label={m.signing_field_type_text()}>
														{m.signing_field_type_text()}
													</Select.Item>
													<Select.Item value="date" label={m.signing_field_type_date()}>
														{m.signing_field_type_date()}
													</Select.Item>
													<Select.Item value="checkbox" label={m.signing_field_type_checkbox()}>
														{m.signing_field_type_checkbox()}
													</Select.Item>
												</Select.Group>
											</Select.Content>
										</Select.Root>
									</Field.Field>
									<Field.Field>
										<Field.FieldLabel for="field-label">
											{m.envelope_field_label_label()}
										</Field.FieldLabel>
										<Input id="field-label" bind:value={newField.label} maxlength={200} />
									</Field.Field>
									<Field.Field orientation="horizontal">
										<Checkbox id="field-required" bind:checked={newField.required} />
										<Field.FieldLabel for="field-required" class="font-normal">
											{m.signing_field_required()}
										</Field.FieldLabel>
									</Field.Field>
								</Field.FieldGroup>
							{/if}

							<div class="flex flex-col gap-3">
								<div>
									<p class="text-sm font-medium">{m.envelope_placement_title()}</p>
									<p class="text-xs text-muted-foreground">
										{m.envelope_placement_description()}
									</p>
									{#if !placementLocked}
										<p class="mt-1 text-xs text-muted-foreground">
											{m.envelope_placement_keyboard_hint()}
										</p>
									{/if}
								</div>
								{#if !placementLocked}
									{#if newField.recipientId === ''}
										<p class="text-sm text-muted-foreground">
											{m.envelope_placement_needs_signer()}
										</p>
									{:else}
										<div class="flex flex-wrap items-end gap-3">
											<Field.Field class="w-24">
												<Field.FieldLabel for="field-add-page">
													{m.envelope_field_geometry_page()}
												</Field.FieldLabel>
												<Input
													id="field-add-page"
													type="number"
													min="1"
													max={currentDocumentPageCount()}
													value={keyboardAddPage}
													oninput={(event) => {
														const parsed = Number(event.currentTarget.value);
														if (Number.isFinite(parsed)) keyboardAddPage = parsed;
													}}
												/>
											</Field.Field>
											<Button
												type="button"
												variant="outline"
												onclick={() => void addFieldViaKeyboard()}
											>
												<IconPlus data-icon="inline-start" />
												{m.envelope_field_add_action()}
											</Button>
										</div>
									{/if}
								{/if}
								{#if documentPages !== null && documentPages.documents.length > 1}
									<nav class="flex flex-wrap gap-2" aria-label={m.envelope_document_switcher()}>
										{#each documentPages.documents as document (document.documentId)}
											<Button
												size="sm"
												variant={documentIdForPlacement() === document.documentId
													? 'default'
													: 'outline'}
												onclick={() => {
													selectedFieldKey = null;
													selectedPublishedFieldId = null;
													keyboardAddPage = 1;
													selectedPlacementDocumentId = document.documentId;
													void loadDocumentPages();
												}}
											>
												{document.title}
												<Badge class="ml-1" variant="secondary">{document.kind}</Badge>
											</Button>
										{/each}
									</nav>
								{/if}
								{#key `${envelopeId}:${documentIdForPlacement() ?? ''}`}
									<PdfDocumentView
										src={documentIdForPlacement() === null
											? ''
											: `/api/v1/envelopes/${envelopeId}/document-pdf?documentId=${encodeURIComponent(documentIdForPlacement() ?? '')}`}
										label={m.signing_document_label()}
										expectedPageCount={documentPages?.pageCount ?? 1}
										loadingLabel={m.signing_document_loading()}
										errorTitle={m.signing_document_error_title()}
										errorDescription={m.signing_document_error_description()}
										openLabel={m.signing_document_open()}
									>
										{#snippet overlay(page: PdfRenderedPage)}
											<!-- svelte-ignore a11y_no_static_element_interactions -->
											<!-- svelte-ignore a11y_click_events_have_key_events -->
											<div
												class="absolute inset-0"
												class:cursor-crosshair={!placementLocked &&
													placementReady &&
													newField.recipientId !== ''}
												aria-label={m.envelope_field_geometry_page_aria()}
												onclick={(event) => handlePageClick(event, page.pageNumber)}
											>
												{#each publishedOnPage(page.pageNumber) as field (field.id)}
													{#if field.geometry}
														<button
															type="button"
															id={`field-box-${field.id}`}
															aria-label={m.envelope_placement_box_label({
																label: fieldTypeLabel(field.fieldType),
																recipient: recipientName(field.recipientId),
																page: String(field.geometry.page)
															})}
															aria-pressed={selectedPublishedFieldId === field.id}
															class="absolute rounded border-2 border-dashed border-muted-foreground/60 bg-muted/40 text-[10px] text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
															class:ring-2={selectedPublishedFieldId === field.id}
															style={`left:${field.geometry.x * 100}%;top:${field.geometry.y * 100}%;width:${field.geometry.width * 100}%;height:${field.geometry.height * 100}%;`}
															onclick={(event) => {
																event.stopPropagation();
																togglePublishedFieldSelection(field.id);
															}}
														>
															<span class="block truncate px-1">
																{fieldTypeLabel(field.fieldType)}
															</span>
														</button>
													{/if}
												{/each}
												{#each draftsOnPage(page.pageNumber) as fieldDraft (fieldDraft.key)}
													{#if fieldDraft.geometry}
														<button
															type="button"
															id={`field-box-${fieldDraft.key}`}
															aria-label={m.envelope_placement_box_label({
																label: fieldDraft.label,
																recipient: recipientName(fieldDraft.recipientId),
																page: String(fieldDraft.geometry.page)
															})}
															aria-pressed={selectedFieldKey === fieldDraft.key}
															class="absolute cursor-move touch-none rounded border-2 border-primary bg-primary/20 text-[10px] font-medium text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
															class:ring-2={selectedFieldKey === fieldDraft.key}
															style={`left:${fieldDraft.geometry.x * 100}%;top:${fieldDraft.geometry.y * 100}%;width:${fieldDraft.geometry.width * 100}%;height:${fieldDraft.geometry.height * 100}%;`}
															onpointerdown={(event) => startDrag(event, fieldDraft.key, 'move')}
															onpointermove={continueDrag}
															onpointerup={endDrag}
															onpointercancel={endDrag}
															onkeydown={(event) => handleFieldKeydown(event, fieldDraft.key)}
															onfocus={() => {
																selectedFieldKey = fieldDraft.key;
																selectedPublishedFieldId = null;
															}}
															onclick={(event) => event.stopPropagation()}
														>
															<span class="block truncate px-1">{fieldDraft.label}</span>
															<span
																role="presentation"
																class="absolute right-0 bottom-0 size-3 cursor-se-resize touch-none rounded-sm bg-primary"
																onpointerdown={(event) =>
																	startDrag(event, fieldDraft.key, 'resize')}
																onpointermove={continueDrag}
																onpointerup={endDrag}
																onpointercancel={endDrag}
															></span>
														</button>
													{/if}
												{/each}
											</div>
										{/snippet}
									</PdfDocumentView>
								{/key}
								<div class="sr-only" role="status" aria-live="polite">{geometryAnnouncement}</div>
							</div>

							{#if selectedFieldPanel}
								<Field.FieldSet>
									<Field.FieldLegend variant="label">
										{m.envelope_field_geometry_label()}
									</Field.FieldLegend>
									<Field.FieldDescription>
										{selectedFieldPanel.editable
											? m.envelope_field_geometry_description()
											: m.envelope_field_geometry_readonly()}
									</Field.FieldDescription>
									<Field.FieldGroup class="grid gap-3 sm:grid-cols-5">
										<Field.Field data-disabled={!selectedFieldPanel.editable}>
											<Field.FieldLabel for="selected-field-page">
												{m.envelope_field_geometry_page()}
											</Field.FieldLabel>
											<Input
												id="selected-field-page"
												type="number"
												min="1"
												max={currentDocumentPageCount()}
												readonly={!selectedFieldPanel.editable}
												aria-readonly={!selectedFieldPanel.editable}
												value={selectedFieldPanel.geometry.page}
												oninput={(event) => updateSelectedPage(Number(event.currentTarget.value))}
											/>
										</Field.Field>
										<Field.Field data-disabled={!selectedFieldPanel.editable}>
											<Field.FieldLabel for="selected-field-left">
												{m.envelope_field_geometry_left()}
											</Field.FieldLabel>
											<Input
												id="selected-field-left"
												type="number"
												min="0"
												max="100"
												step="0.1"
												readonly={!selectedFieldPanel.editable}
												aria-readonly={!selectedFieldPanel.editable}
												value={selectedGeometryDisplayValue('x', selectedFieldPanel.geometry)}
												oninput={(event) =>
													handleSelectedGeometryPercentInput('x', event.currentTarget.value)}
												onblur={() => commitSelectedGeometryPercentInput('x')}
											/>
										</Field.Field>
										<Field.Field data-disabled={!selectedFieldPanel.editable}>
											<Field.FieldLabel for="selected-field-top">
												{m.envelope_field_geometry_top()}
											</Field.FieldLabel>
											<Input
												id="selected-field-top"
												type="number"
												min="0"
												max="100"
												step="0.1"
												readonly={!selectedFieldPanel.editable}
												aria-readonly={!selectedFieldPanel.editable}
												value={selectedGeometryDisplayValue('y', selectedFieldPanel.geometry)}
												oninput={(event) =>
													handleSelectedGeometryPercentInput('y', event.currentTarget.value)}
												onblur={() => commitSelectedGeometryPercentInput('y')}
											/>
										</Field.Field>
										<Field.Field data-disabled={!selectedFieldPanel.editable}>
											<Field.FieldLabel for="selected-field-width">
												{m.envelope_field_geometry_width()}
											</Field.FieldLabel>
											<Input
												id="selected-field-width"
												type="number"
												min={MIN_FIELD_SIZE * 100}
												max="100"
												step="0.1"
												readonly={!selectedFieldPanel.editable}
												aria-readonly={!selectedFieldPanel.editable}
												value={selectedGeometryDisplayValue('width', selectedFieldPanel.geometry)}
												oninput={(event) =>
													handleSelectedGeometryPercentInput('width', event.currentTarget.value)}
												onblur={() => commitSelectedGeometryPercentInput('width')}
											/>
										</Field.Field>
										<Field.Field data-disabled={!selectedFieldPanel.editable}>
											<Field.FieldLabel for="selected-field-height">
												{m.envelope_field_geometry_height()}
											</Field.FieldLabel>
											<Input
												id="selected-field-height"
												type="number"
												min={MIN_FIELD_SIZE * 100}
												max="100"
												step="0.1"
												readonly={!selectedFieldPanel.editable}
												aria-readonly={!selectedFieldPanel.editable}
												value={selectedGeometryDisplayValue('height', selectedFieldPanel.geometry)}
												oninput={(event) =>
													handleSelectedGeometryPercentInput('height', event.currentTarget.value)}
												onblur={() => commitSelectedGeometryPercentInput('height')}
											/>
										</Field.Field>
									</Field.FieldGroup>
								</Field.FieldSet>
							{/if}

							{#if !placementLocked && fieldDrafts.length > 0}
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
												<Table.Cell>{placedDocumentTitle(fieldDraft.documentId)}</Table.Cell>
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
						{#if !placementLocked}
							<Card.Footer class="justify-end border-t bg-muted/20 py-4">
								<Button
									disabled={fieldDrafts.length === 0 || placementPending}
									onclick={() => void publishFields()}
								>
									{#if placementPending}<Spinner data-icon="inline-start" />{/if}
									{m.envelope_publish_fields()}
								</Button>
							</Card.Footer>
						{/if}
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

						{#if delivery !== null && delivery.deliveries.length > 0}
							<Table.Root>
								<Table.Header>
									<Table.Row>
										<Table.Head>{m.envelope_delivery_col_recipient()}</Table.Head>
										<Table.Head>{m.envelope_delivery_col_role()}</Table.Head>
										<Table.Head>{m.envelope_delivery_col_status()}</Table.Head>
									</Table.Row>
								</Table.Header>
								<Table.Body>
									{#each delivery.deliveries as item (item.recipientId)}
										{@const matched = recipientForDelivery(item.recipientId)}
										<Table.Row>
											<Table.Cell>
												{#if matched}
													<div class="flex flex-col">
														<span>{matched.name}</span>
														<span class="text-muted-foreground">{matched.email}</span>
													</div>
												{/if}
											</Table.Cell>
											<Table.Cell>
												{recipientRoleLabel(matched?.role ?? item.recipientRole)}
											</Table.Cell>
											<Table.Cell>
												<Badge variant="secondary">{deliveryStateLabel(item.status)}</Badge>
											</Table.Cell>
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
