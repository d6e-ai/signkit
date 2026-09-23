import { describe, expect, it } from 'vitest';
import {
	assertValidRequestPdfSealCommand,
	sanitizePublicPdfSealErrorCode,
	type RequestPdfSealCommand
} from './pdf-seal-request-store';

const command: RequestPdfSealCommand = {
	actor: { type: 'user', id: 'user-1' },
	idempotencyKey: 'request-1',
	requestHash: 'a'.repeat(64),
	envelopeId: '019a0000-0000-7000-8000-000000000001',
	jobId: '019a0000-0000-7000-8000-000000000002',
	operationId: '019a0000-0000-7000-8000-000000000003',
	validationId: '019a0000-0000-7000-8000-000000000004',
	requestedProfile: 'pades-b-b',
	signerCertificateSha256: 'b'.repeat(64),
	sealPolicyId: 'seal-policy-v1',
	validationPolicyId: 'validation-policy-v1',
	tsaPolicyId: null,
	tsaTrustBundleSha256: null,
	requestedAt: '2026-09-23T00:04:00.000Z'
};

describe('PDF seal request store contract', () => {
	it('accepts bounded B-B and complete B-T request commands', () => {
		expect((): void => assertValidRequestPdfSealCommand(command)).not.toThrow();
		expect((): void =>
			assertValidRequestPdfSealCommand({
				...command,
				requestedProfile: 'pades-b-t',
				tsaPolicyId: 'tsa-policy-v1',
				tsaTrustBundleSha256: 'c'.repeat(64)
			})
		).not.toThrow();
	});

	it('rejects malformed actor, idempotency, identifiers, digests, policy tuples, and time', () => {
		for (const invalid of [
			{ ...command, actor: { type: 'system' as 'user', id: 'system' } },
			{ ...command, idempotencyKey: 'has space' },
			{ ...command, requestHash: 'A'.repeat(64) },
			{ ...command, jobId: 'not-a-uuid' },
			{ ...command, signerCertificateSha256: 'short' },
			{ ...command, tsaPolicyId: 'unexpected' },
			{ ...command, requestedAt: '2026-09-23T00:04:00Z' }
		] satisfies RequestPdfSealCommand[]) {
			expect((): void => assertValidRequestPdfSealCommand(invalid)).toThrow();
		}
	});

	it('allows only operator-safe failure codes into public status', () => {
		expect(sanitizePublicPdfSealErrorCode('provider_timeout')).toBe('provider_timeout');
		expect(sanitizePublicPdfSealErrorCode('provider.timeout')).toBe('pdf_seal_failed');
		expect(sanitizePublicPdfSealErrorCode(null)).toBe('pdf_seal_failed');
	});
});
