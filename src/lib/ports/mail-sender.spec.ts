import { describe, expect, it } from 'vitest';
import {
	FALLBACK_MAIL_ERROR_CODE,
	MailDeliveryError,
	mailProviderReceiptId,
	sanitizeMailErrorCode
} from './mail-sender';

describe('MailDeliveryError', () => {
	it('exposes a retryable flag and a stable code without raw provider text', () => {
		const retryable: MailDeliveryError = new MailDeliveryError('provider_timeout', true);
		expect(retryable.retryable).toBe(true);
		expect(retryable.code).toBe('provider_timeout');
		expect(retryable.message).toBe('provider_timeout');
		expect(retryable.name).toBe('MailDeliveryError');

		const permanent: MailDeliveryError = new MailDeliveryError(
			'SMTP 550 user@example.com token=skr1_secret',
			false
		);
		expect(permanent.retryable).toBe(false);
		expect(permanent.code).toBe(FALLBACK_MAIL_ERROR_CODE);
		expect(permanent.message).toBe(FALLBACK_MAIL_ERROR_CODE);
		expect(permanent.message).not.toContain('@');
		expect(permanent.message).not.toContain('skr1_');
		expect(JSON.stringify(permanent)).not.toContain('user@example.com');
	});
});

describe('sanitizeMailErrorCode', () => {
	it('accepts only stable machine codes', () => {
		expect(sanitizeMailErrorCode('mailbox_unavailable')).toBe('mailbox_unavailable');
		expect(sanitizeMailErrorCode('skdc1_sealed')).toBe(FALLBACK_MAIL_ERROR_CODE);
		expect(sanitizeMailErrorCode('ski1_invitation')).toBe(FALLBACK_MAIL_ERROR_CODE);
		expect(sanitizeMailErrorCode('skiod1_ciphertext')).toBe(FALLBACK_MAIL_ERROR_CODE);
	});
});

describe('mailProviderReceiptId', () => {
	it('returns bounded provider or queued receipt identifiers', () => {
		expect(mailProviderReceiptId({ outcome: 'accepted', providerMessageId: 'msg-1' })).toBe(
			'msg-1'
		);
		expect(mailProviderReceiptId({ outcome: 'queued', receiptId: 'queue:abc_1' })).toBe(
			'queue:abc_1'
		);
		expect(
			mailProviderReceiptId({
				outcome: 'accepted',
				providerMessageId: '<01900000-0000-7000-8000-000000000001@email.cloudflare.net>'
			})
		).toBe('<01900000-0000-7000-8000-000000000001@email.cloudflare.net>');
		expect(mailProviderReceiptId({ outcome: 'queued', receiptId: 'user@example.com' })).toBeNull();
		expect(mailProviderReceiptId({ outcome: 'accepted', providerMessageId: '' })).toBeNull();
		expect(
			mailProviderReceiptId({ outcome: 'queued', receiptId: 'queue-id\r\nforged-header' })
		).toBeNull();
		expect(
			mailProviderReceiptId({ outcome: 'accepted', providerMessageId: 'x'.repeat(1025) })
		).toBeNull();
	});
});
