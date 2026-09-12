<script lang="ts" module>
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
		randomUUID?: () => string;
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
		randomUUID: customRandomUUID,
		document: customDocument,
		window: customWindow
	}: RecipientViewOptions): () => void {
		if (pageState !== 'active' || initialStatus !== 'pending') {
			return () => {};
		}

		const fetchFn = customFetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
		const doc = customDocument ?? (typeof document !== 'undefined' ? document : undefined);
		const win = customWindow ?? (typeof window !== 'undefined' ? window : undefined);

		const generateUUID =
			customRandomUUID ??
			(() => {
				if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
					return crypto.randomUUID();
				}
				if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
					const bytes = crypto.getRandomValues(new Uint8Array(16));
					return Array.from(bytes, (byte: number): string =>
						byte.toString(16).padStart(2, '0')
					).join('');
				}
				return `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
			});

		const idempotencyKey = generateUUID();
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
				const response = await fetchFn('/api/v1/signing/viewed', {
					method: 'POST',
					credentials: 'same-origin',
					headers: {
						'content-type': 'application/json',
						'idempotency-key': idempotencyKey
					},
					body: JSON.stringify({
						envelopeId,
						recipientId
					}),
					signal: abortController.signal
				});

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

	export type RecipientDeclineStatus =
		'idle' | 'pending' | 'transient_failure' | 'terminal_failure' | 'success';

	export interface RecipientDeclineOptions {
		envelopeId: string;
		recipientId: string;
		role: string;
		pageState: string;
		fetch?: typeof fetch;
		randomUUID?: () => string;
		onStatusChange?: (status: RecipientDeclineStatus) => void;
		onSuccess?: () => void;
		onTransientFailure?: () => void;
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
		randomUUID: customRandomUUID,
		onStatusChange,
		onSuccess,
		onTransientFailure,
		onTerminalFailure
	}: RecipientDeclineOptions): RecipientDeclineController {
		let status: RecipientDeclineStatus = 'idle';
		let inFlight = false;
		let idempotencyKey: string | null = null;
		const abortController = new AbortController();

		const isActionableRole = role === 'signer' || role === 'approver';
		const canDecline = pageState === 'active' && isActionableRole;

		const fetchFn = customFetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
		const generateUUID =
			customRandomUUID ??
			(() => {
				if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
					return crypto.randomUUID();
				}
				if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
					const bytes = crypto.getRandomValues(new Uint8Array(16));
					return Array.from(bytes, (byte: number): string =>
						byte.toString(16).padStart(2, '0')
					).join('');
				}
				return `decline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
			});

		async function confirmDecline(): Promise<void> {
			if (!canDecline || inFlight || status === 'success' || status === 'terminal_failure') {
				return;
			}
			if (!fetchFn) return;

			if (!idempotencyKey) {
				idempotencyKey = generateUUID();
			}

			inFlight = true;
			status = 'pending';
			onStatusChange?.('pending');

			try {
				const response = await fetchFn('/api/v1/signing/decline', {
					method: 'POST',
					credentials: 'same-origin',
					headers: {
						'content-type': 'application/json',
						'idempotency-key': idempotencyKey
					},
					body: JSON.stringify({
						envelopeId,
						recipientId
					}),
					signal: abortController.signal
				});

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
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return false;
		}
		if (!isRecord(body) || !hasExactKeys(body, ['declined'])) return false;
		const declined: unknown = body.declined;
		if (
			!isRecord(declined) ||
			!hasExactKeys(declined, [
				'declinedAt',
				'envelopeId',
				'envelopeStatus',
				'recipientId',
				'recipientStatus'
			])
		) {
			return false;
		}
		return (
			declined.envelopeId === expectedEnvelopeId &&
			declined.recipientId === expectedRecipientId &&
			declined.recipientStatus === 'declined' &&
			declined.envelopeStatus === 'declined' &&
			typeof declined.declinedAt === 'string' &&
			Number.isFinite(new Date(declined.declinedAt).getTime())
		);
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
		randomUUID?: () => string;
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
		randomUUID: customRandomUUID,
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
		const generateUUID =
			customRandomUUID ??
			(() => {
				if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
					return crypto.randomUUID();
				}
				if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
					const bytes = crypto.getRandomValues(new Uint8Array(16));
					return Array.from(bytes, (byte: number): string =>
						byte.toString(16).padStart(2, '0')
					).join('');
				}
				return `approve-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
			});

		async function confirmApprove(): Promise<void> {
			const currentRecipientStatus = getRecipientStatus();
			const canApprove =
				pageState === 'active' && role === 'approver' && currentRecipientStatus === 'viewed';
			if (!canApprove || inFlight || status === 'success' || status === 'terminal_failure') {
				return;
			}
			if (!fetchFn) return;

			if (!idempotencyKey) {
				idempotencyKey = generateUUID();
			}
			inFlight = true;
			status = 'pending';
			onStatusChange?.('pending');

			try {
				const response = await fetchFn('/api/v1/signing/approve', {
					method: 'POST',
					credentials: 'same-origin',
					headers: {
						'content-type': 'application/json',
						'idempotency-key': idempotencyKey
					},
					body: JSON.stringify({
						envelopeId,
						recipientId
					}),
					signal: abortController.signal
				});

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
		if (response.status !== 200) return null;
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return null;
		}
		if (!isRecord(body) || !hasExactKeys(body, ['approved'])) return null;
		const approved: unknown = body.approved;
		if (
			!isRecord(approved) ||
			!hasExactKeys(approved, [
				'approvedAt',
				'envelopeId',
				'envelopeStatus',
				'recipientId',
				'recipientStatus'
			])
		) {
			return null;
		}
		if (
			approved.envelopeId !== expectedEnvelopeId ||
			approved.recipientId !== expectedRecipientId ||
			typeof approved.approvedAt !== 'string' ||
			!Number.isFinite(new Date(approved.approvedAt).getTime()) ||
			approved.recipientStatus !== 'completed' ||
			!(approved.envelopeStatus === 'completed' || approved.envelopeStatus === 'in_progress')
		) {
			return null;
		}
		const replayed = response.headers?.get?.('idempotency-replayed') === 'true';
		return {
			envelopeId: approved.envelopeId,
			recipientId: approved.recipientId,
			recipientStatus: approved.recipientStatus,
			envelopeStatus: approved.envelopeStatus,
			approvedAt: approved.approvedAt,
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
		randomUUID?: () => string;
		onStatusChange?: (status: RecipientSignStatus) => void;
		onSuccess?: (info?: { replayed: boolean; receipt?: RecipientSignReceipt }) => void;
		onTransientFailure?: () => void;
		onTerminalFailure?: () => void;
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
		randomUUID: customRandomUUID,
		onStatusChange,
		onSuccess,
		onTransientFailure,
		onTerminalFailure
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
		const generateUUID =
			customRandomUUID ??
			(() => {
				if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
					return crypto.randomUUID();
				}
				if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
					const bytes = crypto.getRandomValues(new Uint8Array(16));
					return Array.from(bytes, (byte: number): string =>
						byte.toString(16).padStart(2, '0')
					).join('');
				}
				return `sign-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
			});

		async function confirmSign(values: readonly RecipientSignFieldValue[]): Promise<void> {
			const currentRecipientStatus = getRecipientStatus();
			const canSign =
				pageState === 'active' && role === 'signer' && currentRecipientStatus === 'viewed';
			if (!canSign || inFlight || status === 'success' || status === 'terminal_failure') {
				return;
			}
			if (!fetchFn) return;

			if (!idempotencyKey) {
				idempotencyKey = generateUUID();
			}
			submittedValues ??= values.map((entry: RecipientSignFieldValue): RecipientSignFieldValue => ({
				fieldId: entry.fieldId,
				value: entry.value
			}));

			inFlight = true;
			status = 'pending';
			onStatusChange?.('pending');

			try {
				const response = await fetchFn('/api/v1/signing/sign', {
					method: 'POST',
					credentials: 'same-origin',
					headers: {
						'content-type': 'application/json',
						'idempotency-key': idempotencyKey
					},
					body: JSON.stringify({
						envelopeId,
						recipientId,
						expectedFieldGeneration,
						values: submittedValues
					}),
					signal: abortController.signal
				});

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
		if (response.status !== 200) return null;
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return null;
		}
		if (!isRecord(body) || !hasExactKeys(body, ['signed'])) return null;
		const signed: unknown = body.signed;
		if (
			!isRecord(signed) ||
			!hasExactKeys(signed, [
				'envelopeId',
				'envelopeStatus',
				'recipientId',
				'recipientStatus',
				'signedAt'
			])
		) {
			return null;
		}
		if (
			signed.envelopeId !== expectedEnvelopeId ||
			signed.recipientId !== expectedRecipientId ||
			typeof signed.signedAt !== 'string' ||
			!Number.isFinite(new Date(signed.signedAt).getTime()) ||
			signed.recipientStatus !== 'completed' ||
			!(signed.envelopeStatus === 'completed' || signed.envelopeStatus === 'in_progress')
		) {
			return null;
		}
		const replayed = response.headers?.get?.('idempotency-replayed') === 'true';
		return {
			envelopeId: signed.envelopeId,
			recipientId: signed.recipientId,
			recipientStatus: signed.recipientStatus,
			envelopeStatus: signed.envelopeStatus,
			signedAt: signed.signedAt,
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
</script>

<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount, untrack } from 'svelte';
	import {
		IconAlertTriangle,
		IconCircleCheck,
		IconCircleX,
		IconClock,
		IconFileText,
		IconShieldCheck,
		IconSignature,
		IconUserCheck
	} from '@tabler/icons-svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Field from '$lib/components/ui/field';
	import { Input } from '$lib/components/ui/input';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { RecipientMarkdownNode } from '$lib/security/recipient-markdown';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

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

	function roleLabel(role: string): string {
		if (role === 'signer') return m.signing_role_signer();
		if (role === 'approver') return m.signing_role_approver();
		if (role === 'viewer') return m.signing_role_viewer();
		return m.signing_role_prefill();
	}

	function statusLabel(status: string): string {
		if (status === 'declined') return m.signing_status_declined();
		if (status === 'signed') return m.signing_status_signed();
		if (status === 'approved' || status === 'completed') return m.signing_status_approved();
		return status === 'viewed' ? m.signing_status_viewed() : m.signing_status_pending();
	}

	function fieldTypeLabel(fieldType: string): string {
		if (fieldType === 'signature') return m.signing_field_type_signature();
		if (fieldType === 'initials') return m.signing_field_type_initials();
		if (fieldType === 'date') return m.signing_field_type_date();
		if (fieldType === 'checkbox') return m.signing_field_type_checkbox();
		return m.signing_field_type_text();
	}

	function fieldsByDocument<T extends { documentPath: string }>(
		fields: readonly T[]
	): Array<[string, T[]]> {
		const grouped: Array<[string, T[]]> = [];
		for (const field of fields) {
			const existing = grouped.find(([path]) => path === field.documentPath);
			if (existing) existing[1].push(field);
			else grouped.push([field.documentPath, [field]]);
		}
		return grouped;
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

	function documentName(path: string): string {
		return path
			.replace(/^documents\//, '')
			.replace(/\.md$/, '')
			.replaceAll(/[-_]+/g, ' ');
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
			onStatusChange: handleSignStatus
		});
	}

	function hasMissingRequiredField(): boolean {
		if (data.state !== 'active') return false;
		return data.fields.some((field) => isFieldValueMissing(field, fieldValues[field.id]));
	}

	function handleSignAttempt(): void {
		signAttempted = true;
		if (hasMissingRequiredField()) {
			liveMessage = m.signing_field_missing();
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
			onTransientFailure: () => void invalidateAll(),
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
			: m.signing_page_title()} — {m.app_name()}</title
	>
	<meta name="robots" content="noindex,nofollow,noarchive" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

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

<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
	{liveMessage}
</div>

<div class="mx-auto flex min-h-[calc(100svh-7.5rem)] w-full max-w-5xl items-center justify-center">
	{#if data.state === 'declined' || isDeclined}
		<Card.Root class="w-full max-w-2xl border-destructive/20 shadow-sm">
			<Card.Header class="items-center gap-4 pt-10 text-center">
				<div
					class="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive"
				>
					<IconCircleX />
				</div>
				<Card.Title class="text-2xl">{m.signing_declined_receipt_title()}</Card.Title>
				<Card.Description class="max-w-md leading-6">
					{m.signing_declined_receipt_description()}
				</Card.Description>
			</Card.Header>
			<Card.Content class="flex flex-col items-center gap-3 pb-8">
				<Badge variant="outline">{m.signing_status_declined()}</Badge>
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
	{:else if data.state === 'active'}
		<div class="w-full space-y-6">
			<Card.Root class="w-full overflow-hidden shadow-sm">
				<div class="h-1 bg-primary"></div>
				<Card.Header class="gap-4 pb-4">
					<div class="flex items-start justify-between gap-4">
						<div
							class="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary"
						>
							<IconShieldCheck class="size-6" />
						</div>
						<Badge variant="outline" class="border-emerald-200 bg-emerald-50 text-emerald-700">
							{m.signing_secure_access()}
						</Badge>
					</div>
					<div>
						<Card.Title class="text-2xl">{data.access.envelopeTitle}</Card.Title>
						<Card.Description class="mt-2 leading-6">
							{m.signing_access_description()}
						</Card.Description>
					</div>
				</Card.Header>
				<Card.Content class="space-y-5">
					<div class="grid gap-3 sm:grid-cols-2">
						<div class="rounded-xl border bg-muted/25 p-4">
							<div class="flex items-center gap-2 text-xs text-muted-foreground">
								<IconUserCheck class="size-4" />{m.signing_role()}
							</div>
							<p class="mt-2 font-medium">{roleLabel(data.access.role)}</p>
						</div>
						<div class="rounded-xl border bg-muted/25 p-4">
							<div class="flex items-center gap-2 text-xs text-muted-foreground">
								<IconFileText class="size-4" />{m.signing_status()}
							</div>
							<div class="mt-2 flex flex-wrap items-center gap-2">
								<Badge
									variant="outline"
									class={isDeclined
										? 'border-destructive/30 bg-destructive/10 text-destructive'
										: isApproved ||
											  isSigned ||
											  viewRecorded ||
											  data.access.recipientStatus === 'viewed'
											? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
											: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300'}
								>
									{statusLabel(
										isDeclined
											? 'declined'
											: isApproved
												? 'completed'
												: isSigned
													? 'signed'
													: viewRecorded
														? 'viewed'
														: data.access.recipientStatus
									)}
								</Badge>
								{#if retryPending && !viewRecorded && data.access.recipientStatus !== 'viewed' && !isDeclined}
									<span class="text-xs text-muted-foreground">
										{m.signing_view_retry_pending()}
									</span>
								{:else if viewFailed && !viewRecorded && data.access.recipientStatus !== 'viewed' && !isDeclined}
									<span class="text-xs text-destructive">{m.signing_view_failed()}</span>
								{/if}
							</div>
							<noscript>
								<p class="mt-1 text-xs text-muted-foreground">
									{m.signing_no_js_explanation()}
								</p>
							</noscript>
						</div>
					</div>
					<div
						class="flex items-start gap-3 rounded-xl border border-primary/15 bg-primary/[0.035] p-4"
					>
						<IconClock class="mt-0.5 size-4 shrink-0 text-primary" />
						<div>
							<p class="text-sm font-medium">{m.signing_expires()}</p>
							<p class="mt-1 text-sm text-muted-foreground">
								{formatExpiry(data.access.expiresAt, getLocale())}
							</p>
						</div>
					</div>
				</Card.Content>
				<Card.Footer class="border-t bg-muted/20 py-4 text-sm text-muted-foreground">
					{isDeclined
						? m.signing_declined_receipt_description()
						: isApproved
							? m.signing_approved_receipt_description()
							: isSigned
								? m.signing_signed_receipt_description()
								: m.signing_controls_next()}
				</Card.Footer>
			</Card.Root>

			<section aria-labelledby="agreement-documents" class="space-y-4">
				<div>
					<h2 id="agreement-documents" class="text-xl font-semibold tracking-tight">
						{m.signing_documents_title()}
					</h2>
					<p class="mt-1 text-sm text-muted-foreground">{m.signing_documents_description()}</p>
				</div>
				<div class="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
					<nav
						class="sticky top-16 z-20 -mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto bg-muted/90 px-4 py-3 backdrop-blur lg:static lg:mx-0 lg:flex-col lg:overflow-visible lg:bg-transparent lg:p-0"
						aria-label={m.signing_documents_title()}
					>
						{#each data.documents as document, index (document.path)}
							<a
								href={`#document-${index + 1}`}
								class="min-h-11 min-w-fit snap-start rounded-lg border bg-background px-3 py-2 text-sm hover:bg-muted lg:min-w-0"
							>
								<span class="block text-xs text-muted-foreground">
									{m.signing_document_number({ number: String(index + 1) })}
								</span>
								<span class="block truncate font-medium">{documentName(document.path)}</span>
							</a>
						{/each}
					</nav>
					<div class="min-w-0 space-y-4">
						{#each data.documents as document, index (document.path)}
							<Card.Root
								id={`document-${index + 1}`}
								class="scroll-mt-36 overflow-hidden shadow-sm lg:scroll-mt-20"
							>
								<Card.Header
									class="flex-row items-center justify-between gap-3 border-b bg-muted/20 py-4"
								>
									<Card.Title class="min-w-0 truncate text-base">
										<span class="mr-2 text-xs font-normal text-muted-foreground">
											{m.signing_document_number({ number: String(index + 1) })}
										</span>
										{documentName(document.path)}
									</Card.Title>
									<Badge variant="secondary" class="shrink-0">{m.signing_document_format()}</Badge>
								</Card.Header>
								<Card.Content class="p-0">
									<Tabs.Root value="formatted" class="gap-0">
										<div class="border-b bg-muted/10 px-5 py-3 sm:px-7">
											<Tabs.List aria-label={m.signing_document_view_label()}>
												<Tabs.Trigger value="formatted">
													{m.signing_document_formatted_view()}
												</Tabs.Trigger>
												<Tabs.Trigger value="source">
													{m.signing_document_source_view()}
												</Tabs.Trigger>
											</Tabs.List>
										</div>
										<Tabs.Content value="formatted" class="m-0">
											<div
												class="prose max-w-none overflow-x-auto p-5 [overflow-wrap:anywhere] prose-neutral sm:p-7 dark:prose-invert"
												dir="auto"
											>
												{#each document.rendered.nodes as node, nodeIndex (nodeIndex)}
													{@render renderMarkdownNode(node)}
												{/each}
											</div>
											<p
												class="border-t bg-muted/10 px-5 py-3 text-xs text-muted-foreground sm:px-7"
											>
												{m.signing_document_rendering_policy()}
												{#if document.rendered.hasVisibleUnicodeControls}
													<span class="ml-1 font-medium text-amber-700 dark:text-amber-300">
														{m.signing_document_unicode_warning()}
													</span>
												{/if}
											</p>
										</Tabs.Content>
										<Tabs.Content value="source" class="m-0">
											<p
												class="border-b bg-muted/10 px-5 py-3 text-xs text-muted-foreground sm:px-7"
											>
												{m.signing_document_source_description()}
											</p>
											<pre
												class="overflow-hidden p-5 font-mono text-sm leading-7 [overflow-wrap:anywhere] break-words whitespace-pre-wrap sm:p-7">{document.content}</pre>
										</Tabs.Content>
									</Tabs.Root>
								</Card.Content>
							</Card.Root>
						{/each}
					</div>
				</div>
			</section>

			{#if data.access.role === 'signer' && !isDeclined && (viewRecorded || data.access.recipientStatus === 'viewed')}
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
										<Card.Description class="mt-1.5 text-sm leading-6">
											{m.signing_signed_receipt_description()}
										</Card.Description>
									</div>
								</div>
							</Card.Header>
						</Card.Root>
					{:else}
						<Card.Root class="shadow-sm">
							<Card.Header>
								<div class="flex items-start gap-4">
									<div
										class="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"
									>
										<IconSignature class="size-6" />
									</div>
									<div>
										<Card.Title class="text-xl">{m.signing_fields_title()}</Card.Title>
										<Card.Description class="mt-1.5 text-sm leading-6">
											{m.signing_fields_description()}
										</Card.Description>
									</div>
								</div>
							</Card.Header>
							<Card.Content class="flex flex-col gap-6">
								{#each fieldsByDocument(data.fields) as [documentPath, fields] (documentPath)}
									<Field.FieldSet>
										<Field.FieldLegend>{documentName(documentPath)}</Field.FieldLegend>
										<Field.FieldGroup>
											{#each fields as field (field.id)}
												{@const invalid =
													signAttempted && isFieldValueMissing(field, fieldValues[field.id])}
												{#if field.fieldType === 'checkbox'}
													<Field.Field orientation="horizontal" data-invalid={invalid || undefined}>
														<Checkbox
															id={field.id}
															aria-invalid={invalid || undefined}
															checked={fieldValues[field.id] === true}
															disabled={signStatus === 'pending' ||
																signStatus === 'transient_failure'}
															onCheckedChange={(value) => (fieldValues[field.id] = value === true)}
														/>
														<Field.FieldLabel for={field.id} class="font-normal">
															{field.label}
														</Field.FieldLabel>
														{#if invalid}
															<Field.FieldDescription class="text-destructive">
																{m.signing_field_missing()}
															</Field.FieldDescription>
														{/if}
													</Field.Field>
												{:else}
													<Field.Field data-invalid={invalid || undefined}>
														<Field.FieldLabel for={field.id}>
															{field.label}
															<Badge variant="secondary" class="ml-1">
																{fieldTypeLabel(field.fieldType)}
															</Badge>
															{#if field.required}
																<span class="text-xs font-normal text-muted-foreground">
																	({m.signing_field_required()})
																</span>
															{/if}
														</Field.FieldLabel>
														{#if field.fieldType === 'text'}
															<Textarea
																id={field.id}
																aria-invalid={invalid || undefined}
																disabled={signStatus === 'pending' ||
																	signStatus === 'transient_failure'}
																maxlength={4000}
																value={fieldValues[field.id] as string}
																oninput={(event) =>
																	(fieldValues[field.id] = event.currentTarget.value)}
															/>
														{:else if field.fieldType === 'date'}
															<Input
																id={field.id}
																type="date"
																aria-invalid={invalid || undefined}
																disabled={signStatus === 'pending' ||
																	signStatus === 'transient_failure'}
																value={fieldValues[field.id] as string}
																oninput={(event) =>
																	(fieldValues[field.id] = event.currentTarget.value)}
															/>
														{:else}
															<Input
																id={field.id}
																type="text"
																aria-invalid={invalid || undefined}
																disabled={signStatus === 'pending' ||
																	signStatus === 'transient_failure'}
																maxlength={field.fieldType === 'signature' ? 200 : 20}
																value={fieldValues[field.id] as string}
																oninput={(event) =>
																	(fieldValues[field.id] = event.currentTarget.value)}
															/>
														{/if}
														{#if invalid}
															<Field.FieldDescription class="text-destructive">
																{m.signing_field_missing()}
															</Field.FieldDescription>
														{/if}
													</Field.Field>
												{/if}
											{/each}
										</Field.FieldGroup>
									</Field.FieldSet>
								{/each}
								{#if signStatus === 'validation_failure'}
									<p class="text-sm font-medium text-destructive" role="alert">
										{m.signing_sign_validation_failed()}
									</p>
								{/if}
							</Card.Content>
							<Card.Footer
								class="flex flex-col gap-3 border-t bg-muted/20 py-4 sm:flex-row sm:items-center sm:justify-between"
							>
								<p class="text-sm text-muted-foreground">{m.signing_sign_description()}</p>
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
										<AlertDialog.Content class="max-w-[calc(100vw-2rem)] sm:max-w-md">
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

			{#if data.access.role === 'approver' && !isDeclined && (viewRecorded || data.access.recipientStatus === 'viewed')}
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
										<Card.Description class="mt-1.5 text-sm leading-6">
											{m.signing_approved_receipt_description()}
										</Card.Description>
									</div>
								</div>
							</Card.Header>
						</Card.Root>
					{:else}
						<Card.Root class="border-primary/20 shadow-sm">
							<Card.Content
								class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6"
							>
								<div class="min-w-0 space-y-1">
									<h3 class="text-base font-semibold">{m.signing_approve_action()}</h3>
									<p class="text-sm text-muted-foreground">{m.signing_approve_description()}</p>
									{#if approveStatus === 'transient_failure'}
										<p class="text-xs font-medium text-destructive">
											{m.signing_approve_retry_pending()}
										</p>
									{:else if approveStatus === 'terminal_failure'}
										<p class="text-xs font-medium text-destructive">
											{m.signing_approve_failed()}
										</p>
									{/if}
								</div>
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
										<AlertDialog.Content class="max-w-[calc(100vw-2rem)] sm:max-w-md">
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
							</Card.Content>
						</Card.Root>
						<noscript>
							<p class="mt-2 text-sm text-muted-foreground">
								{m.signing_approve_no_js_explanation()}
							</p>
						</noscript>
					{/if}
				</section>
			{/if}

			{#if !isApproved && !isSigned && (data.access.role === 'signer' || data.access.role === 'approver')}
				<section aria-label={m.signing_decline_action()} class="w-full">
					{#if isDeclined}
						<Card.Root class="border-destructive/20 bg-destructive/[0.03] shadow-sm">
							<Card.Header class="gap-2">
								<div class="flex items-start gap-4">
									<div
										class="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-destructive/10 text-destructive"
									>
										<IconCircleX class="size-6" />
									</div>
									<div>
										<Card.Title class="text-xl text-destructive">
											{m.signing_declined_receipt_title()}
										</Card.Title>
										<Card.Description class="mt-1.5 text-sm leading-6">
											{m.signing_declined_receipt_description()}
										</Card.Description>
									</div>
								</div>
							</Card.Header>
						</Card.Root>
					{:else}
						<Card.Root class="border-destructive/20 shadow-sm">
							<Card.Content
								class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6"
							>
								<div class="min-w-0 space-y-1">
									<h3 class="text-base font-semibold">{m.signing_decline_action()}</h3>
									<p class="text-sm text-muted-foreground">
										{m.signing_decline_description()}
									</p>
									{#if declineStatus === 'transient_failure'}
										<p class="text-xs font-medium text-destructive">
											{m.signing_decline_retry_pending()}
										</p>
									{:else if declineStatus === 'terminal_failure'}
										<p class="text-xs font-medium text-destructive">
											{m.signing_decline_failed()}
										</p>
									{/if}
								</div>
								<div
									class="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center"
								>
									{#if declineStatus === 'transient_failure'}
										<Button
											variant="outline"
											class="min-h-[44px] w-full text-sm sm:w-auto"
											disabled={declinePending}
											onclick={() => handleDeclineConfirm()}
										>
											{m.signing_decline_retry()}
										</Button>
									{/if}
									{#if declineStatus !== 'terminal_failure'}
										<AlertDialog.Root bind:open={dialogOpen}>
											<AlertDialog.Trigger>
												{#snippet child({ props })}
													<Button
														{...props}
														variant="destructive"
														class="min-h-[44px] w-full text-sm sm:w-auto"
														disabled={declinePending}
													>
														{m.signing_decline_action()}
													</Button>
												{/snippet}
											</AlertDialog.Trigger>
											<AlertDialog.Content class="max-w-[calc(100vw-2rem)] sm:max-w-md">
												<AlertDialog.Header>
													<AlertDialog.Title>
														{m.signing_decline_dialog_title()}
													</AlertDialog.Title>
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
												<AlertDialog.Footer
													class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"
												>
													<AlertDialog.Cancel class="min-h-[44px]" disabled={declinePending}>
														{m.signing_decline_dialog_cancel()}
													</AlertDialog.Cancel>
													<AlertDialog.Action
														variant="destructive"
														class="min-h-[44px]"
														disabled={declinePending}
														onclick={async (e) => {
															e.preventDefault();
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
									{/if}
								</div>
							</Card.Content>
						</Card.Root>
						<noscript>
							<p class="mt-2 text-sm text-muted-foreground">
								{m.signing_decline_no_js_explanation()}
							</p>
						</noscript>
					{/if}
				</section>
			{/if}
		</div>
	{:else}
		<Card.Root class="w-full max-w-2xl text-center shadow-sm">
			<Card.Header class="items-center gap-4 py-10">
				<div
					class="flex size-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700"
				>
					<IconAlertTriangle class="size-6" />
				</div>
				<Card.Title>
					{data.state === 'unavailable' ? m.signing_unavailable_title() : m.signing_invalid_title()}
				</Card.Title>
				<Card.Description class="max-w-md leading-6">
					{data.state === 'unavailable'
						? m.signing_unavailable_description()
						: m.signing_invalid_description()}
				</Card.Description>
			</Card.Header>
		</Card.Root>
	{/if}
</div>
