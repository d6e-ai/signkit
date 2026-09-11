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

	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === 'object' && value !== null && !Array.isArray(value);
	}

	function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
		const keys: string[] = Object.keys(value).sort();
		return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		IconAlertTriangle,
		IconCircleX,
		IconClock,
		IconFileText,
		IconShieldCheck,
		IconUserCheck
	} from '@tabler/icons-svelte';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let viewRecorded = $state(false);
	let liveMessage = $state('');
	let retryPending = $state(false);
	let viewFailed = $state(false);

	let declineStatus = $state<RecipientDeclineStatus>('idle');
	let declinePending = $state(false);
	let isDeclined = $state(false);
	let dialogOpen = $state(false);
	let declineController: RecipientDeclineController | null = null;

	function roleLabel(role: string): string {
		if (role === 'signer') return m.signing_role_signer();
		if (role === 'approver') return m.signing_role_approver();
		if (role === 'viewer') return m.signing_role_viewer();
		return m.signing_role_prefill();
	}

	function statusLabel(status: string): string {
		if (status === 'declined') return m.signing_status_declined();
		return status === 'viewed' ? m.signing_status_viewed() : m.signing_status_pending();
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
			isDeclined = true;
			dialogOpen = false;
			liveMessage = m.signing_decline_success();
		} else if (status === 'transient_failure') {
			liveMessage = m.signing_decline_retry_pending();
		} else if (status === 'terminal_failure') {
			dialogOpen = false;
			liveMessage = m.signing_decline_failed();
		}
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
			onStatusChange: handleDeclineStatus
		});
	}

	async function handleDeclineConfirm(): Promise<void> {
		declineController ??= buildDeclineController();
		await declineController?.confirmDecline();
	}

	onMount(() => {
		if (data.state !== 'active') return;

		declineController ??= buildDeclineController();

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
		};
	});
</script>

<svelte:head>
	<title>{m.signing_page_title()} — {m.app_name()}</title>
	<meta name="robots" content="noindex,nofollow,noarchive" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
	{liveMessage}
</div>

<div class="mx-auto flex min-h-[calc(100svh-7.5rem)] w-full max-w-5xl items-center justify-center">
	{#if data.state === 'active'}
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
										: viewRecorded || data.access.recipientStatus === 'viewed'
											? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
											: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300'}
								>
									{statusLabel(
										isDeclined ? 'declined' : viewRecorded ? 'viewed' : data.access.recipientStatus
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
					{isDeclined ? m.signing_declined_receipt_description() : m.signing_controls_next()}
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
						class="sticky top-14 z-20 -mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto bg-muted/90 px-4 py-3 backdrop-blur lg:static lg:mx-0 lg:flex-col lg:overflow-visible lg:bg-transparent lg:p-0"
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
									<Badge variant="secondary" class="shrink-0">{m.signing_document_source()}</Badge>
								</Card.Header>
								<Card.Content class="p-0">
									<pre
										class="overflow-hidden p-5 font-sans text-sm leading-7 [overflow-wrap:anywhere] break-words whitespace-pre-wrap sm:p-7">{document.content}</pre>
								</Card.Content>
							</Card.Root>
						{/each}
					</div>
				</div>
			</section>

			{#if data.access.role === 'signer' || data.access.role === 'approver'}
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
