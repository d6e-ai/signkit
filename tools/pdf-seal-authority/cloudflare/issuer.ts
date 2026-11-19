import { D1CompletionArtifactPdfStore } from '$lib/adapters/db/d1-completion-artifact-pdf-store';
import { D1CompletionArtifactStore } from '$lib/adapters/db/d1-completion-artifact-store';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import { createTrustedPdfSealCompletionReader } from '$lib/application/pdf-seals/trusted-pdf-seal-completion';
import { createPdfSealAuthorizationHandler } from '$lib/http/authorized-pdf-seal-provider';
import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import { authenticated, unavailable } from './security';

export interface IssuerEnvironment {
	EVIDENCE_DB: D1Database;
	EVIDENCE_OBJECTS: R2Bucket;
	SEAL_ISSUER: string;
	SEAL_AUDIENCE: string;
	SEAL_CERTIFICATE_SHA256: string;
	SEAL_POLICY_ID: string;
	VALIDATION_POLICY_ID: string;
	ISSUER_TOKEN: string;
	ISSUER_PRIVATE_KEY_PKCS8: string;
}

function importIssuerKey(encoded: string): Promise<CryptoKey> {
	const key = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
	return crypto.subtle.importKey('pkcs8', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
		'sign'
	]);
}

export default {
	async fetch(request: Request, env: IssuerEnvironment): Promise<Response> {
		const path = new URL(request.url).pathname;
		const operationId = /^\/pdf-seal-authorizations\/([^/]+)$/.exec(path)?.[1];
		if (operationId === undefined || !UUID_V7_PATTERN.test(operationId)) return unavailable(404);
		if (!authenticated(request, env.ISSUER_TOKEN)) return unavailable(401);
		try {
			const readTrustedCompletion = createTrustedPdfSealCompletionReader(
				new D1CompletionArtifactStore(env.EVIDENCE_DB),
				new D1CompletionArtifactPdfStore(env.EVIDENCE_DB),
				new R2ObjectStore(env.EVIDENCE_OBJECTS),
				async (envelopeId, audience) =>
					audience === env.SEAL_AUDIENCE && UUID_V7_PATTERN.test(envelopeId)
			);
			return await createPdfSealAuthorizationHandler({
				identity: { issuer: env.SEAL_ISSUER, audience: env.SEAL_AUDIENCE },
				// The evidence bindings are isolated per audience by deployment. An
				// instance credential cannot change which recipient plane is trusted.
				readTrustedCompletion,
				authenticate: async () => env.SEAL_AUDIENCE,
				policy: {
					requestedProfile: 'pades-b-b',
					signerCertificateSha256: env.SEAL_CERTIFICATE_SHA256,
					sealPolicyId: env.SEAL_POLICY_ID,
					validationPolicyId: env.VALIDATION_POLICY_ID,
					tsaPolicyId: null,
					tsaTrustBundleSha256: null
				},
				sign: async (message) =>
					new Uint8Array(
						await crypto.subtle.sign(
							{ name: 'ECDSA', hash: 'SHA-256' },
							await importIssuerKey(env.ISSUER_PRIVATE_KEY_PKCS8),
							message
						)
					)
			})(request, operationId);
		} catch {
			return unavailable(503);
		}
	}
} satisfies ExportedHandler<IssuerEnvironment>;
