import { describe, expect, it } from 'vitest';
import {
	assertPdfSealErrorCode,
	assertPdfSealAttemptCommand,
	assertValidPdfSealArtifact,
	assertValidPdfSealFrozenReference,
	assertValidPdfSealValidationEvidence,
	boundPdfSealClaimLimit,
	pdfSealRetryAvailableAt,
	PDF_SEAL_JOB_MAX_CONSECUTIVE_FAILURES,
	type PdfSealFrozenReference,
	type PdfSealValidationEvidence
} from './pdf-seal-job-store';
import type { PdfSealValidationChecks } from './pdf-seal-validator';

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

const baseChecks: PdfSealValidationChecks = {
	sourcePrefixExact: true,
	incrementalUpdateValid: true,
	byteRangeComplete: true,
	cmsSignatureValid: true,
	cmsSubFilter: 'ETSI.CAdES.detached',
	signerCertificateProtected: true,
	signerCertificateDigestMatches: true,
	certificatePathValid: true,
	sealPolicyValid: true,
	invisibleApprovalSignature: true,
	docMdpAbsent: true,
	noPostSealChanges: true,
	timestamp: null
};

function validationEvidence(checks: PdfSealValidationChecks): PdfSealValidationEvidence {
	return {
		validatorReceiptId: 'validator-receipt-1',
		checks,
		reportObjectKey: 'pdf-seals/reports/report.json',
		reportSha256: 'c'.repeat(64),
		reportByteSize: 2048,
		validatedAt: '2026-09-23T00:05:30.000Z'
	};
}

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
		expect(PDF_SEAL_JOB_MAX_CONSECUTIVE_FAILURES).toBe(8);
		expect(pdfSealRetryAvailableAt('2026-09-23T00:00:00.000Z', 8)).toBe('2026-09-23T01:00:00.000Z');
		expect(() => pdfSealRetryAvailableAt('2026-09-23T00:00:00.000Z', 9)).toThrow(
			/consecutiveFailures/
		);
	});

	it('allows a monotonic attempt sequence beyond the retry budget and rejects reversed times', () => {
		const attempt = {
			jobId: reference.jobId,
			claimToken: 'lease-9',
			attemptId: '019a0000-0000-7000-8000-000000000009',
			attemptNumber: 9,
			startedAt: '2026-09-23T00:01:00.000Z',
			finishedAt: '2026-09-23T00:01:01.000Z'
		};
		expect(() => assertPdfSealAttemptCommand(attempt)).not.toThrow();
		expect(() =>
			assertPdfSealAttemptCommand({ ...attempt, finishedAt: '2026-09-23T00:00:59.999Z' })
		).toThrow(/finishedAt must not precede startedAt/);
	});

	it('requires every base validation check to be true before publication', () => {
		for (const name of [
			'sourcePrefixExact',
			'incrementalUpdateValid',
			'byteRangeComplete',
			'cmsSignatureValid',
			'signerCertificateProtected',
			'signerCertificateDigestMatches',
			'certificatePathValid',
			'sealPolicyValid',
			'invisibleApprovalSignature',
			'docMdpAbsent',
			'noPostSealChanges'
		] as const) {
			const checks = { ...baseChecks, [name]: false } as PdfSealValidationChecks;
			expect(() =>
				assertValidPdfSealValidationEvidence(validationEvidence(checks), 'pades-b-b')
			).toThrow(`validationEvidence.checks.${name} must be true`);
		}
	});

	it('requires every B-T timestamp validation check to be true', () => {
		const timestamp = {
			responseStatusGranted: true,
			messageImprintValid: true,
			nonceValidWhenPresent: true,
			policyValid: true,
			tokenSignatureValid: true,
			certificatePathValid: true,
			ekuCriticalTimeStampingOnly: true,
			essCertificateBindingValid: true,
			genTimeValid: true
		};
		for (const name of Object.keys(timestamp) as readonly (keyof typeof timestamp)[]) {
			const checks = {
				...baseChecks,
				timestamp: { ...timestamp, [name]: false }
			} as unknown as PdfSealValidationChecks;
			expect(() =>
				assertValidPdfSealValidationEvidence(validationEvidence(checks), 'pades-b-t')
			).toThrow(`validationEvidence.checks.timestamp.${name} must be true`);
		}
	});
});
