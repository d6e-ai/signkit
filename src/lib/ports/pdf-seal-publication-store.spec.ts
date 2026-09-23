import { describe, expect, it } from 'vitest';
import {
	assertValidPublishPdfSealCommand,
	boundPdfSealPublicationDiscoveryLimit,
	MAX_PDF_SEAL_PUBLICATION_DISCOVERY_BATCH,
	type PublishPdfSealCommand
} from './pdf-seal-publication-store';
import type { PdfSealValidationChecks } from './pdf-seal-validator';

const checks: PdfSealValidationChecks = {
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

function command(overrides: Partial<PublishPdfSealCommand> = {}): PublishPdfSealCommand {
	return {
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
		tsaTrustBundleSha256: null,
		providerReceiptId: 'provider-receipt-1',
		sealedArtifact: {
			objectKey: 'pdf-seals/sealed.pdf',
			sha256: 'c'.repeat(64),
			byteSize: 2048,
			achievedProfile: 'pades-b-b'
		},
		validationEvidence: {
			validatorReceiptId: 'validator-receipt-1',
			checks,
			reportObjectKey: 'pdf-seals/reports/report.json',
			reportSha256: 'd'.repeat(64),
			reportByteSize: 2048,
			validatedAt: '2026-09-23T00:05:30.000Z'
		},
		publishedAt: '2026-09-23T00:06:00.000Z',
		anchorAuditEventId: '019a0000-0000-7000-8000-000000000011',
		expectedAuditSequence: 1,
		previousAuditHash: 'e'.repeat(64),
		auditEventId: '019a0000-0000-7000-8000-000000000021',
		auditEventHash: 'f'.repeat(64),
		auditPayloadJson: '{"sealedSha256":"' + 'c'.repeat(64) + '"}',
		...overrides
	};
}

describe('PDF seal publication domain', () => {
	it('accepts a well-formed publish command', () => {
		expect(() => assertValidPublishPdfSealCommand(command())).not.toThrow();
	});

	it('rejects a non-UUIDv7 audit anchor or audit event id', () => {
		expect(() =>
			assertValidPublishPdfSealCommand(command({ anchorAuditEventId: 'not-a-uuid' }))
		).toThrow(/anchorAuditEventId/);
		expect(() => assertValidPublishPdfSealCommand(command({ auditEventId: 'not-a-uuid' }))).toThrow(
			/auditEventId/
		);
	});

	it('rejects a non-positive expected audit sequence', () => {
		expect(() => assertValidPublishPdfSealCommand(command({ expectedAuditSequence: 0 }))).toThrow(
			/expectedAuditSequence/
		);
	});

	it('rejects a malformed previous or event audit hash', () => {
		expect(() =>
			assertValidPublishPdfSealCommand(command({ previousAuditHash: 'x'.repeat(64) }))
		).toThrow(/previousAuditHash/);
		expect(() => assertValidPublishPdfSealCommand(command({ auditEventHash: 'short' }))).toThrow(
			/auditEventHash/
		);
	});

	it('rejects non-canonical audit payload JSON', () => {
		expect(() =>
			assertValidPublishPdfSealCommand(command({ auditPayloadJson: '{"a": 1}' }))
		).toThrow(/canonical/);
		expect(() =>
			assertValidPublishPdfSealCommand(command({ auditPayloadJson: 'not-json' }))
		).toThrow(/valid JSON/);
	});

	it('rejects a non-canonical or out-of-order publishedAt', () => {
		expect(() =>
			assertValidPublishPdfSealCommand(command({ publishedAt: '2026-09-23T00:06:00Z' }))
		).toThrow(/publishedAt/);
		expect(() =>
			assertValidPublishPdfSealCommand(command({ publishedAt: '2026-09-23T00:00:00.000Z' }))
		).toThrow(/publishedAt/);
	});

	it('reuses the frozen-reference and evidence validators for the job/evidence tuple', () => {
		expect(() =>
			assertValidPublishPdfSealCommand(command({ signerCertificateSha256: 'not-a-digest' }))
		).toThrow();
		expect(() =>
			assertValidPublishPdfSealCommand(
				command({
					validationEvidence: {
						validatorReceiptId: 'validator-receipt-1',
						checks: { ...checks, sealPolicyValid: false } as unknown as PdfSealValidationChecks,
						reportObjectKey: 'pdf-seals/reports/report.json',
						reportSha256: 'd'.repeat(64),
						reportByteSize: 2048,
						validatedAt: '2026-09-23T00:05:30.000Z'
					}
				})
			)
		).toThrow();
	});

	it('bounds the discovery limit to a safe positive integer', () => {
		expect(boundPdfSealPublicationDiscoveryLimit(0)).toBe(1);
		expect(boundPdfSealPublicationDiscoveryLimit(-5)).toBe(1);
		expect(boundPdfSealPublicationDiscoveryLimit(Number.NaN)).toBe(1);
		expect(boundPdfSealPublicationDiscoveryLimit(1000)).toBe(
			MAX_PDF_SEAL_PUBLICATION_DISCOVERY_BATCH
		);
		expect(boundPdfSealPublicationDiscoveryLimit(5)).toBe(5);
	});
});
