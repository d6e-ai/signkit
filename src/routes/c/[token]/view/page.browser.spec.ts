import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ReceiptPage from './+page.svelte';
import type { CompletionReceiptPageState } from './+page.server';

const { TOKEN } = vi.hoisted(() => ({
	TOKEN: 'skca1_' + 'a'.repeat(43)
}));

vi.mock('$app/state', () => ({
	page: {
		url: new URL(`https://signkit.example/c/${TOKEN}/view`),
		params: { token: TOKEN },
		route: { id: '/c/[token]/view' },
		status: 200,
		error: null,
		data: {},
		form: null,
		state: {}
	}
}));

describe('completion receipt page in browser', () => {
	it('published with a PDF: offers final PDF and evidence downloads as real, keyboard-reachable links', async () => {
		const data: CompletionReceiptPageState = { state: 'published', pdfAvailable: true };
		const screen = await render(ReceiptPage, { data });

		const pdfLink = screen.getByRole('link', { name: 'Download final PDF' });
		await expect.element(pdfLink).toBeVisible();
		expect(pdfLink.element().getAttribute('href')).toBe(`/c/${TOKEN}?format=pdf`);
		expect(pdfLink.element().tagName).toBe('A');

		const jsonLink = screen.getByRole('link', { name: 'Download evidence (JSON)' });
		expect(jsonLink.element().getAttribute('href')).toBe(`/c/${TOKEN}?format=json`);
		const markdownLink = screen.getByRole('link', { name: 'Download evidence (Markdown)' });
		expect(markdownLink.element().getAttribute('href')).toBe(`/c/${TOKEN}?format=markdown`);
	});

	it('published without a PDF yet: notes the PDF is pending but still offers evidence downloads', async () => {
		const data: CompletionReceiptPageState = { state: 'published', pdfAvailable: false };
		const screen = await render(ReceiptPage, { data });

		await expect
			.element(screen.getByText('The final PDF is still being prepared. Please check back soon.'))
			.toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'Download final PDF' }))
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByRole('link', { name: 'Download evidence (JSON)' }))
			.toBeVisible();
	});

	it('invalid: shows one opaque message for an unknown, expired, revoked, or wrong-purpose token', async () => {
		const data: CompletionReceiptPageState = { state: 'invalid' };
		const screen = await render(ReceiptPage, { data });

		await expect.element(screen.getByText('This link is not active')).toBeVisible();
		await expect
			.element(screen.getByRole('link', { name: 'Download final PDF' }))
			.not.toBeInTheDocument();
	});

	it('unavailable: reports a transient failure distinct from an invalid link', async () => {
		const data: CompletionReceiptPageState = { state: 'unavailable' };
		const screen = await render(ReceiptPage, { data });

		await expect.element(screen.getByText('This page is temporarily unavailable')).toBeVisible();
	});
});
