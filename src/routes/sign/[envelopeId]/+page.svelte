<script lang="ts" module>
	import { isProblemOfType, SIGNED_ASSET_EXPIRED_PROBLEM } from '$lib/components/signature-draft';
	import { defaultNewIdempotencyKey } from '$lib/client/http-problem';

	export interface RecipientViewOptions {
		envelopeId: string;
		recipientId: string;
		initialStatus: string;
		pageState: string;
		onStatusChange?: (status: string) => void;
		onRecorded?: () => void;
		onRetryPendingChange?: (pending: boolean) => void;
		onTerminalFailure?: () => void;
		fetch?: typeof fetch;
		/** Mints the opaque `Idempotency-Key`; defaults to a UUIDv4. */
		newIdempotencyKey?: () => string;
		document?: {
			visibilityState: DocumentVisibilityState;
			addEventListener: (type: string, listener: (event?: unknown) => void) => void;
			removeEventListener: (type: string, listener: (event?: unknown) => void) => void;
		};
		window?: {
			addEventListener: (type: string, listener: (event?: unknown) => void) => void;
			removeEventListener: (type: string, listener: (event?: unknown) => void) => void;
		};
	}

	export function initRecipientViewed({
		envelopeId,
		recipientId,
		initialStatus,
		pageState,
		onStatusChange,
		onRecorded,
		onRetryPendingChange,
		onTerminalFailure,
		fetch: customFetch,
		newIdempotencyKey: customNewIdempotencyKey,
		document: customDocument,
		window: customWindow
	}: RecipientViewOptions): () => void {
		if (pageState !== 'active' || initialStatus !== 'pending') {
			return () => {};
		}

		const fetchFn = customFetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
		const doc = customDocument ?? (typeof document !== 'undefined' ? document : undefined);
		const win = customWindow ?? (typeof window !== 'undefined' ? window : undefined);
		const generateIdempotencyKey = customNewIdempotencyKey ?? defaultNewIdempotencyKey;

		const idempotencyKey = generateIdempotencyKey();
		let inFlight = false;
		let isTerminal = false;
		const abortController = new AbortController();

		async function triggerView(): Promise<void> {
			if (isTerminal || inFlight) return;
			if (doc && 'visibilityState' in doc && doc.visibilityState !== 'visible') {
				return;
			}
			if (!fetchFn) return;

			inFlight = true;
			try {
				const response = await postSigningAction(
					fetchFn,
					'/api/v1/signing/viewed',
					{ envelopeId, recipientId },
					idempotencyKey,
					abortController.signal
				);

				if (response.ok) {
					isTerminal = true;
					onStatusChange?.('viewed');
					onRetryPendingChange?.(false);
					onRecorded?.();
					cleanupListeners();
					return;
				}

				if (response.status === 404 || isPermanentClientFailure(response)) {
					isTerminal = true;
					onRetryPendingChange?.(false);
					if (response.status !== 404) onTerminalFailure?.();
					cleanupListeners();
					return;
				}

				onRetryPendingChange?.(true);
			} catch {
				if (abortController.signal.aborted) return;
				onRetryPendingChange?.(true);
			} finally {
				inFlight = false;
			}
		}

		const onVisibilityChange = (): void => {
			if (!doc || !('visibilityState' in doc) || doc.visibilityState === 'visible') {
				void triggerView();
			}
		};

		const onOnline = (): void => {
			if (doc && 'visibilityState' in doc && doc.visibilityState !== 'visible') {
				return;
			}
			void triggerView();
		};

		function cleanupListeners(): void {
			doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
			win?.removeEventListener?.('online', onOnline);
		}

		doc?.addEventListener?.('visibilitychange', onVisibilityChange);
		win?.addEventListener?.('online', onOnline);

		if (!doc || !('visibilityState' in doc) || doc.visibilityState === 'visible') {
			void triggerView();
		}

		return () => {
			abortController.abort();
			cleanupListeners();
		};
	}

	export function isPermanentClientFailure(response: Response): boolean {
		if (response.status < 400 || response.status >= 500) return false;
		if (response.status === 408 || response.status === 429) return false;
		return response.status !== 409 || !response.headers.has('retry-after');
	}

	/**
	 * POSTs a recipient signing action with the standard JSON content-type,
	 * idempotency key, and same-origin credentials. Each caller supplies its
	 * own body shape and interprets the raw `Response` itself.
	 */
	function postSigningAction(
		fetchFn: typeof fetch,
		path: string,
		body: Record<string, unknown>,
		idempotencyKey: string,
		signal: AbortSignal
	): Promise<Response> {
		return fetchFn(path, {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				'content-type': 'application/json',
				'idempotency-key': idempotencyKey
			},
			body: JSON.stringify(body),
			signal
		});
	}

	export type RecipientDeclineStatus =
		'idle' | 'pending' | 'transient_failure' | 'terminal_failure' | 'success';

	export interface RecipientDeclineOptions {
		envelopeId: string;
		recipientId: string;
		role: string;
		pageState: string;
		fetch?: typeof fetch;
		/** Mints the opaque `Idempotency-Key`; defaults to a UUIDv4. */
		newIdempotencyKey?: () => string;
		onStatusChange?: (status: RecipientDeclineStatus) => void;
		onSuccess?: () => void;
		onTransientFailure?: () => void;
		onAmbiguousFailure?: () => void;
		onTerminalFailure?: () => void;
	}

	export interface RecipientDeclineController {
		confirmDecline(): Promise<void>;
		getStatus(): RecipientDeclineStatus;
		isInFlight(): boolean;
		getIdempotencyKey(): string | null;
		destroy(): void;
	}

	export function createRecipientDeclineController({
		envelopeId,
		recipientId,
		role,
		pageState,
		fetch: customFetch,
		newIdempotencyKey: customNewIdempotencyKey,
		onStatusChange,
		onSuccess,
		onTransientFailure,
		onAmbiguousFailure,
		onTerminalFailure
	}: RecipientDeclineOptions): RecipientDeclineController {
		let status: RecipientDeclineStatus = 'idle';
		let inFlight = false;
		let idempotencyKey: string | null = null;
		const abortController = new AbortController();

		const isActionableRole = role === 'signer' || role === 'approver';
		const canDecline = pageState === 'active' && isActionableRole;

		const fetchFn = customFetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
		const generateIdempotencyKey = customNewIdempotencyKey ?? defaultNewIdempotencyKey;

		async function confirmDecline(): Promise<void> {
			if (!canDecline || inFlight || status === 'success' || status === 'terminal_failure') {
				return;
			}
			if (!fetchFn) return;

			if (!idempotencyKey) {
				idempotencyKey = generateIdempotencyKey();
			}

			inFlight = true;
			status = 'pending';
			onStatusChange?.('pending');

			try {
				const response = await postSigningAction(
					fetchFn,
					'/api/v1/signing/decline',
					{ envelopeId, recipientId },
					idempotencyKey,
					abortController.signal
				);

				if (
					response.status === 200 &&
					(await isExpectedDeclinedReceipt(response, envelopeId, recipientId))
				) {
					status = 'success';
					onStatusChange?.('success');
					onSuccess?.();
					return;
				}

				if (response.status === 404 || isPermanentClientFailure(response)) {
					status = 'terminal_failure';
					onStatusChange?.('terminal_failure');
					onTerminalFailure?.();
					return;
				}

				status = 'transient_failure';
				onStatusChange?.('transient_failure');
				onTransientFailure?.();
				if (response.status === 200) onAmbiguousFailure?.();
			} catch {
				if (abortController.signal.aborted) return;
				status = 'transient_failure';
				onStatusChange?.('transient_failure');
				onTransientFailure?.();
				onAmbiguousFailure?.();
			} finally {
				inFlight = false;
			}
		}

		function destroy(): void {
			abortController.abort();
		}

		return {
			confirmDecline,
			getStatus: () => status,
			isInFlight: () => inFlight,
			getIdempotencyKey: () => idempotencyKey,
			destroy
		};
	}

	async function isExpectedDeclinedReceipt(
		response: Response,
		expectedEnvelopeId: string,
		expectedRecipientId: string
	): Promise<boolean> {
		const declined = await parseRecipientActionReceipt(
			response,
			expectedEnvelopeId,
			expectedRecipientId,
			{
				wrapperKey: 'declined',
				nestedKeys: [
					'declinedAt',
					'envelopeId',
					'envelopeStatus',
					'recipientId',
					'recipientStatus'
				],
				timestampKey: 'declinedAt',
				expectedRecipientStatus: 'declined',
				expectedEnvelopeStatuses: ['declined']
			}
		);
		return declined !== null;
	}

	export type RecipientApproveStatus =
		'idle' | 'pending' | 'transient_failure' | 'terminal_failure' | 'success';

	export interface RecipientApproveReceipt {
		envelopeId: string;
		recipientId: string;
		recipientStatus: string;
		envelopeStatus: string;
		approvedAt: string;
		replayed?: boolean;
	}

	export interface RecipientApproveOptions {
		envelopeId: string;
		recipientId: string;
		role: string;
		pageState: string;
		recipientStatus?: string | (() => string);
		fetch?: typeof fetch;
		/** Mints the opaque `Idempotency-Key`; defaults to a UUIDv4. */
		newIdempotencyKey?: () => string;
		onStatusChange?: (status: RecipientApproveStatus) => void;
		onSuccess?: (info?: { replayed: boolean; receipt?: RecipientApproveReceipt }) => void;
		onTransientFailure?: () => void;
		onTerminalFailure?: () => void;
	}

	export interface RecipientApproveController {
		confirmApprove(): Promise<void>;
		getStatus(): RecipientApproveStatus;
		isInFlight(): boolean;
		getIdempotencyKey(): string | null;
		isReplayed(): boolean;
		getReceipt(): RecipientApproveReceipt | null;
		destroy(): void;
	}

	export function createRecipientApproveController({
		envelopeId,
		recipientId,
		role,
		pageState,
		recipientStatus,
		fetch: customFetch,
		newIdempotencyKey: customNewIdempotencyKey,
		onStatusChange,
		onSuccess,
		onTransientFailure,
		onTerminalFailure
	}: RecipientApproveOptions): RecipientApproveController {
		let status: RecipientApproveStatus = 'idle';
		let inFlight = false;
		let idempotencyKey: string | null = null;
		let replayed = false;
		let receipt: RecipientApproveReceipt | null = null;
		const abortController = new AbortController();

		const getRecipientStatus =
			typeof recipientStatus === 'function' ? recipientStatus : () => recipientStatus;

		const fetchFn = customFetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
		const generateIdempotencyKey = customNewIdempotencyKey ?? defaultNewIdempotencyKey;

		async function confirmApprove(): Promise<void> {
			const currentRecipientStatus = getRecipientStatus();
			const canApprove =
				pageState === 'active' && role === 'approver' && currentRecipientStatus === 'viewed';
			if (!canApprove || inFlight || status === 'success' || status === 'terminal_failure') {
				return;
			}
			if (!fetchFn) return;

			if (!idempotencyKey) {
				idempotencyKey = generateIdempotencyKey();
			}
			inFlight = true;
			status = 'pending';
			onStatusChange?.('pending');

			try {
				const response = await postSigningAction(
					fetchFn,
					'/api/v1/signing/approve',
					{ envelopeId, recipientId },
					idempotencyKey,
					abortController.signal
				);

				if (response.status === 200) {
					const validated = await validateApprovedReceipt(response, envelopeId, recipientId);
					if (validated) {
						const isReplay = response.headers.get('idempotency-replayed') === 'true';
						replayed = isReplay;
						receipt = { ...validated, replayed: isReplay };
						status = 'success';
						onStatusChange?.('success');
						onSuccess?.({ replayed: isReplay, receipt });
						return;
					}
				}

				if (isPermanentClientFailure(response)) {
					status = 'terminal_failure';
					onStatusChange?.('terminal_failure');
					onTerminalFailure?.();
					return;
				}

				status = 'transient_failure';
				onStatusChange?.('transient_failure');
				onTransientFailure?.();
			} catch {
				if (abortController.signal.aborted) return;
				status = 'transient_failure';
				onStatusChange?.('transient_failure');
				onTransientFailure?.();
			} finally {
				inFlight = false;
			}
		}

		function destroy(): void {
			abortController.abort();
		}

		return {
			confirmApprove,
			getStatus: () => status,
			isInFlight: () => inFlight,
			getIdempotencyKey: () => idempotencyKey,
			isReplayed: () => replayed,
			getReceipt: () => receipt,
			destroy
		};
	}

	export async function validateApprovedReceipt(
		response: Response,
		expectedEnvelopeId: string,
		expectedRecipientId: string
	): Promise<RecipientApproveReceipt | null> {
		const approved = await parseRecipientActionReceipt(
			response,
			expectedEnvelopeId,
			expectedRecipientId,
			{
				wrapperKey: 'approved',
				nestedKeys: [
					'approvedAt',
					'envelopeId',
					'envelopeStatus',
					'recipientId',
					'recipientStatus'
				],
				timestampKey: 'approvedAt',
				expectedRecipientStatus: 'completed',
				expectedEnvelopeStatuses: ['completed', 'in_progress']
			}
		);
		if (approved === null) return null;
		const replayed = response.headers?.get?.('idempotency-replayed') === 'true';
		return {
			envelopeId: approved.envelopeId,
			recipientId: approved.recipientId,
			recipientStatus: approved.recipientStatus,
			envelopeStatus: approved.envelopeStatus,
			approvedAt: approved.timestamp,
			...(replayed ? { replayed: true } : {})
		};
	}

	export type RecipientSignStatus =
		| 'idle'
		| 'pending'
		| 'validation_failure'
		| 'transient_failure'
		| 'terminal_failure'
		| 'success';

	export interface RecipientSignFieldValue {
		fieldId: string;
		value: string | boolean;
	}

	export interface RecipientSignReceipt {
		envelopeId: string;
		recipientId: string;
		recipientStatus: string;
		envelopeStatus: string;
		signedAt: string;
		replayed?: boolean;
	}

	export interface RecipientSignOptions {
		envelopeId: string;
		recipientId: string;
		expectedFieldGeneration: number;
		role: string;
		pageState: string;
		recipientStatus?: string | (() => string);
		fetch?: typeof fetch;
		/** Mints the opaque `Idempotency-Key`; defaults to a UUIDv4. */
		newIdempotencyKey?: () => string;
		onStatusChange?: (status: RecipientSignStatus) => void;
		onSuccess?: (info?: { replayed: boolean; receipt?: RecipientSignReceipt }) => void;
		onTransientFailure?: () => void;
		onTerminalFailure?: () => void;
		/**
		 * The server explicitly refused a submitted drawn asset as retired. Only
		 * this resets the cached asset references; an ambiguous network failure
		 * keeps the original values and Idempotency-Key for a safe retry.
		 */
		onSignatureAssetExpired?: () => void;
	}

	export interface RecipientSignController {
		confirmSign(values: readonly RecipientSignFieldValue[]): Promise<void>;
		getStatus(): RecipientSignStatus;
		isInFlight(): boolean;
		getIdempotencyKey(): string | null;
		isReplayed(): boolean;
		getReceipt(): RecipientSignReceipt | null;
		destroy(): void;
	}

	export function createRecipientSignController({
		envelopeId,
		recipientId,
		expectedFieldGeneration,
		role,
		pageState,
		recipientStatus,
		fetch: customFetch,
		newIdempotencyKey: customNewIdempotencyKey,
		onStatusChange,
		onSuccess,
		onTransientFailure,
		onTerminalFailure,
		onSignatureAssetExpired
	}: RecipientSignOptions): RecipientSignController {
		let status: RecipientSignStatus = 'idle';
		let inFlight = false;
		let idempotencyKey: string | null = null;
		let submittedValues: readonly RecipientSignFieldValue[] | null = null;
		let replayed = false;
		let receipt: RecipientSignReceipt | null = null;
		const abortController = new AbortController();

		const getRecipientStatus =
			typeof recipientStatus === 'function' ? recipientStatus : () => recipientStatus;

		const fetchFn = customFetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
		const generateIdempotencyKey = customNewIdempotencyKey ?? defaultNewIdempotencyKey;

		async function confirmSign(values: readonly RecipientSignFieldValue[]): Promise<void> {
			const currentRecipientStatus = getRecipientStatus();
			const canSign =
				pageState === 'active' && role === 'signer' && currentRecipientStatus === 'viewed';
			if (!canSign || inFlight || status === 'success' || status === 'terminal_failure') {
				return;
			}
			if (!fetchFn) return;

			if (!idempotencyKey) {
				idempotencyKey = generateIdempotencyKey();
			}
			submittedValues ??= values.map((entry: RecipientSignFieldValue): RecipientSignFieldValue => ({
				fieldId: entry.fieldId,
				value: entry.value
			}));

			inFlight = true;
			status = 'pending';
			onStatusChange?.('pending');

			try {
				const response = await postSigningAction(
					fetchFn,
					'/api/v1/signing/sign',
					{ envelopeId, recipientId, expectedFieldGeneration, values: submittedValues },
					idempotencyKey,
					abortController.signal
				);

				if (response.status === 200) {
					const validated = await validateSignedReceipt(response, envelopeId, recipientId);
					if (validated) {
						const isReplay = response.headers.get('idempotency-replayed') === 'true';
						replayed = isReplay;
						receipt = { ...validated, replayed: isReplay };
						status = 'success';
						onStatusChange?.('success');
						onSuccess?.({ replayed: isReplay, receipt });
						return;
					}
				}

				if (response.status === 400 || response.status === 413) {
					idempotencyKey = null;
					submittedValues = null;
					status = 'validation_failure';
					onStatusChange?.('validation_failure');
					return;
				}

				if (await isProblemOfType(response, SIGNED_ASSET_EXPIRED_PROBLEM)) {
					// Nothing was recorded. The next attempt carries a re-drawn asset,
					// so it is a different command and needs a new key.
					idempotencyKey = null;
					submittedValues = null;
					status = 'validation_failure';
					onStatusChange?.('validation_failure');
					onSignatureAssetExpired?.();
					return;
				}

				if (isPermanentClientFailure(response)) {
					status = 'terminal_failure';
					onStatusChange?.('terminal_failure');
					onTerminalFailure?.();
					return;
				}

				status = 'transient_failure';
				onStatusChange?.('transient_failure');
				onTransientFailure?.();
			} catch {
				if (abortController.signal.aborted) return;
				status = 'transient_failure';
				onStatusChange?.('transient_failure');
				onTransientFailure?.();
			} finally {
				inFlight = false;
			}
		}

		function destroy(): void {
			abortController.abort();
		}

		return {
			confirmSign,
			getStatus: () => status,
			isInFlight: () => inFlight,
			getIdempotencyKey: () => idempotencyKey,
			isReplayed: () => replayed,
			getReceipt: () => receipt,
			destroy
		};
	}

	export async function validateSignedReceipt(
		response: Response,
		expectedEnvelopeId: string,
		expectedRecipientId: string
	): Promise<RecipientSignReceipt | null> {
		const signed = await parseRecipientActionReceipt(
			response,
			expectedEnvelopeId,
			expectedRecipientId,
			{
				wrapperKey: 'signed',
				nestedKeys: ['envelopeId', 'envelopeStatus', 'recipientId', 'recipientStatus', 'signedAt'],
				timestampKey: 'signedAt',
				expectedRecipientStatus: 'completed',
				expectedEnvelopeStatuses: ['completed', 'in_progress']
			}
		);
		if (signed === null) return null;
		const replayed = response.headers?.get?.('idempotency-replayed') === 'true';
		return {
			envelopeId: signed.envelopeId,
			recipientId: signed.recipientId,
			recipientStatus: signed.recipientStatus,
			envelopeStatus: signed.envelopeStatus,
			signedAt: signed.timestamp,
			...(replayed ? { replayed: true } : {})
		};
	}

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
		const keys: string[] = Object.keys(value).sort();
		return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
	}

	interface RecipientActionReceiptShape {
		readonly wrapperKey: string;
		readonly nestedKeys: readonly string[];
		readonly timestampKey: string;
		readonly expectedRecipientStatus: string;
		readonly expectedEnvelopeStatuses: readonly string[];
	}

	interface ValidatedRecipientActionReceipt {
		readonly envelopeId: string;
		readonly recipientId: string;
		readonly recipientStatus: string;
		readonly envelopeStatus: string;
		readonly timestamp: string;
	}

	/**
	 * Shared exact-key/context/timestamp/status check for a recipient action
	 * receipt. Each operation keeps its own wrapper key, timestamp field name,
	 * and expected status values; this only verifies the shape and that the
	 * envelope/recipient context matches what was requested.
	 */
	async function parseRecipientActionReceipt(
		response: Response,
		expectedEnvelopeId: string,
		expectedRecipientId: string,
		shape: RecipientActionReceiptShape
	): Promise<ValidatedRecipientActionReceipt | null> {
		if (response.status !== 200) return null;
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return null;
		}
		if (!isRecord(body) || !hasExactKeys(body, [shape.wrapperKey])) return null;
		const nested: unknown = body[shape.wrapperKey];
		if (!isRecord(nested) || !hasExactKeys(nested, shape.nestedKeys)) return null;
		const timestamp = nested[shape.timestampKey];
		if (
			nested.envelopeId !== expectedEnvelopeId ||
			nested.recipientId !== expectedRecipientId ||
			typeof timestamp !== 'string' ||
			!Number.isFinite(new Date(timestamp).getTime()) ||
			nested.recipientStatus !== shape.expectedRecipientStatus ||
			typeof nested.envelopeStatus !== 'string' ||
			!shape.expectedEnvelopeStatuses.includes(nested.envelopeStatus)
		) {
			return null;
		}
		return {
			envelopeId: expectedEnvelopeId,
			recipientId: expectedRecipientId,
			recipientStatus: shape.expectedRecipientStatus,
			envelopeStatus: nested.envelopeStatus,
			timestamp
		};
	}
</script>

<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount, tick, untrack } from 'svelte';
	import { IconAlertTriangle, IconCircleCheck, IconCircleX } from '@tabler/icons-svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import PdfDocumentView, { type PdfRenderedPage } from '$lib/components/pdf-document-view.svelte';
	import SignatureCanvas from '$lib/components/signature-canvas.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import { Progress } from '$lib/components/ui/progress';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import { isSignatureAssetRef } from '$lib/components/signature-draft';
	import type { RecipientPlacedField } from '$lib/application/signing/recipient-workspace';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let selectedDocumentId = $state<string | null>(null);

	/** Same-origin, cookie-authenticated. Deliberately carries no token. */
	const selectedDocument = $derived(
		data.state === 'active'
			? (data.documents.find((document) => document.documentId === selectedDocumentId) ??
					data.documents[0] ??
					null)
			: null
	);
	const agreementPdfPath: string = $derived(
		data.state === 'active' && selectedDocument !== null
			? data.source === 'legacy'
				? `/sign/${data.access.envelopeId}/agreement.pdf`
				: `/sign/${data.access.envelopeId}/documents/${selectedDocument.documentId}.pdf`
			: ''
	);

	let viewRecorded = $state(false);
	let liveMessage = $state('');
	let retryPending = $state(false);
	let viewFailed = $state(false);

	let declineStatus = $state<RecipientDeclineStatus>('idle');
	let declinePending = $state(false);
	let optimisticDecline = $state<{ envelopeId: string; recipientId: string } | null>(null);
	let isDeclined = $derived(
		data.state === 'active' &&
			optimisticDecline !== null &&
			optimisticDecline.envelopeId === data.access.envelopeId &&
			optimisticDecline.recipientId === data.access.recipientId
	);
	let dialogOpen = $state(false);
	let declineController: RecipientDeclineController | null = null;
	let declineControllerIdentity: string | null = null;

	let approveStatus = $state<RecipientApproveStatus>('idle');
	let approvePending = $state(false);
	let isApproved = $state(false);
	let approveDialogOpen = $state(false);
	let approveController: RecipientApproveController | null = null;

	let signStatus = $state<RecipientSignStatus>('idle');
	/** Set by an explicit retired-asset refusal; cleared when the next attempt starts. */
	let signatureAssetExpired = $state(false);
	let signPending = $state(false);
	let isSigned = $state(false);
	let signDialogOpen = $state(false);
	let signAttempted = $state(false);
	let signController: RecipientSignController | null = null;
	let fieldValues = $state<Record<string, string | boolean>>(
		untrack(() =>
			Object.fromEntries(
				(data.state === 'active' ? data.fields : []).map((field) => [
					field.id,
					field.fieldType === 'checkbox' ? false : ''
				])
			)
		)
	);

	let placedFields = $derived(data.state === 'active' ? data.fields : []);
	let isSigner = $derived(data.state === 'active' && data.access.role === 'signer');
	let isApprover = $derived(data.state === 'active' && data.access.role === 'approver');
	let canAct = $derived((isSigner || isApprover) && !isDeclined && !isSigned && !isApproved);
	let fieldsEditable = $derived(
		isSigner &&
			!isSigned &&
			!isDeclined &&
			signStatus !== 'pending' &&
			signStatus !== 'transient_failure'
	);

	function fieldsOnPage(pageNumber: number): readonly RecipientPlacedField[] {
		const documentId: string | null = selectedDocument?.documentId ?? null;
		return placedFields.filter(
			(field) =>
				field.geometry.page === pageNumber &&
				(documentId === null || field.documentId === documentId)
		);
	}

	const requiredFields = $derived(placedFields.filter((field) => field.required));
	const missingRequiredFields = $derived(
		requiredFields.filter((field) => isFieldValueMissing(field, fieldValues[field.id]))
	);
	let renderedDocumentId: string | null = null;
	let pendingFieldFocus: { fieldId: string; documentId: string } | null = null;

	function selectDocument(documentId: string): void {
		pendingFieldFocus = null;
		if (selectedDocument?.documentId !== documentId) renderedDocumentId = null;
		selectedDocumentId = documentId;
	}

	async function focusPendingField(): Promise<void> {
		const request = pendingFieldFocus;
		await tick();
		if (
			request === null ||
			request !== pendingFieldFocus ||
			data.state !== 'active' ||
			selectedDocument?.documentId !== request.documentId ||
			renderedDocumentId !== request.documentId ||
			!data.fields.some(
				(field) => field.id === request.fieldId && field.documentId === request.documentId
			)
		)
			return;
		const control = document.getElementById(request.fieldId);
		if (!(control instanceof HTMLElement)) return;
		pendingFieldFocus = null;
		control.focus({ preventScroll: true });
		control.scrollIntoView({ block: 'center', inline: 'nearest' });
	}

	function navigateToField(field: RecipientPlacedField): void {
		if (data.state !== 'active' || !fieldsEditable || field.documentId === null) return;
		if (selectedDocument?.documentId !== field.documentId) renderedDocumentId = null;
		selectedDocumentId = field.documentId;
		pendingFieldFocus = { fieldId: field.id, documentId: field.documentId };
		void focusPendingField();
	}

	function documentPagesReady(documentId: string | null): void {
		if (documentId !== selectedDocument?.documentId) return;
		renderedDocumentId = documentId;
		void focusPendingField();
	}

	function pageReadyHandler(documentId: string | null): () => void {
		return () => documentPagesReady(documentId);
	}

	function fieldDocumentTitle(field: RecipientPlacedField): string {
		return data.state === 'active'
			? (data.documents.find((document) => document.documentId === field.documentId)?.title ?? '')
			: '';
	}

	function roleLabel(role: string): string {
		if (role === 'signer') return m.signing_role_signer();
		if (role === 'approver') return m.signing_role_approver();
		if (role === 'viewer') return m.signing_role_viewer();
		return m.signing_role_prefill();
	}

	/**
	 * The recipient-facing completion status. `viewed` is audit evidence that a
	 * document was opened, not a statement that the recipient is done, so while
	 * a signature or approval is still outstanding this reports the action, not
	 * the observation.
	 */
	function statusLabel(status: string): string {
		if (status === 'declined') return m.signing_status_declined();
		if (status === 'signed') return m.signing_status_signed();
		if (status === 'approved' || status === 'completed') return m.signing_status_approved();
		return m.signing_status_pending();
	}

	function fieldTypeLabel(fieldType: string): string {
		if (fieldType === 'signature') return m.signing_field_type_signature();
		if (fieldType === 'initials') return m.signing_field_type_initials();
		if (fieldType === 'date') return m.signing_field_type_date();
		if (fieldType === 'checkbox') return m.signing_field_type_checkbox();
		return m.signing_field_type_text();
	}

	function isFieldValueMissing(
		field: { fieldType: string; required: boolean },
		value: unknown
	): boolean {
		if (!field.required) return false;
		if (field.fieldType === 'checkbox') return value !== true;
		return typeof value !== 'string' || value.trim().length === 0;
	}

	function formatExpiry(expiresAt: string, locale: string): string {
		return new Intl.DateTimeFormat(locale, {
			dateStyle: 'medium',
			timeStyle: 'short'
		}).format(new Date(expiresAt));
	}

	/**
	 * The recipient's own completed action, which is distinct from whole-envelope
	 * progress. Both are shown; neither implies the other.
	 */
	function completedReceiptTitle(action: 'signed' | 'approved'): string {
		return action === 'signed'
			? m.signing_signed_receipt_title()
			: m.signing_approved_receipt_title();
	}

	function completedReceiptRecordedAt(
		action: 'signed' | 'approved',
		completedAt: string,
		locale: string
	): string {
		const timestamp: string = formatExpiry(completedAt, locale);
		return action === 'signed'
			? m.signing_completed_receipt_signed_recorded_at({ timestamp })
			: m.signing_completed_receipt_approved_recorded_at({ timestamp });
	}

	function completedReceiptEnvelopeProgress(
		envelopeStatus: 'in_progress' | 'completed',
		completedByThisAction: boolean
	): string {
		if (envelopeStatus !== 'completed') {
			return m.signing_completed_receipt_envelope_in_progress();
		}
		return completedByThisAction
			? m.signing_completed_receipt_envelope_completed_by_you()
			: m.signing_completed_receipt_envelope_completed();
	}

	function handleDeclineStatus(status: RecipientDeclineStatus): void {
		declineStatus = status;
		declinePending = status === 'pending';
		if (status === 'pending') {
			liveMessage = m.signing_decline_pending();
		} else if (status === 'success') {
			if (data.state === 'active') {
				optimisticDecline = {
					envelopeId: data.access.envelopeId,
					recipientId: data.access.recipientId
				};
			}
			dialogOpen = false;
			liveMessage = m.signing_decline_success();
		} else if (status === 'transient_failure') {
			liveMessage = m.signing_decline_retry_pending();
		} else if (status === 'terminal_failure') {
			dialogOpen = false;
			liveMessage = m.signing_decline_failed();
		}
	}

	function handleApproveStatus(status: RecipientApproveStatus): void {
		approveStatus = status;
		approvePending = status === 'pending';
		if (status === 'pending') {
			liveMessage = m.signing_approve_pending();
		} else if (status === 'success') {
			isApproved = true;
			approveDialogOpen = false;
			liveMessage = m.signing_approve_success();
		} else if (status === 'transient_failure') {
			liveMessage = m.signing_approve_retry_pending();
		} else if (status === 'terminal_failure') {
			approveDialogOpen = false;
			liveMessage = m.signing_approve_failed();
		}
	}

	function handleSignStatus(status: RecipientSignStatus): void {
		signStatus = status;
		signPending = status === 'pending';
		if (status === 'pending') {
			signatureAssetExpired = false;
			liveMessage = m.signing_sign_pending();
		} else if (status === 'success') {
			isSigned = true;
			signDialogOpen = false;
			liveMessage = m.signing_sign_success();
		} else if (status === 'transient_failure') {
			liveMessage = m.signing_sign_retry_pending();
		} else if (status === 'validation_failure') {
			signDialogOpen = false;
			liveMessage = m.signing_sign_validation_failed();
		} else if (status === 'terminal_failure') {
			signDialogOpen = false;
			liveMessage = m.signing_sign_failed();
		}
	}

	function buildSignController(): RecipientSignController | null {
		if (data.state !== 'active' || data.access.role !== 'signer') return null;
		return createRecipientSignController({
			envelopeId: data.access.envelopeId,
			recipientId: data.access.recipientId,
			expectedFieldGeneration: data.fieldGeneration,
			role: data.access.role,
			pageState: data.state,
			recipientStatus: () =>
				viewRecorded || data.access.recipientStatus === 'viewed'
					? 'viewed'
					: data.access.recipientStatus,
			onStatusChange: handleSignStatus,
			onSignatureAssetExpired: handleSignatureAssetExpired
		});
	}

	/** Clears only drawn asset references so those fields must be drawn again; typed values stay. */
	function handleSignatureAssetExpired(): void {
		for (const [fieldId, value] of Object.entries(fieldValues)) {
			if (typeof value === 'string' && isSignatureAssetRef(value)) fieldValues[fieldId] = '';
		}
		signatureAssetExpired = true;
		liveMessage = m.signing_sign_signature_expired();
	}

	function hasMissingRequiredField(): boolean {
		if (data.state !== 'active') return false;
		return data.fields.some((field) => isFieldValueMissing(field, fieldValues[field.id]));
	}

	function handleSignAttempt(): void {
		signAttempted = true;
		if (hasMissingRequiredField()) {
			liveMessage = m.signing_field_missing();
			const missing = missingRequiredFields[0];
			if (missing) navigateToField(missing);
			return;
		}
		signDialogOpen = true;
	}

	async function handleSignConfirm(): Promise<void> {
		if (data.state !== 'active') return;
		signController ??= buildSignController();
		const values = data.fields.map((field) => ({
			fieldId: field.id,
			value: fieldValues[field.id]
		}));
		await signController?.confirmSign(values);
	}

	function buildDeclineController(): RecipientDeclineController | null {
		if (
			data.state !== 'active' ||
			(data.access.role !== 'signer' && data.access.role !== 'approver')
		) {
			return null;
		}
		return createRecipientDeclineController({
			envelopeId: data.access.envelopeId,
			recipientId: data.access.recipientId,
			role: data.access.role,
			pageState: data.state,
			onStatusChange: handleDeclineStatus,
			onSuccess: () => void invalidateAll(),
			onAmbiguousFailure: () => void invalidateAll(),
			onTerminalFailure: () => void invalidateAll()
		});
	}

	function ensureDeclineController(): RecipientDeclineController | null {
		if (data.state !== 'active') return null;
		const identity: string = `${data.access.envelopeId}:${data.access.recipientId}`;
		if (declineController === null || declineControllerIdentity !== identity) {
			declineController?.destroy();
			declineStatus = 'idle';
			declinePending = false;
			dialogOpen = false;
			declineController = buildDeclineController();
			declineControllerIdentity = identity;
		}
		return declineController;
	}

	function buildApproveController(): RecipientApproveController | null {
		if (data.state !== 'active' || data.access.role !== 'approver') {
			return null;
		}
		return createRecipientApproveController({
			envelopeId: data.access.envelopeId,
			recipientId: data.access.recipientId,
			role: data.access.role,
			pageState: data.state,
			recipientStatus: () =>
				viewRecorded || data.access.recipientStatus === 'viewed'
					? 'viewed'
					: data.access.recipientStatus,
			onStatusChange: handleApproveStatus
		});
	}

	async function handleDeclineConfirm(): Promise<void> {
		await ensureDeclineController()?.confirmDecline();
	}

	async function handleApproveConfirm(): Promise<void> {
		approveController ??= buildApproveController();
		await approveController?.confirmApprove();
	}

	onMount(() => {
		if (data.state !== 'active') return;

		ensureDeclineController();
		approveController ??= buildApproveController();
		signController ??= buildSignController();

		const cleanupViewed = initRecipientViewed({
			envelopeId: data.access.envelopeId,
			recipientId: data.access.recipientId,
			initialStatus: data.access.recipientStatus,
			pageState: data.state,
			onStatusChange: (newStatus) => {
				viewRecorded = newStatus === 'viewed';
			},
			onRecorded: () => {
				liveMessage = m.signing_view_recorded();
			},
			onRetryPendingChange: (pending) => {
				retryPending = pending;
				if (pending) viewFailed = false;
			},
			onTerminalFailure: () => {
				viewFailed = true;
				liveMessage = m.signing_view_failed();
			}
		});

		return () => {
			cleanupViewed();
			declineController?.destroy();
			declineController = null;
			declineControllerIdentity = null;
			approveController?.destroy();
			signController?.destroy();
		};
	});
</script>

<svelte:head>
	<title
		>{data.state === 'declined' || isDeclined
			? m.signing_declined_receipt_title()
			: data.state === 'completed'
				? completedReceiptTitle(data.action)
				: m.signing_page_title()} — {m.app_name()}</title
	>
	<meta name="robots" content="noindex,nofollow,noarchive" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

{#snippet declineAction()}
	{#if declineStatus === 'terminal_failure'}
		<p class="text-xs font-medium text-destructive" role="alert">{m.signing_decline_failed()}</p>
	{:else}
		<div class="flex flex-col items-end gap-2">
			{#if declineStatus === 'transient_failure'}
				<p class="text-xs font-medium text-destructive" role="status" aria-live="polite">
					{m.signing_decline_retry_pending()}
				</p>
			{/if}
			<AlertDialog.Root bind:open={dialogOpen}>
				<AlertDialog.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" class="min-h-[44px] w-fit" disabled={declinePending}>
							{declineStatus === 'transient_failure'
								? m.signing_decline_retry()
								: m.signing_decline_action()}
						</Button>
					{/snippet}
				</AlertDialog.Trigger>
				<AlertDialog.Content>
					<AlertDialog.Header>
						<AlertDialog.Title>{m.signing_decline_dialog_title()}</AlertDialog.Title>
						<AlertDialog.Description>
							{m.signing_decline_dialog_description()}
						</AlertDialog.Description>
					</AlertDialog.Header>
					{#if declineStatus === 'transient_failure'}
						<p class="text-xs text-destructive" role="status" aria-live="polite">
							{m.signing_decline_retry_pending()}
						</p>
					{:else if declineStatus === 'pending'}
						<p class="text-xs text-muted-foreground" role="status" aria-live="polite">
							{m.signing_decline_pending()}
						</p>
					{/if}
					<AlertDialog.Footer class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						<AlertDialog.Cancel class="min-h-[44px]" disabled={declinePending}>
							{m.signing_decline_dialog_cancel()}
						</AlertDialog.Cancel>
						<AlertDialog.Action
							variant="destructive"
							class="min-h-[44px]"
							disabled={declinePending}
							onclick={async (event) => {
								event.preventDefault();
								await handleDeclineConfirm();
							}}
						>
							{#if declinePending}
								<Spinner data-icon="inline-start" />
							{/if}
							{declinePending
								? m.signing_decline_pending()
								: declineStatus === 'transient_failure'
									? m.signing_decline_retry()
									: m.signing_decline_dialog_confirm()}
						</AlertDialog.Action>
					</AlertDialog.Footer>
				</AlertDialog.Content>
			</AlertDialog.Root>
		</div>
	{/if}
{/snippet}

{#snippet fieldBox(field: RecipientPlacedField)}
	{@const invalid = signAttempted && isFieldValueMissing(field, fieldValues[field.id])}
	<div
		class="absolute"
		style="left: {field.geometry.x * 100}%; top: {field.geometry.y * 100}%; width: {field.geometry
			.width * 100}%; height: {field.geometry.height * 100}%;"
		data-field-id={field.id}
	>
		{#if field.fieldType === 'checkbox'}
			<div
				class="flex size-full items-center justify-center rounded-md border-2 border-dashed border-primary/60 bg-primary/5"
				data-invalid={invalid || undefined}
			>
				<Checkbox
					id={field.id}
					aria-label="{field.label} — {fieldTypeLabel(field.fieldType)}"
					aria-invalid={invalid || undefined}
					checked={fieldValues[field.id] === true}
					disabled={!fieldsEditable}
					onCheckedChange={(value) => (fieldValues[field.id] = value === true)}
				/>
			</div>
		{:else if field.fieldType === 'signature' || field.fieldType === 'initials'}
			<SignatureCanvas
				id={field.id}
				envelopeId={data.state === 'active' ? data.access.envelopeId : ''}
				recipientId={data.state === 'active' ? data.access.recipientId : ''}
				recipientName={data.state === 'active' ? data.access.recipientName : ''}
				label="{field.label} — {fieldTypeLabel(field.fieldType)}"
				triggerClass="size-full min-h-0 justify-center rounded-md border-2 border-dashed border-primary/60 bg-primary/5 px-1 text-center"
				{invalid}
				disabled={!fieldsEditable}
				bind:value={() => fieldValues[field.id] as string, (next) => (fieldValues[field.id] = next)}
			/>
		{:else if field.fieldType === 'date'}
			<Input
				id={field.id}
				type="date"
				aria-label="{field.label} — {fieldTypeLabel(field.fieldType)}"
				aria-invalid={invalid || undefined}
				disabled={!fieldsEditable}
				class="size-full min-h-0 rounded-md border-2 border-dashed border-primary/60 bg-primary/5 px-1 text-xs"
				value={fieldValues[field.id] as string}
				oninput={(event) => (fieldValues[field.id] = event.currentTarget.value)}
			/>
		{:else}
			<Input
				id={field.id}
				type="text"
				aria-label="{field.label} — {fieldTypeLabel(field.fieldType)}"
				aria-invalid={invalid || undefined}
				disabled={!fieldsEditable}
				maxlength={field.fieldType === 'text' ? 4000 : 20}
				placeholder={field.label}
				class="size-full min-h-0 rounded-md border-2 border-dashed border-primary/60 bg-primary/5 px-1 text-xs"
				value={fieldValues[field.id] as string}
				oninput={(event) => (fieldValues[field.id] = event.currentTarget.value)}
			/>
		{/if}
	</div>
{/snippet}

<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
	{liveMessage}
</div>

<div class="flex w-full flex-col items-center gap-6">
	{#if data.state === 'declined' || isDeclined}
		<Card.Root class="w-full border-destructive/20 shadow-sm">
			<Card.Header class="items-center gap-4 pt-10 text-center">
				<div
					class="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive"
				>
					<IconCircleX />
				</div>
				<Card.Title class="text-2xl">{m.signing_declined_receipt_title()}</Card.Title>
			</Card.Header>
			<Card.Content class="flex flex-col items-center gap-3 pb-8">
				{#if data.state === 'declined'}
					<p class="text-sm text-muted-foreground">
						{m.signing_declined_receipt_recorded_at({
							timestamp: formatExpiry(data.declinedAt, getLocale())
						})}
					</p>
				{/if}
			</Card.Content>
			<Card.Footer
				class="justify-center border-t bg-muted/20 py-4 text-center text-sm text-muted-foreground"
			>
				{m.signing_declined_receipt_access_closed()}
			</Card.Footer>
		</Card.Root>
	{:else if data.state === 'completed'}
		<Card.Root class="w-full border-primary/20 shadow-sm">
			<Card.Header class="items-center gap-4 pt-10 text-center">
				<div
					class="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"
				>
					<IconCircleCheck />
				</div>
				<Card.Title class="text-2xl">{completedReceiptTitle(data.action)}</Card.Title>
			</Card.Header>
			<Card.Content class="flex flex-col items-center gap-3 pb-8 text-center">
				<p class="text-sm text-muted-foreground">
					{completedReceiptRecordedAt(data.action, data.completedAt, getLocale())}
				</p>
				<p class="text-sm text-muted-foreground">
					{completedReceiptEnvelopeProgress(
						data.envelopeStatus,
						data.envelopeCompletedByThisAction
					)}
				</p>
			</Card.Content>
			<Card.Footer
				class="justify-center border-t bg-muted/20 py-4 text-center text-sm text-muted-foreground"
			>
				{m.signing_completed_receipt_access_closed()}
			</Card.Footer>
		</Card.Root>
	{:else if data.state === 'active'}
		<div class="flex w-full flex-col gap-6">
			<header class="flex flex-col gap-3">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<h1 class="text-2xl font-semibold tracking-tight">{data.access.envelopeTitle}</h1>
					{#if canAct}{@render declineAction()}{/if}
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<Badge variant="outline">{roleLabel(data.access.role)}</Badge>
					{#if !isSigned && !isApproved}
						<Badge variant="secondary">{statusLabel(data.access.recipientStatus)}</Badge>
					{/if}
					<p class="text-sm text-muted-foreground">
						{m.signing_expires()}
						<time datetime={data.access.expiresAt}
							>{formatExpiry(data.access.expiresAt, getLocale())}</time
						>
					</p>
				</div>
				{#if retryPending && !viewRecorded && data.access.recipientStatus !== 'viewed'}
					<p class="text-sm text-muted-foreground" role="status">
						{m.signing_view_retry_pending()}
					</p>
				{:else if viewFailed && !viewRecorded && data.access.recipientStatus !== 'viewed'}
					<p class="text-sm text-destructive" role="alert">{m.signing_view_failed()}</p>
				{/if}
				<noscript
					><p class="text-sm text-muted-foreground">{m.signing_no_js_explanation()}</p></noscript
				>
			</header>

			<section aria-labelledby="agreement-documents" class="flex w-full flex-col gap-4">
				<div>
					<h2 id="agreement-documents" class="text-xl font-semibold tracking-tight">
						{m.signing_documents_title()}
					</h2>
					<p class="text-sm text-muted-foreground">{m.signing_documents_description()}</p>
				</div>
				{#if data.state === 'active' && data.documents.length > 1}
					<nav class="flex flex-wrap gap-2" aria-label={m.signing_document_switcher()}>
						{#each data.documents as document (document.documentId)}
							<Button
								size="sm"
								variant={selectedDocument?.documentId === document.documentId
									? 'default'
									: 'outline'}
								aria-pressed={selectedDocument?.documentId === document.documentId}
								onclick={() => selectDocument(document.documentId)}
							>
								{document.title}
							</Button>
						{/each}
					</nav>
				{/if}
				{#if isSigner && placedFields.length > 0 && !isSigned}
					<Card.Root>
						<Card.Header><Card.Title>{m.signing_fields_title()}</Card.Title></Card.Header>
						<Card.Content class="flex flex-col gap-3">
							<div class="flex flex-wrap items-center justify-between gap-3">
								<p class="text-sm" aria-live="polite">
									{m.signing_required_progress({
										completed: String(requiredFields.length - missingRequiredFields.length),
										total: String(requiredFields.length)
									})}
								</p>
								{#if missingRequiredFields[0]}
									<Button
										size="sm"
										variant="outline"
										disabled={!fieldsEditable}
										onclick={() => navigateToField(missingRequiredFields[0]!)}
										>{m.signing_next_missing_field()}</Button
									>
								{/if}
							</div>
							<Progress
								value={requiredFields.length > 0
									? requiredFields.length - missingRequiredFields.length
									: 1}
								max={requiredFields.length || 1}
								aria-label={m.signing_required_fields()}
							/>
							<Collapsible.Root>
								<Collapsible.Trigger>
									{#snippet child({ props })}<Button {...props} variant="ghost" size="sm"
											>{m.signing_all_fields({ count: String(placedFields.length) })}</Button
										>{/snippet}
								</Collapsible.Trigger>
								<Collapsible.Content class="pt-2">
									<ul class="flex flex-col gap-1">
										{#each placedFields as field (field.id)}
											{@const done = !isFieldValueMissing(
												{ fieldType: field.fieldType, required: true },
												fieldValues[field.id]
											)}
											<li>
												<Button
													variant="ghost"
													class="h-auto w-full justify-between gap-3 py-2 whitespace-normal"
													disabled={!fieldsEditable}
													onclick={() => navigateToField(field)}
													aria-label={m.signing_field_navigate({
														label: field.label,
														document: fieldDocumentTitle(field),
														page: String(field.geometry.page)
													})}
												>
													<span class="flex min-w-0 flex-col items-start gap-1 text-left">
														<span>{field.label}</span>
														<span class="text-xs text-muted-foreground"
															>{fieldDocumentTitle(field)} · {m.signing_document_page({
																page: String(field.geometry.page)
															})}</span
														>
													</span>
													<Badge variant={done ? 'secondary' : 'outline'}
														>{done
															? m.signing_field_complete()
															: field.required
																? m.signing_field_required()
																: m.signing_field_optional()}</Badge
													>
												</Button>
											</li>
										{/each}
									</ul>
								</Collapsible.Content>
							</Collapsible.Root>
						</Card.Content>
					</Card.Root>
				{/if}
				{#key agreementPdfPath}
					{@const documentId = selectedDocument?.documentId ?? null}
					<PdfDocumentView
						src={agreementPdfPath}
						label={m.signing_document_label()}
						expectedPageCount={selectedDocument?.pageCount ?? 1}
						loadingLabel={m.signing_document_loading()}
						errorTitle={m.signing_document_error_title()}
						errorDescription={m.signing_document_error_description()}
						openLabel={m.signing_document_open()}
						onpages={pageReadyHandler(documentId)}
					>
						{#snippet overlay(page: PdfRenderedPage)}
							<div id={`agreement-page-${page.pageNumber}`} class="absolute inset-0">
								{#if isSigner && !isSigned}
									{#each fieldsOnPage(page.pageNumber) as field (field.id)}
										{@render fieldBox(field)}
									{/each}
								{/if}
							</div>
						{/snippet}
					</PdfDocumentView>
				{/key}
			</section>

			{#if isSigner && !isDeclined && (viewRecorded || data.access.recipientStatus === 'viewed')}
				<section aria-label={m.signing_fields_title()} class="flex w-full flex-col gap-4">
					{#if isSigned}
						<Card.Root class="border-primary/20 bg-primary/[0.03] shadow-sm">
							<Card.Header class="gap-2">
								<div class="flex items-start gap-4">
									<div
										class="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"
									>
										<IconCircleCheck class="size-6" />
									</div>
									<div>
										<Card.Title class="text-xl">{m.signing_signed_receipt_title()}</Card.Title>
									</div>
								</div>
							</Card.Header>
						</Card.Root>
					{:else}
						<Card.Root class="shadow-sm">
							<Card.Header>
								<Card.Title>{m.signing_review_title()}</Card.Title>
								<Card.Description>{m.signing_sign_description()}</Card.Description>
							</Card.Header>
							{#if signStatus === 'validation_failure'}
								<Card.Content>
									<p class="text-sm font-medium text-destructive" role="alert">
										{signatureAssetExpired
											? m.signing_sign_signature_expired()
											: m.signing_sign_validation_failed()}
									</p>
								</Card.Content>
							{/if}
							<Card.Footer
								class="flex flex-col gap-3 border-t bg-muted/20 py-4 sm:flex-row sm:items-center sm:justify-between"
							>
								{#if signStatus === 'terminal_failure'}
									<p class="text-xs font-medium text-destructive">{m.signing_sign_failed()}</p>
								{:else}
									<AlertDialog.Root bind:open={signDialogOpen}>
										<Button
											class="min-h-[44px] w-full text-sm sm:w-auto"
											disabled={signPending}
											onclick={handleSignAttempt}
										>
											{signStatus === 'transient_failure' || signStatus === 'validation_failure'
												? m.signing_sign_retry()
												: m.signing_sign_action()}
										</Button>
										<AlertDialog.Content>
											<AlertDialog.Header>
												<AlertDialog.Title>{m.signing_sign_dialog_title()}</AlertDialog.Title>
												<AlertDialog.Description>
													{m.signing_sign_dialog_description()}
												</AlertDialog.Description>
											</AlertDialog.Header>
											{#if signStatus === 'transient_failure'}
												<p class="text-xs text-destructive" role="status" aria-live="polite">
													{m.signing_sign_retry_pending()}
												</p>
											{:else if signStatus === 'pending'}
												<p class="text-xs text-muted-foreground" role="status" aria-live="polite">
													{m.signing_sign_pending()}
												</p>
											{/if}
											<AlertDialog.Footer
												class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"
											>
												<AlertDialog.Cancel class="min-h-[44px]" disabled={signPending}>
													{m.signing_sign_dialog_cancel()}
												</AlertDialog.Cancel>
												<AlertDialog.Action
													class="min-h-[44px]"
													disabled={signPending}
													onclick={async (event) => {
														event.preventDefault();
														await handleSignConfirm();
													}}
												>
													{#if signPending}
														<Spinner data-icon="inline-start" />
													{/if}
													{signPending
														? m.signing_sign_pending()
														: signStatus === 'transient_failure'
															? m.signing_sign_retry()
															: m.signing_sign_dialog_confirm()}
												</AlertDialog.Action>
											</AlertDialog.Footer>
										</AlertDialog.Content>
									</AlertDialog.Root>
								{/if}
							</Card.Footer>
						</Card.Root>
						<noscript>
							<p class="mt-2 text-sm text-muted-foreground">
								{m.signing_sign_no_js_explanation()}
							</p>
						</noscript>
					{/if}
				</section>
			{/if}

			{#if isApprover && !isDeclined && (viewRecorded || data.access.recipientStatus === 'viewed')}
				<section aria-label={m.signing_approve_action()} class="w-full">
					{#if isApproved}
						<Card.Root class="border-primary/20 bg-primary/[0.03] shadow-sm">
							<Card.Header class="gap-2">
								<div class="flex items-start gap-4">
									<div
										class="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"
									>
										<IconCircleCheck class="size-6" />
									</div>
									<div>
										<Card.Title class="text-xl">{m.signing_approved_receipt_title()}</Card.Title>
									</div>
								</div>
							</Card.Header>
						</Card.Root>
					{:else}
						<Card.Root class="border-primary/20 shadow-sm">
							<Card.Header>
								<Card.Title class="text-base">{m.signing_approve_action()}</Card.Title>
								<Card.Description>{m.signing_approve_description()}</Card.Description>
							</Card.Header>
							<Card.Footer
								class="flex flex-col gap-3 border-t bg-muted/20 py-4 sm:flex-row sm:items-center sm:justify-between"
							>
								{#if approveStatus === 'transient_failure'}
									<p class="text-xs font-medium text-destructive">
										{m.signing_approve_retry_pending()}
									</p>
								{:else if approveStatus === 'terminal_failure'}
									<p class="text-xs font-medium text-destructive">
										{m.signing_approve_failed()}
									</p>
								{:else}
									<span></span>
								{/if}
								{#if approveStatus !== 'terminal_failure'}
									<AlertDialog.Root bind:open={approveDialogOpen}>
										<AlertDialog.Trigger>
											{#snippet child({ props })}
												<Button
													{...props}
													class="min-h-[44px] w-full text-sm sm:w-auto"
													disabled={approvePending}
												>
													{approveStatus === 'transient_failure'
														? m.signing_approve_retry()
														: m.signing_approve_action()}
												</Button>
											{/snippet}
										</AlertDialog.Trigger>
										<AlertDialog.Content>
											<AlertDialog.Header>
												<AlertDialog.Title>{m.signing_approve_dialog_title()}</AlertDialog.Title>
												<AlertDialog.Description>
													{m.signing_approve_dialog_description()}
												</AlertDialog.Description>
											</AlertDialog.Header>
											{#if approveStatus === 'transient_failure'}
												<p class="text-xs text-destructive" role="status" aria-live="polite">
													{m.signing_approve_retry_pending()}
												</p>
											{:else if approveStatus === 'pending'}
												<p class="text-xs text-muted-foreground" role="status" aria-live="polite">
													{m.signing_approve_pending()}
												</p>
											{/if}
											<AlertDialog.Footer
												class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"
											>
												<AlertDialog.Cancel class="min-h-[44px]" disabled={approvePending}>
													{m.signing_approve_dialog_cancel()}
												</AlertDialog.Cancel>
												<AlertDialog.Action
													class="min-h-[44px]"
													disabled={approvePending}
													onclick={async (event) => {
														event.preventDefault();
														await handleApproveConfirm();
													}}
												>
													{#if approvePending}
														<Spinner data-icon="inline-start" />
													{/if}
													{approvePending
														? m.signing_approve_pending()
														: approveStatus === 'transient_failure'
															? m.signing_approve_retry()
															: m.signing_approve_dialog_confirm()}
												</AlertDialog.Action>
											</AlertDialog.Footer>
										</AlertDialog.Content>
									</AlertDialog.Root>
								{/if}
							</Card.Footer>
						</Card.Root>
						<noscript>
							<p class="mt-2 text-sm text-muted-foreground">
								{m.signing_approve_no_js_explanation()}
							</p>
						</noscript>
					{/if}
				</section>
			{/if}
		</div>
	{:else}
		<Card.Root class="w-full text-center shadow-sm">
			<Card.Header class="items-center gap-4 py-10">
				<div class="flex size-12 items-center justify-center rounded-2xl bg-muted text-foreground">
					<IconAlertTriangle class="size-6" />
				</div>
				<Card.Title>
					{data.state === 'unavailable' ? m.signing_unavailable_title() : m.signing_invalid_title()}
				</Card.Title>
				<Card.Description class="leading-6">
					{data.state === 'unavailable'
						? m.signing_unavailable_description()
						: m.signing_invalid_description()}
				</Card.Description>
			</Card.Header>
		</Card.Root>
	{/if}
</div>
