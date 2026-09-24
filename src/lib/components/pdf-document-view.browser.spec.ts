import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import { renderAgreementPdf } from '$lib/adapters/pdf/agreement-pdf';
import PdfDocumentViewTestHost from './pdf-document-view-test-host.svelte';
import { sampleAgreementJaUrl } from './sample-agreement-ja-fixture';

/**
 * Renders a PDF this codebase produced, through the viewer this codebase ships.
 * Anything less would leave the two halves of the recipient's document surface
 * untested against each other.
 */
function agreementUrl(): { url: string; revoke: () => void } {
	const result = renderAgreementPdf([
		{
			title: 'Agreement',
			nodes: renderRecipientMarkdown('# 業務委託契約書\n\n本契約は甲と乙が締結する。\n').nodes
		},
		{
			title: 'Exhibit A',
			nodes: renderRecipientMarkdown('# Exhibit A\n\nSchedule of fees.\n').nodes
		}
	]);
	const copy: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(result.bytes.byteLength));
	copy.set(result.bytes);
	const url: string = URL.createObjectURL(new Blob([copy], { type: 'application/pdf' }));
	return { url, revoke: (): void => URL.revokeObjectURL(url) };
}

function singlePageUrl(): { url: string; revoke: () => void } {
	const result = renderAgreementPdf([
		{
			title: 'Short Agreement',
			nodes: renderRecipientMarkdown('# 短期契約書\n\n条文内容テキスト。\n').nodes
		}
	]);
	const copy: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(result.bytes.byteLength));
	copy.set(result.bytes);
	const url: string = URL.createObjectURL(new Blob([copy], { type: 'application/pdf' }));
	return { url, revoke: (): void => URL.revokeObjectURL(url) };
}

/**
 * Counts non-background pixels in a given vertical slice of the canvas.
 * Unrendered canvases (or default 300x150 empty ones) have alpha = 0.
 * A blank white page has RGBA (255, 255, 255, 255).
 * Document content (text, lines, fills) has non-white pixels (e.g. RGB < 240).
 */
function countContentPixels(
	canvas: HTMLCanvasElement,
	options: { yStartFraction?: number; yEndFraction?: number } = {}
): number {
	const context = canvas.getContext('2d');
	if (context === null || canvas.width === 0 || canvas.height === 0) return 0;
	if (canvas.width === 300 && canvas.height === 150) return 0;

	const yStartFraction = options.yStartFraction ?? 0.1;
	const yEndFraction = options.yEndFraction ?? 0.85;
	const startY = Math.floor(canvas.height * yStartFraction);
	const endY = Math.floor(canvas.height * yEndFraction);
	const width = canvas.width;
	const height = Math.max(1, endY - startY);
	const pixels = context.getImageData(0, startY, width, height).data;

	let count = 0;
	for (let offset = 0; offset < pixels.length; offset += 4) {
		const a = pixels[offset + 3];
		if (a === 0) continue;
		const r = pixels[offset];
		const g = pixels[offset + 1];
		const b = pixels[offset + 2];
		if (r < 240 || g < 240 || b < 240) {
			count += 1;
		}
	}
	return count;
}

test('renders every page of a SignKit-produced PDF and visibly paints document content pixels on initial load', async () => {
	const { url, revoke } = agreementUrl();
	try {
		const screen = await render(PdfDocumentViewTestHost, { src: url });

		// One box per page, positioned in percentage units so it tracks the page
		// through zoom and responsive resizing without any pixel arithmetic.
		await expect.element(screen.getByTestId('overlay-1')).toBeInTheDocument();
		await expect.element(screen.getByTestId('overlay-2')).toBeInTheDocument();

		const pages = screen.container.querySelectorAll('[data-pdf-page]');
		expect(pages).toHaveLength(2);

		for (const [index, page] of [...pages].entries()) {
			expect(page.getAttribute('data-pdf-page')).toBe(String(index + 1));
			const canvas = page.querySelector('canvas') as HTMLCanvasElement | null;
			expect(canvas).not.toBeNull();
			expect(canvas!.width).toBeGreaterThan(0);
			expect(canvas!.height).toBeGreaterThan(0);

			// Real pixel test: canvas must contain rasterized document text/content,
			// not only transparent or white background.
			await expect
				.poll((): number => countContentPixels(canvas!), { timeout: 5000 })
				.toBeGreaterThan(50);

			const overlay = page.querySelector('[data-testid^="overlay-"]') as HTMLElement;
			expect(overlay.dataset.testid).toBe(`overlay-${index + 1}`);
			expect(overlay.style.left).toBe('10%');
			expect(overlay.style.top).toBe('20%');
			expect(overlay.style.width).toBe('30%');
			expect(overlay.style.height).toBe('6%');
		}

		// The fallback link points at the same token-free source.
		const link = screen.container.querySelector('a[href]') as HTMLAnchorElement;
		expect(link.getAttribute('href')).toBe(url);
		expect(screen.container.textContent).not.toContain('could not be displayed');
	} finally {
		revoke();
	}
});

test('visibly paints document content pixels after document navigation and reload', async () => {
	const doc1 = agreementUrl();
	const doc2 = singlePageUrl();

	try {
		// Initial load
		const screen = await render(PdfDocumentViewTestHost, { src: doc1.url });
		await expect
			.poll((): HTMLCanvasElement | null => screen.container.querySelector('canvas'))
			.not.toBeNull();
		const page1Canvas = screen.container.querySelector('canvas') as HTMLCanvasElement;
		await expect
			.poll((): number => countContentPixels(page1Canvas), { timeout: 5000 })
			.toBeGreaterThan(50);

		// Navigation to another document
		await screen.rerender({ src: doc2.url });
		await expect
			.poll((): number => screen.container.querySelectorAll('[data-pdf-page]').length)
			.toBe(1);
		await expect
			.poll((): HTMLCanvasElement | null => screen.container.querySelector('canvas'))
			.not.toBeNull();
		const doc2Canvas = screen.container.querySelector('canvas') as HTMLCanvasElement;
		await expect
			.poll((): number => countContentPixels(doc2Canvas), { timeout: 5000 })
			.toBeGreaterThan(50);

		// Navigation back to first document
		await screen.rerender({ src: doc1.url });
		await expect
			.poll((): number => screen.container.querySelectorAll('[data-pdf-page]').length)
			.toBe(2);
		await expect
			.poll((): HTMLCanvasElement | null => screen.container.querySelector('canvas'))
			.not.toBeNull();
		const returnedCanvas = screen.container.querySelector('canvas') as HTMLCanvasElement;
		await expect
			.poll((): number => countContentPixels(returnedCanvas), { timeout: 5000 })
			.toBeGreaterThan(50);

		// Reload (unmount and fresh mount)
		screen.unmount();
		const reloaded = await render(PdfDocumentViewTestHost, { src: doc1.url });
		await expect
			.poll((): HTMLCanvasElement | null => reloaded.container.querySelector('canvas'))
			.not.toBeNull();
		const reloadedCanvas = reloaded.container.querySelector('canvas') as HTMLCanvasElement;
		await expect
			.poll((): number => countContentPixels(reloadedCanvas), { timeout: 5000 })
			.toBeGreaterThan(50);
		reloaded.unmount();
	} finally {
		doc1.revoke();
		doc2.revoke();
	}
});

test('renders Japanese contract with CID/CMap fonts (issue #172 sample agreement) with visible text in document content region', async () => {
	const { url, revoke } = sampleAgreementJaUrl();
	try {
		const screen = await render(PdfDocumentViewTestHost, { src: url });
		await expect
			.poll((): number => screen.container.querySelectorAll('[data-pdf-page]').length)
			.toBe(1);
		await expect
			.poll((): HTMLCanvasElement | null => screen.container.querySelector('canvas'))
			.not.toBeNull();

		const canvas = screen.container.querySelector('canvas') as HTMLCanvasElement;

		// Check decorative orange header strip near the top (y: 1% to 9%)
		await expect
			.poll(
				(): number => countContentPixels(canvas, { yStartFraction: 0.01, yEndFraction: 0.09 }),
				{ timeout: 5000 }
			)
			.toBeGreaterThan(50);

		// CRITICAL: Check document content region (y: 12% to 75%) where the Japanese contract
		// title and body text are located. Merely checking that a canvas exists or that the
		// orange strip is present is insufficient; Japanese glyphs require CMap support to render.
		await expect
			.poll(
				(): number => countContentPixels(canvas, { yStartFraction: 0.12, yEndFraction: 0.75 }),
				{ timeout: 5000 }
			)
			.toBeGreaterThan(100);
	} finally {
		revoke();
	}
});

test('handles zero-width container and recovers cleanly when container width expands', async () => {
	const { url, revoke } = agreementUrl();
	try {
		const screen = await render(PdfDocumentViewTestHost, {
			src: url,
			wrapperStyle: 'width: 0px; overflow: hidden;'
		});

		// Wait for document to be ready and canvas to be mounted (with clientWidth 0)
		await expect
			.poll((): HTMLCanvasElement | null => screen.container.querySelector('canvas'))
			.not.toBeNull();
		const canvas = screen.container.querySelector('canvas') as HTMLCanvasElement;
		// Since width was 0, content pixels are 0
		expect(countContentPixels(canvas)).toBe(0);

		// Expand container width and trigger resize
		const wrapper = screen.container.querySelector(
			'[data-testid="pdf-view-wrapper"]'
		) as HTMLElement;
		expect(wrapper).not.toBeNull();
		wrapper.style.width = '600px';
		window.dispatchEvent(new Event('resize'));

		// Should recover and visibly paint content pixels rather than leaving permanently blank canvas
		await expect
			.poll((): number => countContentPixels(canvas), { timeout: 5000 })
			.toBeGreaterThan(50);
	} finally {
		revoke();
	}
});

test('handles rapid resize without leaving a permanently blank canvas or failing', async () => {
	const { url, revoke } = agreementUrl();
	try {
		const screen = await render(PdfDocumentViewTestHost, { src: url });
		await expect
			.poll((): HTMLCanvasElement | null => screen.container.querySelector('canvas'))
			.not.toBeNull();
		const canvas = screen.container.querySelector('canvas') as HTMLCanvasElement;

		// Trigger rapid burst of resize events
		for (let i = 0; i < 5; i += 1) {
			window.dispatchEvent(new Event('resize'));
		}

		await expect
			.poll((): number => countContentPixels(canvas), { timeout: 5000 })
			.toBeGreaterThan(50);
		expect(screen.container.textContent).not.toContain('could not be displayed');
	} finally {
		revoke();
	}
});

test('reports an explicit localized error and usable fallback on render failure (EN)', async () => {
	const screen = await render(PdfDocumentViewTestHost, {
		src: '/this-path-does-not-exist.pdf'
	});

	await expect
		.element(screen.getByRole('alert'))
		.toHaveTextContent('The agreement could not be displayed');
	await expect
		.element(screen.getByText('Reload this page to try again, or open the document in a new tab.'))
		.toBeInTheDocument();

	// Fallback button inside alert
	const fallbackButton = screen.container.querySelector(
		'a[data-slot="button"][target="_blank"]'
	) as HTMLAnchorElement | null;
	expect(fallbackButton).not.toBeNull();
	expect(fallbackButton!.getAttribute('href')).toBe('/this-path-does-not-exist.pdf');
	expect(fallbackButton!.textContent).toContain('Open the agreement');
	expect(screen.container.querySelectorAll('[data-pdf-page]')).toHaveLength(0);
});

test('reports an explicit localized error and usable fallback on render failure (JA)', async () => {
	const screen = await render(PdfDocumentViewTestHost, {
		src: '/this-path-does-not-exist-ja.pdf',
		errorTitle: '契約書を表示できませんでした',
		errorDescription: 'ページを再読み込みするか、新しいタブで文書を開いてください。',
		openLabel: '契約書を開く'
	});

	await expect.element(screen.getByRole('alert')).toHaveTextContent('契約書を表示できませんでした');
	await expect
		.element(screen.getByText('ページを再読み込みするか、新しいタブで文書を開いてください。'))
		.toBeInTheDocument();

	const fallbackButton = screen.container.querySelector(
		'a[data-slot="button"][target="_blank"]'
	) as HTMLAnchorElement | null;
	expect(fallbackButton).not.toBeNull();
	expect(fallbackButton!.getAttribute('href')).toBe('/this-path-does-not-exist-ja.pdf');
	expect(fallbackButton!.textContent).toContain('契約書を開く');
	expect(screen.container.querySelectorAll('[data-pdf-page]')).toHaveLength(0);
});
