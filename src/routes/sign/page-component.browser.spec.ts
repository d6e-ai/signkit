import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import SignPage from './+page.svelte';
import type { PageData } from './$types';

test('hydrates the sanitized document surface without active or remote content', async () => {
	const exactSource =
		'# Terms\n\n3. Third clause\n4. Fourth clause\n\n[safe](https://example.com) [unsafe](javascript:alert(1))\n\n<img src="https://tracker.example/pixel.gif" onerror="alert(1)">\n\n![tracking](https://tracker.example/second.gif)\n\ncontrol:\u202e `code:\u2067`';
	const data: PageData = {
		state: 'active',
		access: {
			envelopeId: 'env-1',
			recipientId: 'recipient-1',
			role: 'viewer',
			locale: 'en',
			recipientStatus: 'viewed',
			envelopeTitle: 'Browser fixture',
			envelopeStatus: 'in_progress',
			expiresAt: '2026-09-12T00:00:00.000Z'
		},
		documents: [
			{
				path: 'documents/agreement.md',
				content: exactSource,
				rendered: renderRecipientMarkdown(exactSource)
			}
		],
		fields: [],
		fieldGeneration: 1
	};
	const screen = await render(SignPage, { data });
	const container: HTMLElement = screen.container;

	await expect.element(screen.getByRole('heading', { name: 'Terms' })).toBeVisible();
	expect(container.querySelector('ol')?.getAttribute('start')).toBe('3');
	expect(container.querySelector('script')).toBeNull();
	expect(container.querySelector('img')).toBeNull();
	expect(container.querySelector('[onerror]')).toBeNull();
	expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
	expect(container.querySelector('a[href="https://example.com"]')?.getAttribute('rel')).toBe(
		'noopener noreferrer'
	);
	expect(
		performance
			.getEntriesByType('resource')
			.some((entry: PerformanceEntry): boolean => entry.name.includes('tracker.example'))
	).toBe(false);
	await expect.element(screen.getByText('⟦U+202E⟧')).toBeVisible();
	await expect.element(screen.getByText('code:⟦U+2067⟧')).toBeVisible();

	await screen.getByRole('tab', { name: 'Source' }).click();
	const source = container.querySelector('pre');
	expect(source?.textContent).toBe(exactSource);
	await expect.element(screen.getByText('Exact Markdown source for verification.')).toBeVisible();
});
