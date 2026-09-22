import { describe, expect, it } from 'vitest';
import {
	assertPdfSealErrorCode,
	assertValidPdfSealArtifact,
	assertValidPdfSealFrozenReference,
	boundPdfSealClaimLimit,
	pdfSealRetryAvailableAt,
	PDF_SEAL_JOB_MAX_ATTEMPTS,
	type PdfSealFrozenReference
} from './pdf-seal-job-store';

const reference: PdfSealFrozenReference = {
	jobId: '019a0000-0000-7000-8000-000000000001',
	envelopeId: '019a0000-0000-7000-8000-000000000002',
	operationId: '019a0000-0000-7000-8000-000000000003',
	validationId: '019a0000-0000-7000-8000-000000000004',
	sourceObjectKey: 'completion/source.pdf',
	sourceSha256: 'a'.repeat(64),
	sourceByteSize: 1024,
	requestedProfile: 'pades-b-b',
	signerCertificateSha256: 'b'.repeat(64),
	sealPolicyId: 'seal-policy-v1',
	validationPolicyId: 'validation-policy-v1',
	tsaPolicyId: null,
	tsaTrustBundleSha256: null
};

describe('PDF seal job domain', () => {
	it('accepts a frozen B-B tuple and rejects non-UUIDv7 operation ids', () => {
		expect(() => assertValidPdfSealFrozenReference(reference)).not.toThrow();
		expect(() =>
			assertValidPdfSealFrozenReference({
				...reference,
				operationId: '550e8400-e29b-41d4-a716-446655440000'
			})
		).toThrow(/operationId must be a UUIDv7/);
	});

	it('requires the exact profile-specific TSA tuple', () => {
		expect(() =>
			assertValidPdfSealFrozenReference({
				...reference,
				requestedProfile: 'pades-b-t',
				tsaPolicyId: null,
				tsaTrustBundleSha256: null
			})
		).toThrow(/requires the complete TSA policy tuple/);
		expect(() =>
			assertValidPdfSealFrozenReference({
				...reference,
				requestedProfile: 'pades-b-t',
				tsaPolicyId: '1.2.3.4',
				tsaTrustBundleSha256: 'c'.repeat(64)
			})
		).not.toThrow();
	});

	it('rejects oversized sources, profile downgrade, and non-incremental output', () => {
		expect(() =>
			assertValidPdfSealFrozenReference({ ...reference, sourceByteSize: 32 * 1024 * 1024 + 1 })
		).toThrow(/sourceByteSize/);
		expect(() =>
			assertValidPdfSealArtifact(
				{
					objectKey: 'sealed.pdf',
					sha256: 'd'.repeat(64),
					byteSize: 1024,
					achievedProfile: 'pades-b-b'
				},
				1024,
				'pades-b-b'
			)
		).toThrow(/incremental update/);
		expect(() =>
			assertValidPdfSealArtifact(
				{
					objectKey: 'sealed.pdf',
					sha256: 'd'.repeat(64),
					byteSize: 2048,
					achievedProfile: 'pades-b-b'
				},
				1024,
				'pades-b-t'
			)
		).toThrow(/must equal requestedProfile/);
	});

	it('keeps errors operator-safe and backoff bounded', () => {
		expect(() => assertPdfSealErrorCode('network_error')).not.toThrow();
		expect(() => assertPdfSealErrorCode('https://provider.invalid/secret')).toThrow(
			/operator-safe/
		);
		expect(boundPdfSealClaimLimit(999)).toBe(10);
		expect(PDF_SEAL_JOB_MAX_ATTEMPTS).toBe(8);
		expect(pdfSealRetryAvailableAt('2026-09-23T00:00:00.000Z', 8)).toBe('2026-09-23T01:00:00.000Z');
	});
});
