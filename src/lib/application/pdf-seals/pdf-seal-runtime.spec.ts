import { describe, expect, it } from 'vitest';
import {
	parsePdfSealRuntimeConfiguration,
	PdfSealRuntimeConfigurationError,
	resolvePdfSealRuntime,
	type PdfSealRuntimeEnvironment
} from './pdf-seal-runtime';

function environment(overrides: PdfSealRuntimeEnvironment = {}): PdfSealRuntimeEnvironment {
	return {
		PDF_SEAL_PROFILE: 'pades-b-b',
		PDF_SEAL_PROVIDER_URL: 'https://seal.example.com/v1',
		PDF_SEAL_PROVIDER_TOKEN: 'provider-token',
		PDF_SEAL_VALIDATOR_URL: 'https://validator.example.com/v1',
		PDF_SEAL_VALIDATOR_TOKEN: 'validator-token',
		PDF_SEAL_SIGNER_CERTIFICATE_SHA256: 'a'.repeat(64),
		PDF_SEAL_POLICY_ID: 'seal-policy-v1',
		PDF_SEAL_VALIDATION_POLICY_ID: 'validation-policy-v1',
		...overrides
	};
}

describe('PDF seal runtime configuration', () => {
	it('treats a completely absent configuration as disabled', () => {
		expect(parsePdfSealRuntimeConfiguration({})).toBeNull();
	});

	it('rejects a configured Cloudflare runtime without its durable bindings', async () => {
		await expect(
			resolvePdfSealRuntime({
				platform: { env: environment() } as unknown as App.Platform
			})
		).rejects.toBeInstanceOf(PdfSealRuntimeConfigurationError);
	});

	it('accepts complete B-B and B-T policies without changing secret bytes', () => {
		const bb = parsePdfSealRuntimeConfiguration(environment());
		expect(bb?.requestPolicy).toMatchObject({ requestedProfile: 'pades-b-b', tsaPolicyId: null });
		expect(bb?.providerToken).toBe('provider-token');
		const bt = parsePdfSealRuntimeConfiguration(
			environment({
				PDF_SEAL_PROFILE: 'pades-b-t',
				PDF_SEAL_TSA_POLICY_ID: '1.2.3.4',
				PDF_SEAL_TSA_TRUST_BUNDLE_SHA256: 'b'.repeat(64)
			})
		);
		expect(bt?.requestPolicy).toMatchObject({
			requestedProfile: 'pades-b-t',
			tsaPolicyId: '1.2.3.4',
			tsaTrustBundleSha256: 'b'.repeat(64)
		});
	});

	it.each([
		{ PDF_SEAL_PROVIDER_TOKEN: undefined },
		{ PDF_SEAL_PROVIDER_TOKEN: 'token with spaces' },
		{ PDF_SEAL_PROVIDER_URL: 'http://seal.example.com' },
		{ PDF_SEAL_PROVIDER_URL: 'https://user:pass@seal.example.com' },
		{ PDF_SEAL_SIGNER_CERTIFICATE_SHA256: 'A'.repeat(64) },
		{ PDF_SEAL_POLICY_ID: 'contains a space' },
		{ PDF_SEAL_PROFILE: 'pades-b-t' },
		{ PDF_SEAL_TSA_POLICY_ID: '1.2.3', PDF_SEAL_TSA_TRUST_BUNDLE_SHA256: 'b'.repeat(64) }
	] as PdfSealRuntimeEnvironment[])('rejects partial or invalid configuration: %o', (values) => {
		expect(() => parsePdfSealRuntimeConfiguration(environment(values))).toThrow(
			PdfSealRuntimeConfigurationError
		);
	});

	it('never includes a supplied token in the configuration error', () => {
		const token: string = 'top-secret-token';
		try {
			parsePdfSealRuntimeConfiguration(
				environment({ PDF_SEAL_PROVIDER_TOKEN: token, PDF_SEAL_PROFILE: 'invalid' })
			);
			throw new Error('Expected invalid configuration');
		} catch (error: unknown) {
			expect(error).toBeInstanceOf(PdfSealRuntimeConfigurationError);
			expect(String(error)).not.toContain(token);
		}
	});
});
