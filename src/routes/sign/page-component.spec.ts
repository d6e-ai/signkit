import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { renderRecipientMarkdown } from '$lib/security/recipient-markdown';
import SignPage from './+page.svelte';
import type { PageData } from './$types';

function document(path: `documents/${string}.md`, content: string) {
	return { path, content, rendered: renderRecipientMarkdown(content) };
}

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
				document('documents/NDA_v1.md', '# Terms\n<script>alert(1)</script>\n'),
				document('documents/schedule-a.md', '## Schedule A\n')
			],
			fields: [],
			fieldGeneration: 1
		};
		const { body } = render(SignPage, { props: { data } });

		expect(body).toContain('Service Agreement');
		expect(body).toContain('NDA v1');
		expect(body).toContain('schedule a');
		expect(body).toContain('href="#document-1"');
		expect(body).toMatch(/<h1[^>]*>.*Terms.*<\/h1>/su);
		expect(body).toContain('&lt;script>alert(1)&lt;/script>');
		expect(body).not.toContain('<script>alert(1)</script>');
		expect(body).toContain('Formatted');
		expect(body).toContain('Source');
		expect(body).not.toContain('{@html');
	});

	it('renders only policy-approved links and handles void Markdown elements', () => {
		const data: PageData = {
			state: 'active',
			access: {
				envelopeId: 'env-1',
				recipientId: 'recipient-1',
				role: 'viewer',
				locale: 'ja',
				recipientStatus: 'viewed',
				envelopeTitle: '契約書',
				envelopeStatus: 'in_progress',
				expiresAt: '2026-09-12T00:00:00.000Z'
			},
			documents: [
				document(
					'documents/agreement.md',
					'[safe](https://example.com) [unsafe](javascript:alert(1))\n\n---\nline  \nbreak\n\n!\u005btrack\u005d(https://tracker.example/pixel.gif)\n\ncontrol:\u202e'
				)
			],
			fields: [],
			fieldGeneration: 1
		};
		const { body } = render(SignPage, { props: { data } });

		expect(body).toContain('href="https://example.com"');
		expect(body).toContain('target="_blank"');
		expect(body).toContain('rel="noopener noreferrer"');
		expect(body).not.toContain('href="javascript:');
		expect(body).not.toContain('<img');
		expect(body).toContain('<hr');
		expect(body).toContain('<br');
		expect(body).toContain('⟦U+202E⟧');
		expect(body).toContain('Invisible Unicode controls are shown as U+ markers.');
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

	it('renders a durable decline receipt without any document workspace or controls', () => {
		const data: PageData = {
			state: 'declined',
			envelopeId: '00000000-0000-8000-a000-000000000001',
			recipientId: '00000000-0000-8000-a000-000000000002',
			recipientStatus: 'declined',
			envelopeStatus: 'declined',
			declinedAt: '2026-09-11T00:02:00.000Z',
			locale: 'en'
		};
		const { body } = render(SignPage, { props: { data } });

		expect(body).toContain('Request declined');
		expect(body).toContain('Declined at');
		expect(body).toContain('Document access and signing authority for this request have ended.');
		expect(body).not.toContain('Agreement documents');
		expect(body).not.toContain('Decline request');
		expect(body).not.toContain('Approve agreement');
		expect(body).not.toContain('Sign and complete');
		expect(body).not.toContain('<form');
		expect(body).not.toContain('href="#document-');
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
				documents: [document('documents/NDA.md', 'Agreement content')],
				fields: [],
				fieldGeneration: 1
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
				documents: [document('documents/NDA.md', 'Agreement content')],
				fields: [],
				fieldGeneration: 1
			};
			const { body } = render(SignPage, { props: { data } });

			expect(body).not.toContain('Decline request');
			expect(body).not.toContain('aria-haspopup="dialog"');
		}
	});

	it('renders approval controls only for an approver with a durable viewed state', () => {
		for (const [role, recipientStatus, expected] of [
			['approver', 'viewed', true],
			['approver', 'pending', false],
			['signer', 'viewed', false],
			['viewer', 'viewed', false],
			['prefill', 'viewed', false]
		] as const) {
			const data: PageData = {
				state: 'active',
				access: {
					envelopeId: '00000000-0000-8000-a000-000000000001',
					recipientId: '00000000-0000-8000-a000-000000000002',
					role,
					locale: 'en',
					recipientStatus,
					envelopeTitle: 'Service Agreement',
					envelopeStatus: 'sent',
					expiresAt: '2026-09-12T00:00:00.000Z'
				},
				documents: [document('documents/NDA.md', 'Agreement content')],
				fields: [],
				fieldGeneration: 1
			};
			const { body } = render(SignPage, { props: { data } });

			if (expected) {
				expect(body).toContain('Approve agreement');
				expect(body).toContain('min-h-[44px]');
				expect(body).toContain('aria-haspopup="dialog"');
				expect(body).toContain('JavaScript is required to confirm and record an approval.');
			} else {
				expect(body).not.toContain('Approve agreement');
			}
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
			expect(messages.signing_declined_receipt_recorded_at).toContain('{timestamp}');
			expect(messages.signing_declined_receipt_access_closed).toBeTruthy();

			const combined = `${messages.signing_decline_dialog_title} ${messages.signing_decline_dialog_description} ${messages.signing_declined_receipt_access_closed}`;
			expect(combined).not.toMatch(/pades/i);
			expect(combined).not.toMatch(/\bpdf\b/i);
			expect(combined).not.toMatch(/sender|notified|notification/i);
		}

		expect(en.signing_decline_dialog_description).toContain('Declining ends this request');
		expect(ja.signing_decline_dialog_description).toContain('辞退するとこの依頼は終了します');
	});

	it('provides localized approval copy without claiming a signature or PDF artifact', async () => {
		const en = (await import('../../../messages/en.json')).default;
		const ja = (await import('../../../messages/ja.json')).default;

		for (const messages of [en, ja]) {
			const combined = `${messages.signing_approve_dialog_title} ${messages.signing_approve_dialog_description}`;
			expect(messages.signing_approve_dialog_confirm).toBeTruthy();
			expect(messages.signing_approve_no_js_explanation).toBeTruthy();
			expect(combined).not.toMatch(/\bpdf\b/i);
			expect(combined).not.toMatch(/signature/i);
		}
	});

	it('renders only this signer own fields after the documents have been viewed', () => {
		const data: PageData = {
			state: 'active',
			access: {
				envelopeId: '00000000-0000-8000-a000-000000000001',
				recipientId: '00000000-0000-8000-a000-000000000002',
				role: 'signer',
				locale: 'en',
				recipientStatus: 'viewed',
				envelopeTitle: 'Service Agreement',
				envelopeStatus: 'in_progress',
				expiresAt: '2026-09-12T00:00:00.000Z'
			},
			documents: [document('documents/NDA.md', 'Agreement content')],
			fields: [
				{
					id: '00000000-0000-8000-a000-000000000003',
					documentPath: 'documents/NDA.md',
					fieldType: 'signature',
					label: 'Your signature',
					required: true,
					position: 0
				}
			],
			fieldGeneration: 1
		};
		const { body } = render(SignPage, { props: { data } });
		expect(body).toContain('Your signature');
		expect(body).toContain('Sign and complete');
		expect(body).toContain('min-h-[44px]');
		expect(body).toContain('JavaScript is required to submit and record your signature.');
		expect(body).not.toContain('Approve agreement');
	});

	it('never renders signing fields for an approver', () => {
		const data: PageData = {
			state: 'active',
			access: {
				envelopeId: '00000000-0000-8000-a000-000000000001',
				recipientId: '00000000-0000-8000-a000-000000000002',
				role: 'approver',
				locale: 'en',
				recipientStatus: 'viewed',
				envelopeTitle: 'Service Agreement',
				envelopeStatus: 'in_progress',
				expiresAt: '2026-09-12T00:00:00.000Z'
			},
			documents: [document('documents/NDA.md', 'Agreement content')],
			fields: [
				{
					id: '00000000-0000-8000-a000-000000000003',
					documentPath: 'documents/NDA.md',
					fieldType: 'signature',
					label: 'Your signature',
					required: true,
					position: 0
				}
			],
			fieldGeneration: 1
		};
		const { body } = render(SignPage, { props: { data } });
		expect(body).toContain('Approve agreement');
		expect(body).not.toContain('Your signature');
		expect(body).not.toContain('Sign and complete');
	});

	it('provides localized signing copy without claiming a PDF or cryptographic seal', async () => {
		const en = (await import('../../../messages/en.json')).default;
		const ja = (await import('../../../messages/ja.json')).default;

		for (const messages of [en, ja]) {
			const combined = `${messages.signing_sign_dialog_title} ${messages.signing_sign_dialog_description} ${messages.signing_signed_receipt_description}`;
			expect(messages.signing_sign_dialog_confirm).toBeTruthy();
			expect(messages.signing_sign_no_js_explanation).toBeTruthy();
			expect(combined).not.toMatch(/\bpdf\b/i);
			expect(combined).not.toMatch(/pades/i);
		}
	});
});
