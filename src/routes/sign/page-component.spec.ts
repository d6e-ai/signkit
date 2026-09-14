import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { RecipientPlacedField } from '$lib/application/signing/recipient-workspace';
import SignPage from './[envelopeId]/+page.svelte';
import type { PageData } from './[envelopeId]/$types';

const ENVELOPE_ID = '01910000-0000-7000-8000-000000000001';
const RECIPIENT_ID = '01910000-0000-7000-8000-000000000002';
const FIELD_ID = '01910000-0000-7000-8000-000000000003';

const sentDocument = {
	pageCount: 2,
	pageWidth: 595.28,
	pageHeight: 841.89,
	sections: [
		{ title: 'NDA v1', firstPage: 1, lastPage: 1 },
		{ title: 'schedule a', firstPage: 2, lastPage: 2 }
	]
};

const signatureField: RecipientPlacedField = {
	id: FIELD_ID,
	fieldType: 'signature',
	label: 'Your signature',
	required: true,
	geometry: { page: 2, x: 0.12, y: 0.34, width: 0.3, height: 0.06 }
};

function activeData(
	overrides: {
		role?: 'signer' | 'approver' | 'viewer' | 'prefill';
		recipientStatus?: 'pending' | 'viewed';
		locale?: 'en' | 'ja';
		fields?: readonly RecipientPlacedField[];
	} = {}
): PageData {
	return {
		state: 'active',
		access: {
			envelopeId: ENVELOPE_ID,
			recipientId: RECIPIENT_ID,
			recipientName: 'Alex Rivera',
			role: overrides.role ?? 'signer',
			locale: overrides.locale ?? 'en',
			recipientStatus: overrides.recipientStatus ?? 'pending',
			envelopeTitle: 'Service Agreement',
			envelopeStatus: 'sent',
			expiresAt: '2026-09-12T00:00:00.000Z'
		},
		document: sentDocument,
		fields: overrides.fields ?? [],
		fieldGeneration: 1
	} as PageData;
}

describe('recipient signing page', () => {
	it('embeds the session-protected agreement PDF and never Markdown source', () => {
		const { body } = render(SignPage, { props: { data: activeData() } });

		expect(body).toContain('Service Agreement');
		expect(body).toContain('NDA v1');
		expect(body).toContain('schedule a');
		// The PDF address is same-origin and token-free: authority is the
		// http-only session cookie, never anything reachable from page data.
		expect(body).toContain(`/sign/${ENVELOPE_ID}/agreement.pdf`);
		expect(body).not.toMatch(/skr1_|token=|capability/i);
		expect(body).not.toContain('{@html');
		// Removed with the Markdown surface itself.
		expect(body).not.toContain('Markdown');
		expect(body).not.toContain('External images are omitted');
		expect(body).not.toContain('Exact Markdown source');
	});

	it('uses the shared container rather than an arbitrary max width', () => {
		const { body } = render(SignPage, { props: { data: activeData() } });
		expect(body).not.toContain('max-w-5xl');
	});

	it('reports an outstanding action rather than the internal viewed evidence', () => {
		for (const recipientStatus of ['pending', 'viewed'] as const) {
			const { body } = render(SignPage, {
				props: { data: activeData({ recipientStatus }) }
			});
			expect(body).toContain('Action required');
			expect(body).not.toContain('>Viewed<');
		}
	});

	it('drops the obsolete "next implementation step" copy in both locales', async () => {
		const en = (await import('../../../messages/en.json')).default as Record<string, string>;
		const ja = (await import('../../../messages/ja.json')).default as Record<string, string>;
		expect(en.signing_controls_next).toBeUndefined();
		expect(ja.signing_controls_next).toBeUndefined();
		expect(en.signing_status_viewed).toBeUndefined();
		expect(ja.signing_status_viewed).toBeUndefined();

		const { body } = render(SignPage, { props: { data: activeData() } });
		expect(body).not.toContain('next implementation step');
	});

	it.each([
		['invalid', 'This signing link is not active'],
		['unavailable', 'Signing access is temporarily unavailable']
	] as const)('renders the %s state without document content', (state, expected) => {
		const data: PageData = { state } as PageData;
		const { body } = render(SignPage, { props: { data } });
		expect(body).toContain(expected);
		expect(body).not.toContain('Agreement documents');
		expect(body).not.toContain('Decline request');
		expect(body).not.toContain(`/sign/${ENVELOPE_ID}/agreement.pdf`);
	});

	it('renders a durable decline receipt without any document workspace or controls', () => {
		const data: PageData = {
			state: 'declined',
			envelopeId: ENVELOPE_ID,
			recipientId: RECIPIENT_ID,
			recipientStatus: 'declined',
			envelopeStatus: 'declined',
			declinedAt: '2026-09-11T00:02:00.000Z',
			locale: 'en'
		} as PageData;
		const { body } = render(SignPage, { props: { data } });

		expect(body).toContain('Request declined');
		expect(body).toContain('Declined at');
		expect(body).toContain('Document access and signing authority for this request have ended.');
		expect(body).not.toContain('Agreement documents');
		expect(body).not.toContain('Decline request');
		expect(body).not.toContain('Approve agreement');
		expect(body).not.toContain('Sign and complete');
		expect(body).not.toContain(`/sign/${ENVELOPE_ID}/agreement.pdf`);
	});

	it('puts the decline action in the summary card footer for actionable roles', () => {
		for (const role of ['signer', 'approver'] as const) {
			const { body } = render(SignPage, { props: { data: activeData({ role }) } });

			expect(body).toContain('Decline request');
			expect(body).toContain('min-h-[44px]');
			expect(body).toContain('aria-haspopup="dialog"');
			expect(body).toContain('role="status"');
			expect(body).toContain('aria-live="polite"');
			// Exactly one decline affordance in the server-rendered markup: the
			// separate card at the bottom of the page is gone, so the action
			// cannot be offered twice.
			expect(body.split('Decline request').length - 1).toBe(1);
		}
	});

	it('never renders decline controls for viewer or prefill roles', () => {
		for (const role of ['viewer', 'prefill'] as const) {
			const { body } = render(SignPage, { props: { data: activeData({ role }) } });
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
			const { body } = render(SignPage, {
				props: { data: activeData({ role, recipientStatus }) }
			});

			if (expected) {
				expect(body).toContain('Approve agreement');
				expect(body).toContain('min-h-[44px]');
				expect(body).toContain('JavaScript is required to confirm and record an approval.');
			} else {
				expect(body).not.toContain('Approve agreement');
			}
		}
	});

	it('lists this signer own fields by page and never another recipient fields', () => {
		const { body } = render(SignPage, {
			props: {
				data: activeData({ recipientStatus: 'viewed', fields: [signatureField] })
			}
		});
		expect(body).toContain('Your signature');
		expect(body).toContain('Sign and complete');
		expect(body).toContain('min-h-[44px]');
		expect(body).toContain('JavaScript is required to submit and record your signature.');
		// The list is navigation into the document, not a duplicate form: the
		// only editable control for a field lives on the page overlay.
		expect(body).toContain('#agreement-page-2');
		expect(body).not.toContain('Approve agreement');
	});

	it('never renders signing fields for an approver', () => {
		const { body } = render(SignPage, {
			props: {
				data: activeData({
					role: 'approver',
					recipientStatus: 'viewed',
					fields: [signatureField]
				})
			}
		});
		expect(body).toContain('Approve agreement');
		expect(body).not.toContain('Your signature');
		expect(body).not.toContain('Sign and complete');
	});

	it('provides localized signing copy without claiming a cryptographic seal', async () => {
		const en = (await import('../../../messages/en.json')).default;
		const ja = (await import('../../../messages/ja.json')).default;

		for (const messages of [en, ja]) {
			const combined = `${messages.signing_sign_dialog_title} ${messages.signing_sign_dialog_description} ${messages.signing_signed_receipt_description}`;
			expect(messages.signing_sign_dialog_confirm).toBeTruthy();
			expect(messages.signing_sign_no_js_explanation).toBeTruthy();
			expect(combined).not.toMatch(/pades/i);
		}
	});

	it('provides localized document and status copy in both locales', async () => {
		const en = (await import('../../../messages/en.json')).default;
		const ja = (await import('../../../messages/ja.json')).default;

		expect(en.signing_status_pending).toBe('Action required');
		expect(ja.signing_status_pending).toBe('対応が必要');
		for (const messages of [en, ja]) {
			expect(messages.signing_document_label).toBeTruthy();
			expect(messages.signing_document_loading).toBeTruthy();
			expect(messages.signing_document_error_title).toBeTruthy();
			expect(messages.signing_document_error_description).toBeTruthy();
			expect(messages.signing_document_open).toBeTruthy();
			expect(messages.signing_fields_overlay_hint).toBeTruthy();
			expect(messages.signing_document_page).toContain('{page}');
		}
	});

	it('provides localized decline dialog messages that identify request termination', async () => {
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

	it('provides localized signature dialog copy that requires explicit confirmation', async () => {
		const en = (await import('../../../messages/en.json')).default;
		const ja = (await import('../../../messages/ja.json')).default;

		expect(en.signature_dialog_title).toBeTruthy();
		expect(en.signature_dialog_description).toMatch(/until you confirm/i);
		expect(en.signature_trigger_empty).toBe('Add signature');
		expect(ja.signature_dialog_title).toBeTruthy();
		expect(ja.signature_dialog_description).toContain('確定するまで');
		expect(ja.signature_trigger_empty).toBe('署名を追加');
		for (const messages of [en, ja]) {
			expect(messages.signature_dialog_confirm).toBeTruthy();
			expect(messages.signature_dialog_cancel).toBeTruthy();
			expect(messages.signature_dialog_close).toBeTruthy();
			expect(messages.signature_canvas_tab_type).toBeTruthy();
			expect(messages.signature_canvas_tab_draw).toBeTruthy();
			expect(messages.signature_canvas_drawn).toBeTruthy();
		}
		expect(en.signature_dialog_close).toBe('Close');
		expect(ja.signature_dialog_close).toBe('閉じる');
	});
});
