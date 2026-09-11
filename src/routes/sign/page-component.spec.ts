import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import SignPage from './+page.svelte';
import type { PageData } from './$types';

describe('recipient document review page', () => {
	it('renders multiple documents and escapes hostile Markdown HTML', () => {
		const data: PageData = {
			state: 'active',
			access: {
				envelopeId: 'env-1',
				recipientId: 'recipient-1',
				role: 'signer',
				locale: 'en',
				recipientStatus: 'pending',
				envelopeTitle: 'Service Agreement',
				envelopeStatus: 'sent',
				expiresAt: '2026-09-12T00:00:00.000Z'
			},
			documents: [
				{ path: 'documents/NDA_v1.md', content: '# Terms\n<script>alert(1)</script>\n' },
				{ path: 'documents/schedule-a.md', content: '## Schedule A\n' }
			]
		};
		const { body } = render(SignPage, { props: { data } });

		expect(body).toContain('Service Agreement');
		expect(body).toContain('NDA v1');
		expect(body).toContain('schedule a');
		expect(body).toContain('href="#document-1"');
		expect(body).toContain('&lt;script>alert(1)&lt;/script>');
		expect(body).not.toContain('<script>alert(1)</script>');
	});

	it.each([
		['invalid', 'This signing link is not active'],
		['unavailable', 'Signing access is temporarily unavailable']
	] as const)('renders the %s state without document content', (state, expected) => {
		const data: PageData = { state };
		const { body } = render(SignPage, { props: { data } });
		expect(body).toContain(expected);
		expect(body).not.toContain('Agreement documents');
	});
});
