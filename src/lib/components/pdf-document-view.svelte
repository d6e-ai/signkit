<script lang="ts" module>
	export interface PdfRenderedPage {
		pageNumber: number;
		/** Page aspect ratio, used to size the overlay box before the bitmap lands. */
		widthPoints: number;
		heightPoints: number;
	}

	/**
	 * Loaded lazily and only in the browser: the viewer is a large dependency
	 * that nothing on the server needs, and importing it at module scope would
	 * drag it into every SSR bundle.
	 */
	async function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
		const pdfjs = await import('pdfjs-dist');
		if (pdfjs.GlobalWorkerOptions.workerSrc === '') {
			// `?url` lets the bundler emit the worker as a same-origin asset and
			// hand back its resolved href, which works identically in dev, in the
			// browser test runner, and in all three production builds.
			const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
			pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
		}
		return pdfjs;
	}

	function isCancelledException(error: unknown): boolean {
		if (error && typeof error === 'object') {
			const name = (error as { name?: string }).name;
			if (name === 'RenderingCancelledException') return true;
			const message = (error as { message?: string }).message;
			if (typeof message === 'string' && message.includes('Rendering cancelled')) return true;
		}
		return false;
	}
</script>

<script lang="ts">
	import { onMount, tick, untrack, type Snippet } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import * as m from '$lib/paraglide/messages';
	import { cn } from '$lib/utils';

	let {
		src,
		label = m.signing_document_label(),
		expectedPageCount = 1,
		loadingLabel = m.signing_document_loading(),
		errorTitle = m.signing_document_error_title(),
		errorDescription = m.signing_document_error_description(),
		openLabel = m.signing_document_open(),
		class: className = '',
		overlay,
		onpages
	}: {
		/** Same-origin URL. Never carries a token: authority is the session cookie. */
		src: string;
		label?: string;
		expectedPageCount?: number;
		loadingLabel?: string;
		errorTitle?: string;
		errorDescription?: string;
		openLabel?: string;
		class?: string;
		/** Rendered inside each page box, positioned in percentage units. */
		overlay?: Snippet<[PdfRenderedPage]>;
		onpages?: (pages: readonly PdfRenderedPage[]) => void;
	} = $props();

	let pages = $state<PdfRenderedPage[]>([]);
	/** Placeholder page numbers shown while the first render is in flight. */
	let placeholderPages = $derived(
		Array.from(
			{ length: Math.max(1, Math.min(expectedPageCount, 3)) },
			(value: unknown, index: number): number => index + 1
		)
	);
	let failed = $state(false);
	let ready = $state(false);
	let canvases = $state<(HTMLCanvasElement | null)[]>([]);
	let container = $state<HTMLDivElement | null>(null);

	interface LoadedDocument {
		renderPage(pageNumber: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void>;
		destroy(): Promise<void>;
	}
	let loaded: LoadedDocument | null = null;
	let renderToken = 0;
	let lastWidth = 0;
	let frame = 0;

	function scheduleRender(): void {
		if (frame !== 0) cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => {
			frame = 0;
			void renderAll();
		});
	}

	async function renderAll(): Promise<void> {
		const current = loaded;
		if (current === null || container === null) return;
		const cssWidth = container.clientWidth;
		if (cssWidth <= 0) return;

		// Ensure canvas elements are flushed and bound to our state array
		if (canvases.length < pages.length || canvases.some((c) => c === null || c === undefined)) {
			await tick();
			if (canvases.length < pages.length || canvases.some((c) => c === null || c === undefined)) {
				scheduleRender();
				return;
			}
		}

		const token = ++renderToken;
		for (const page of pages) {
			const canvas = canvases[page.pageNumber - 1];
			if (canvas === null || canvas === undefined) continue;
			try {
				await current.renderPage(page.pageNumber, canvas, cssWidth);
			} catch (err: unknown) {
				if (isCancelledException(err) || token !== renderToken) return;
				failed = true;
				return;
			}
			if (token !== renderToken) return;
		}

		if (token === renderToken) {
			lastWidth = cssWidth;
		}
	}

	$effect(() => {
		const currentSrc = src;
		let disposed = false;
		let activeDoc: LoadedDocument | null = null;

		untrack(() => {
			lastWidth = 0;
			if (!currentSrc) {
				pages = [];
				canvases = [];
				ready = false;
				failed = false;
				return;
			}

			ready = false;
			failed = false;
			pages = [];
			canvases = [];

			void (async () => {
				try {
					const pdfjs = await loadPdfJs();
					const cMapUrl =
						typeof window !== 'undefined'
							? new URL('/pdfjs/cmaps/', window.location.origin).href
							: undefined;
					const standardFontDataUrl =
						typeof window !== 'undefined'
							? new URL('/pdfjs/standard_fonts/', window.location.origin).href
							: undefined;

					const task = pdfjs.getDocument({
						url: currentSrc,
						cMapUrl,
						cMapPacked: true,
						standardFontDataUrl,
						withCredentials: true
					});

					const document_ = await task.promise;
					if (disposed) {
						await task.destroy();
						return;
					}

					const descriptors: PdfRenderedPage[] = [];
					for (let pageNumber = 1; pageNumber <= document_.numPages; pageNumber += 1) {
						const page = await document_.getPage(pageNumber);
						const viewport = page.getViewport({ scale: 1 });
						descriptors.push({
							pageNumber,
							widthPoints: viewport.width,
							heightPoints: viewport.height
						});
					}

					const activeTasks = new SvelteMap<number, import('pdfjs-dist').RenderTask>();
					// Serializes renderPage calls per page number so a cancelled task's
					// teardown (which spans an await) can never overlap with the next
					// task's page.render() on the same canvas.
					const renderChains = new Map<number, Promise<void>>();

					activeDoc = {
						renderPage: (
							pageNumber: number,
							canvas: HTMLCanvasElement,
							cssWidth: number
						): Promise<void> => {
							const existing = activeTasks.get(pageNumber);
							existing?.cancel();

							const previous = renderChains.get(pageNumber) ?? Promise.resolve();
							const next = previous.catch(() => {}).then(async () => {
								const page = await document_.getPage(pageNumber);
								const base = page.getViewport({ scale: 1 });
								const ratio = Math.min(window.devicePixelRatio || 1, 2);
								const scale = (cssWidth / base.width) * ratio;
								const viewport = page.getViewport({ scale });
								canvas.width = Math.max(1, Math.floor(viewport.width));
								canvas.height = Math.max(1, Math.floor(viewport.height));
								const context = canvas.getContext('2d');
								if (context === null) throw new Error('2d canvas context unavailable');

								const renderTask = page.render({ canvas, canvasContext: context, viewport });
								activeTasks.set(pageNumber, renderTask);
								try {
									await renderTask.promise;
								} catch (err: unknown) {
									if (isCancelledException(err)) return;
									throw err;
								} finally {
									if (activeTasks.get(pageNumber) === renderTask) {
										activeTasks.delete(pageNumber);
									}
								}
							});
							renderChains.set(pageNumber, next);
							return next;
						},
						destroy: async (): Promise<void> => {
							for (const active of activeTasks.values()) {
								active.cancel();
							}
							activeTasks.clear();
							renderChains.clear();
							await task.destroy();
						}
					};

					if (disposed) {
						await activeDoc.destroy();
						return;
					}

					loaded = activeDoc;
					pages = descriptors;
					canvases = descriptors.map((): null => null);
					onpages?.(descriptors);
					ready = true;

					// Wait for Svelte to mount canvas DOM nodes and assign bindings
					await tick();
					if (!disposed) {
						scheduleRender();
					}
				} catch {
					if (!disposed) failed = true;
				}
			})();
		});

		return () => {
			disposed = true;
			if (frame !== 0) {
				cancelAnimationFrame(frame);
				frame = 0;
			}
			renderToken += 1;
			void activeDoc?.destroy();
			if (loaded === activeDoc) loaded = null;
		};
	});

	onMount(() => {
		let observer: ResizeObserver | null = null;

		if (typeof ResizeObserver !== 'undefined' && container !== null) {
			observer = new ResizeObserver((): void => {
				if (container === null) return;
				const currentWidth = container.clientWidth;
				if (currentWidth <= 0) return;
				if (Math.abs(currentWidth - lastWidth) < 1) return;
				scheduleRender();
			});
			observer.observe(container);
		}

		const onWindowResize = (): void => {
			if (container === null) return;
			const currentWidth = container.clientWidth;
			if (currentWidth <= 0) return;
			if (Math.abs(currentWidth - lastWidth) < 1) return;
			scheduleRender();
		};
		window.addEventListener('resize', onWindowResize);

		return () => {
			observer?.disconnect();
			window.removeEventListener('resize', onWindowResize);
			if (frame !== 0) cancelAnimationFrame(frame);
		};
	});
</script>

<div class={cn('flex flex-col gap-4', className)} bind:this={container}>
	<!-- Always offered, not just on failure: the browser's own viewer gives
	     selectable text, printing, and assistive-technology support that a
	     canvas rendering cannot, and this link is same-origin and token-free. -->
	{#if src}
		<a
			class="self-start text-sm font-medium underline underline-offset-4"
			href={src}
			target="_blank"
			rel="noopener"
		>
			{openLabel}
		</a>
	{/if}
	{#if failed}
		<Alert.Root variant="destructive">
			<IconAlertTriangle />
			<Alert.Title>{errorTitle}</Alert.Title>
			<Alert.Description class="flex flex-col gap-3">
				<p>{errorDescription}</p>
				{#if src}
					<div>
						<Button variant="outline" size="sm" href={src} target="_blank" rel="noopener">
							{openLabel}
						</Button>
					</div>
				{/if}
			</Alert.Description>
		</Alert.Root>
	{:else if !ready}
		<span class="sr-only" role="status">{loadingLabel}</span>
		{#each placeholderPages as pageNumber (pageNumber)}
			<Skeleton class="w-full rounded-xl" style="aspect-ratio: 1 / 1.414;" />
		{/each}
	{:else}
		{#each pages as page (page.pageNumber)}
			<div
				class="relative w-full overflow-hidden rounded-xl border bg-background shadow-sm"
				style="aspect-ratio: {page.widthPoints} / {page.heightPoints};"
				data-pdf-page={page.pageNumber}
			>
				<!-- The canvas is a picture of the page, so it is labelled but not
				     the accessible route into the document: the link above opens the
				     same PDF in the browser's own viewer, where the text is real. -->
				<canvas
					bind:this={canvases[page.pageNumber - 1]}
					class="block h-full w-full"
					aria-hidden="true"
				></canvas>
				<span class="sr-only">{label} — {page.pageNumber} / {pages.length}</span>
				{#if overlay}
					<div class="absolute inset-0">{@render overlay(page)}</div>
				{/if}
			</div>
		{/each}
	{/if}
</div>
