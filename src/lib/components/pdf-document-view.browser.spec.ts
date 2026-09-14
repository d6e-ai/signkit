import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import { renderAgreementPdf } from '$lib/adapters/pdf/agreement-pdf';
import PdfDocumentViewTestHost from './pdf-document-view-test-host.svelte';

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

test('renders every page of a SignKit-produced PDF and positions overlays on them', async () => {
	const { url, revoke } = agreementUrl();
	try {
		const screen = await render(PdfDocumentViewTestHost, { src: url });

		// One box per page, positioned in percentage units so it tracks the page
		// through zoom and responsive resizing without any pixel arithmetic.
		await expect.element(screen.getByTestId('overlay-1')).toBeInTheDocument();
		await expect.element(screen.getByTestId('overlay-2')).toBeInTheDocument();

		const pages = screen.container.querySelectorAll('[data-pdf-page]');
		expect(pages).toHaveLength(2);
		pages.forEach((page: Element, index: number): void => {
			expect(page.getAttribute('data-pdf-page')).toBe(String(index + 1));
			const canvas = page.querySelector('canvas') as HTMLCanvasElement | null;
			expect(canvas).not.toBeNull();
			// A real rasterization of a real page, not an empty element.
			expect(canvas!.width).toBeGreaterThan(0);
			expect(canvas!.height).toBeGreaterThan(0);

			// The overlay for page N is a child of page N's box and is positioned
			// in unit-square fractions of it, which is what keeps a field box in
			// place across zoom, responsive resizing, and device pixel ratio.
			// (Only the declared geometry is asserted here: the test runner mounts
			// the component without the app stylesheet, so Tailwind's layout
			// utilities are inert and resolved pixel boxes are meaningless.)
			const overlay = page.querySelector('[data-testid^="overlay-"]') as HTMLElement;
			expect(overlay.dataset.testid).toBe(`overlay-${index + 1}`);
			expect(overlay.style.left).toBe('10%');
			expect(overlay.style.top).toBe('20%');
			expect(overlay.style.width).toBe('30%');
			expect(overlay.style.height).toBe('6%');
		});

		// The fallback link points at the same token-free source.
		const link = screen.container.querySelector('a[href]') as HTMLAnchorElement;
		expect(link.getAttribute('href')).toBe(url);
		expect(screen.container.textContent).not.toContain('could not be displayed');
	} finally {
		revoke();
	}
});

test('reports a failure instead of rendering a blank document surface', async () => {
	const screen = await render(PdfDocumentViewTestHost, {
		src: '/this-path-does-not-exist.pdf'
	});
	await expect
		.element(screen.getByRole('alert'))
		.toHaveTextContent('The agreement could not be displayed');
	expect(screen.container.querySelectorAll('[data-pdf-page]')).toHaveLength(0);
});
