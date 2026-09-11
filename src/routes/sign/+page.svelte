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

	function isPermanentClientFailure(response: Response): boolean {
		if (response.status < 400 || response.status >= 500) return false;
		if (response.status === 408 || response.status === 429) return false;
		return response.status !== 409 || !response.headers.has('retry-after');
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		IconAlertTriangle,
		IconClock,
		IconFileText,
		IconShieldCheck,
		IconUserCheck
	} from '@tabler/icons-svelte';
	import { Badge } from '$lib/components/ui/badge';
	import * as Card from '$lib/components/ui/card';
	import * as m from '$lib/paraglide/messages';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let viewRecorded = $state(false);
	let liveMessage = $state('');
	let retryPending = $state(false);
	let viewFailed = $state(false);

	function roleLabel(role: string): string {
		if (role === 'signer') return m.signing_role_signer();
		if (role === 'approver') return m.signing_role_approver();
		if (role === 'viewer') return m.signing_role_viewer();
		return m.signing_role_prefill();
	}

	function statusLabel(status: string): string {
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

	onMount(() => {
		if (data.state !== 'active') return;
		return initRecipientViewed({
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
									class={viewRecorded || data.access.recipientStatus === 'viewed'
										? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
										: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300'}
								>
									{statusLabel(viewRecorded ? 'viewed' : data.access.recipientStatus)}
								</Badge>
								{#if retryPending && !viewRecorded && data.access.recipientStatus !== 'viewed'}
									<span class="text-xs text-muted-foreground">
										{m.signing_view_retry_pending()}
									</span>
								{:else if viewFailed && !viewRecorded && data.access.recipientStatus !== 'viewed'}
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
					{m.signing_controls_next()}
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
