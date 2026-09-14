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
</script>

<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Alert from '$lib/components/ui/alert';
	import IconAlertTriangle from '@tabler/icons-svelte/icons/alert-triangle';
	import { cn } from '$lib/utils';

	let {
		src,
		label,
		expectedPageCount,
		loadingLabel,
		errorTitle,
		errorDescription,
		openLabel,
		class: className = '',
		overlay,
		onpages
	}: {
		/** Same-origin URL. Never carries a token: authority is the session cookie. */
		src: string;
		label: string;
		expectedPageCount: number;
		loadingLabel: string;
		errorTitle: string;
		errorDescription: string;
		openLabel: string;
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

	onMount(() => {
		let disposed = false;
		let observer: ResizeObserver | null = null;
		let lastWidth = 0;
		let frame = 0;

		void (async () => {
			try {
				const pdfjs = await loadPdfJs();
				const task = pdfjs.getDocument({
					url: src,
					// The document is served from this origin under the caller's own
					// session; credentials must ride along or the fetch is anonymous
					// and the server correctly refuses it.
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
				loaded = {
					renderPage: async (
						pageNumber: number,
						canvas: HTMLCanvasElement,
						cssWidth: number
					): Promise<void> => {
						const page = await document_.getPage(pageNumber);
						const base = page.getViewport({ scale: 1 });
						const ratio = Math.min(window.devicePixelRatio || 1, 2);
						const scale = (cssWidth / base.width) * ratio;
						const viewport = page.getViewport({ scale });
						canvas.width = Math.max(1, Math.floor(viewport.width));
						canvas.height = Math.max(1, Math.floor(viewport.height));
						const context = canvas.getContext('2d');
						if (context === null) throw new Error('2d canvas context unavailable');
						await page.render({ canvas, canvasContext: context, viewport }).promise;
					},
					destroy: (): Promise<void> => task.destroy()
				};
				pages = descriptors;
				canvases = descriptors.map((): null => null);
				onpages?.(descriptors);
				ready = true;
				scheduleRender();
			} catch {
				if (!disposed) failed = true;
			}
		})();

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
			lastWidth = cssWidth;
			const token = ++renderToken;
			for (const page of pages) {
				const canvas = canvases[page.pageNumber - 1];
				if (canvas === null || canvas === undefined) continue;
				try {
					await current.renderPage(page.pageNumber, canvas, cssWidth);
				} catch {
					if (token === renderToken) failed = true;
					return;
				}
				if (token !== renderToken) return;
			}
		}

		if (typeof ResizeObserver !== 'undefined') {
			observer = new ResizeObserver((): void => {
				if (container === null) return;
				// Only a real width change matters; height changes as pages render
				// and would otherwise loop.
				if (Math.abs(container.clientWidth - lastWidth) < 1) return;
				scheduleRender();
			});
			if (container !== null) observer.observe(container);
		}

		return () => {
			disposed = true;
			if (frame !== 0) cancelAnimationFrame(frame);
			observer?.disconnect();
			renderToken += 1;
			void loaded?.destroy();
			loaded = null;
		};
	});
</script>

<div class={cn('flex flex-col gap-4', className)} bind:this={container}>
	<!-- Always offered, not just on failure: the browser's own viewer gives
	     selectable text, printing, and assistive-technology support that a
	     canvas rendering cannot, and this link is same-origin and token-free. -->
	<a
		class="self-start text-sm font-medium underline underline-offset-4"
		href={src}
		target="_blank"
		rel="noopener"
	>
		{openLabel}
	</a>
	{#if failed}
		<Alert.Root variant="destructive">
			<IconAlertTriangle />
			<Alert.Title>{errorTitle}</Alert.Title>
			<Alert.Description>
				{errorDescription}
				<a
					class="font-medium underline underline-offset-4"
					href={src}
					target="_blank"
					rel="noopener"
				>
					{openLabel}
				</a>
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
