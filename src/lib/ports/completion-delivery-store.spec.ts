import { describe, expect, it } from 'vitest';
import {
	boundCompletionDeliveryClaimLimit,
	boundCompletionDeliveryDiscoveryLimit,
	sanitizeCompletionDeliveryErrorCode,
	FALLBACK_COMPLETION_DELIVERY_ERROR_CODE
} from './completion-delivery-store';

describe('completion-delivery-store port helpers', () => {
	it('sanitizes error codes and scrubs sensitive token patterns', () => {
		expect(sanitizeCompletionDeliveryErrorCode('delivery_timeout')).toBe('delivery_timeout');
		expect(sanitizeCompletionDeliveryErrorCode('rate_limit_exceeded')).toBe('rate_limit_exceeded');
		expect(sanitizeCompletionDeliveryErrorCode('skca1_secret_token_12345')).toBe(
			FALLBACK_COMPLETION_DELIVERY_ERROR_CODE
		);
		expect(sanitizeCompletionDeliveryErrorCode('skcd1_secret_ciphertext_12345')).toBe(
			FALLBACK_COMPLETION_DELIVERY_ERROR_CODE
		);
		expect(sanitizeCompletionDeliveryErrorCode('skr1_signing_token_12345')).toBe(
			FALLBACK_COMPLETION_DELIVERY_ERROR_CODE
		);
		expect(sanitizeCompletionDeliveryErrorCode('skdc1_delivery_capability_12345')).toBe(
			FALLBACK_COMPLETION_DELIVERY_ERROR_CODE
		);
		expect(sanitizeCompletionDeliveryErrorCode('INVALID-CODE')).toBe(
			FALLBACK_COMPLETION_DELIVERY_ERROR_CODE
		);
		expect(sanitizeCompletionDeliveryErrorCode('')).toBe(FALLBACK_COMPLETION_DELIVERY_ERROR_CODE);
	});

	it('bounds claim and discovery limits', () => {
		expect(boundCompletionDeliveryClaimLimit(0)).toBe(1);
		expect(boundCompletionDeliveryClaimLimit(-5)).toBe(1);
		expect(boundCompletionDeliveryClaimLimit(10)).toBe(10);
		expect(boundCompletionDeliveryClaimLimit(100)).toBe(25);

		expect(boundCompletionDeliveryDiscoveryLimit(0)).toBe(1);
		expect(boundCompletionDeliveryDiscoveryLimit(15)).toBe(15);
		expect(boundCompletionDeliveryDiscoveryLimit(50)).toBe(25);
	});
});
