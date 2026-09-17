import { describe, expect, it } from 'vitest';
import {
	boundInvitationClaimLimit,
	FALLBACK_DELIVERY_ERROR_CODE,
	MAX_INVITATION_CLAIM_BATCH,
	sanitizeDeliveryErrorCode
} from './delivery-outbox-store';

describe('sanitizeDeliveryErrorCode', () => {
	it('keeps stable machine codes', () => {
		expect(sanitizeDeliveryErrorCode('ciphertext_digest_mismatch')).toBe(
			'ciphertext_digest_mismatch'
		);
		expect(sanitizeDeliveryErrorCode('mail_provider_timeout')).toBe('mail_provider_timeout');
	});

	it('replaces secret-shaped or PII-shaped text with a fallback code', () => {
		expect(sanitizeDeliveryErrorCode('user@example.com')).toBe(FALLBACK_DELIVERY_ERROR_CODE);
		expect(sanitizeDeliveryErrorCode('skr1_abcdefghijklmnopqrstuvwxyz0123456789ABCDE')).toBe(
			FALLBACK_DELIVERY_ERROR_CODE
		);
		expect(sanitizeDeliveryErrorCode('skdc1_ciphertext')).toBe(FALLBACK_DELIVERY_ERROR_CODE);
		expect(sanitizeDeliveryErrorCode('ski1_invitation')).toBe(FALLBACK_DELIVERY_ERROR_CODE);
		expect(sanitizeDeliveryErrorCode('skiod1_ciphertext')).toBe(FALLBACK_DELIVERY_ERROR_CODE);
		expect(sanitizeDeliveryErrorCode('https://signkit.example/s/token')).toBe(
			FALLBACK_DELIVERY_ERROR_CODE
		);
		expect(sanitizeDeliveryErrorCode('SMTP 550 for user@example.com')).toBe(
			FALLBACK_DELIVERY_ERROR_CODE
		);
	});
});

describe('boundInvitationClaimLimit', () => {
	it('caps the claim batch and rejects non-positive sizes', () => {
		expect(boundInvitationClaimLimit(1)).toBe(1);
		expect(boundInvitationClaimLimit(MAX_INVITATION_CLAIM_BATCH + 10)).toBe(
			MAX_INVITATION_CLAIM_BATCH
		);
		expect(boundInvitationClaimLimit(0)).toBe(1);
		expect(boundInvitationClaimLimit(-3)).toBe(1);
		expect(boundInvitationClaimLimit(1.5)).toBe(1);
	});
});
