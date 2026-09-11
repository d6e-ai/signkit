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
		expect(body).not.toContain('Decline request');
	});

	it('renders decline controls for signer and approver roles with >= 44px touch target', () => {
		for (const role of ['signer', 'approver'] as const) {
			const data: PageData = {
				state: 'active',
				access: {
					envelopeId: '00000000-0000-8000-a000-000000000001',
					recipientId: '00000000-0000-8000-a000-000000000002',
					role,
					locale: 'en',
					recipientStatus: 'pending',
					envelopeTitle: 'Service Agreement',
					envelopeStatus: 'sent',
					expiresAt: '2026-09-12T00:00:00.000Z'
				},
				documents: [{ path: 'documents/NDA.md', content: 'Agreement content' }]
			};
			const { body } = render(SignPage, { props: { data } });

			expect(body).toContain('Decline request');
			expect(body).toContain('min-h-[44px]');
			expect(body).toContain('aria-haspopup="dialog"');
			expect(body).toContain('role="status"');
			expect(body).toContain('aria-live="polite"');
		}
	});

	it('never renders decline controls for viewer or prefill roles', () => {
		for (const role of ['viewer', 'prefill'] as const) {
			const data: PageData = {
				state: 'active',
				access: {
					envelopeId: '00000000-0000-8000-a000-000000000001',
					recipientId: '00000000-0000-8000-a000-000000000002',
					role,
					locale: 'en',
					recipientStatus: 'pending',
					envelopeTitle: 'Service Agreement',
					envelopeStatus: 'sent',
					expiresAt: '2026-09-12T00:00:00.000Z'
				},
				documents: [{ path: 'documents/NDA.md', content: 'Agreement content' }]
			};
			const { body } = render(SignPage, { props: { data } });

			expect(body).not.toContain('Decline request');
			expect(body).not.toContain('aria-haspopup="dialog"');
		}
	});

	it('provides localized decline dialog messages that identify request termination without claiming signature or PDF behavior', async () => {
		const en = (await import('../../../messages/en.json')).default;
		const ja = (await import('../../../messages/ja.json')).default;

		for (const messages of [en, ja]) {
			expect(messages.signing_decline_dialog_title).toBeTruthy();
			expect(messages.signing_decline_dialog_description).toBeTruthy();
			expect(messages.signing_decline_dialog_cancel).toBeTruthy();
			expect(messages.signing_decline_dialog_confirm).toBeTruthy();

			const combined = `${messages.signing_decline_dialog_title} ${messages.signing_decline_dialog_description}`;
			expect(combined).not.toMatch(/pades/i);
			expect(combined).not.toMatch(/\bpdf\b/i);
			expect(combined).not.toMatch(/signature/i);
		}

		expect(en.signing_decline_dialog_description).toContain('Declining ends this request');
		expect(ja.signing_decline_dialog_description).toContain('辞退するとこの依頼は終了します');
	});
});
