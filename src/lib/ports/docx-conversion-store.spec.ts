import { describe, expect, it } from 'vitest';
import {
	boundDocxConversionClaimLimit,
	MAX_DOCX_CONVERSION_CLAIM_BATCH,
	sanitizeDocxConversionErrorCode,
	FALLBACK_DOCX_CONVERSION_ERROR_CODE
} from './docx-conversion-store';

describe('boundDocxConversionClaimLimit', () => {
	it('clamps negative or zero limits to 1', () => {
		expect(boundDocxConversionClaimLimit(0)).toBe(1);
		expect(boundDocxConversionClaimLimit(-5)).toBe(1);
		expect(boundDocxConversionClaimLimit(NaN)).toBe(1);
		expect(boundDocxConversionClaimLimit(1.5)).toBe(1);
	});

	it('preserves valid limits within the batch maximum', () => {
		expect(boundDocxConversionClaimLimit(1)).toBe(1);
		expect(boundDocxConversionClaimLimit(5)).toBe(5);
		expect(boundDocxConversionClaimLimit(MAX_DOCX_CONVERSION_CLAIM_BATCH)).toBe(
			MAX_DOCX_CONVERSION_CLAIM_BATCH
		);
	});

	it('caps limits exceeding the maximum batch', () => {
		expect(boundDocxConversionClaimLimit(100)).toBe(MAX_DOCX_CONVERSION_CLAIM_BATCH);
	});
});

describe('sanitizeDocxConversionErrorCode', () => {
	it('preserves standard lowercase snake_case error codes', () => {
		expect(sanitizeDocxConversionErrorCode('integrity_failure')).toBe('integrity_failure');
		expect(sanitizeDocxConversionErrorCode('docx_import_corrupt')).toBe('docx_import_corrupt');
		expect(sanitizeDocxConversionErrorCode('attempts_exhausted')).toBe('attempts_exhausted');
		expect(sanitizeDocxConversionErrorCode('concurrency_conflict')).toBe('concurrency_conflict');
	});

	it('replaces malformed or sensitive error codes with fallback', () => {
		expect(sanitizeDocxConversionErrorCode('')).toBe(FALLBACK_DOCX_CONVERSION_ERROR_CODE);
		expect(sanitizeDocxConversionErrorCode('123_invalid')).toBe(
			FALLBACK_DOCX_CONVERSION_ERROR_CODE
		);
		expect(sanitizeDocxConversionErrorCode('INVALID-CODE')).toBe(
			FALLBACK_DOCX_CONVERSION_ERROR_CODE
		);
		expect(sanitizeDocxConversionErrorCode('a'.repeat(66))).toBe(
			FALLBACK_DOCX_CONVERSION_ERROR_CODE
		);
	});
});
