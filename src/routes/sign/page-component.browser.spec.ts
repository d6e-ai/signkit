import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { RecipientPlacedField } from '$lib/application/signing/recipient-workspace';
import SignPage from './+page.svelte';
import type { PageData } from './$types';

const signatureField: RecipientPlacedField = {
	id: '01910000-0000-7000-8000-000000000003',
	fieldType: 'signature',
	label: 'Your signature',
	required: true,
	geometry: { page: 1, x: 0.12, y: 0.34, width: 0.3, height: 0.06 }
};

function data(overrides: Partial<{ role: 'signer' | 'viewer' }> = {}): PageData {
	return {
		state: 'active',
		access: {
			envelopeId: '01910000-0000-7000-8000-000000000001',
			recipientId: '01910000-0000-7000-8000-000000000002',
			recipientName: 'Alex Rivera',
			role: overrides.role ?? 'viewer',
			locale: 'en',
			recipientStatus: 'viewed',
			envelopeTitle: 'Browser fixture',
			envelopeStatus: 'in_progress',
			expiresAt: '2026-09-12T00:00:00.000Z'
		},
		document: {
			pageCount: 1,
			pageWidth: 595.28,
			pageHeight: 841.89,
			sections: [{ title: 'agreement', firstPage: 1, lastPage: 1 }]
		},
		fields: overrides.role === 'signer' ? [signatureField] : [],
		fieldGeneration: 1
	} as PageData;
}

test('hydrates the signing surface without active or remote document content', async () => {
	const screen = await render(SignPage, { data: data() });
	const container: HTMLElement = screen.container;

	// No inline document markup at all: the agreement only ever arrives as a
	// rendered PDF over the session-protected endpoint.
	expect(container.querySelector('script')).toBeNull();
	expect(container.querySelector('img')).toBeNull();
	expect(container.querySelector('[onerror]')).toBeNull();
	expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
	expect(container.textContent).not.toContain('Exact Markdown source for verification.');
	expect(container.textContent).not.toContain('External images are omitted');
	expect(container.textContent).not.toContain('Markdown');
	expect(container.textContent).toContain('Action required');
	expect(container.textContent).not.toContain('Viewed');

	// Every request the page makes stays on this origin.
	expect(
		performance
			.getEntriesByType('resource')
			.some((entry: PerformanceEntry): boolean => !entry.name.startsWith(window.location.origin))
	).toBe(false);
});

test('offers the decline action once, inside the agreement summary card', async () => {
	const screen = await render(SignPage, { data: { ...data({ role: 'signer' }) } });
	const buttons = screen.container.querySelectorAll('button');
	const declineButtons = [...buttons].filter(
		(button: Element): boolean => button.textContent?.trim() === 'Decline request'
	);
	expect(declineButtons).toHaveLength(1);
	await expect.element(screen.getByRole('button', { name: 'Decline request' })).toBeVisible();
});
