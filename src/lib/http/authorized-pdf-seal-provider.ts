import {
	issuePdfSealAuthorization,
	type PdfSealAuthorizationIssuerOptions
} from '$lib/application/pdf-seals/pdf-seal-authorization-issuer';
import {
	acceptAuthorizedPdfSeal,
	type ProviderSigningGateOptions
} from '$lib/application/pdf-seals/provider-signing-gate';
import {
	validPdfSealAuthorizationRequest,
	type PdfSealAuthorizationRequest
} from '$lib/application/pdf-seals/pdf-seal-authorization';
import type { PdfSealProviderOperation } from '$lib/ports/pdf-seal-provider';
import { readBoundedBytes } from './docx-import';

interface ProviderIngress {
	/** Return the audience from the authenticated scheduling credential, never a caller field. */
	authenticate(request: Request): Promise<string | null>;
}

type AuthorizedSubmit = ProviderIngress &
	ProviderSigningGateOptions<PdfSealProviderOperation> & {
		/** Resolve an accepted operation without invoking, restarting or enqueuing key use. */
		readAcceptedOperation(
			request: PdfSealAuthorizationRequest
		): Promise<PdfSealProviderOperation | null>;
	};

/** Mount in the independently administered authority at POST /pdf-seal-authorizations/{operationId}. */
export function createPdfSealAuthorizationHandler(
	options: ProviderIngress & PdfSealAuthorizationIssuerOptions
): (request: Request, operationId: string) => Promise<Response> {
	return async (request, operationId) => {
		if (request.method !== 'POST') return response(405);
		try {
			if ((await options.authenticate(request)) !== options.identity.audience) return response(401);
			if (
				request.headers.get('idempotency-key') !== operationId ||
				mediaType(request) !== 'application/json'
			) {
				return response(400);
			}
			const body = await readBoundedBytes(request, 4_096);
			if (!body.ok) return response(body.reason === 'too_large' ? 413 : 400);
			let input: PdfSealAuthorizationRequest;
			try {
				input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.bytes));
			} catch {
				return response(400);
			}
			if (!input || input.operationId !== operationId || !validPdfSealAuthorizationRequest(input)) {
				return response(400);
			}
			const authorization = await issuePdfSealAuthorization(input, options);
			return authorization === null ? response(403) : response(200, { authorization });
		} catch {
			return response(503);
		}
	};
}

/** Mount inside the key service at PUT /authorized-pdf-seals/{operationId}. */
export function createAuthorizedPdfSealSubmitHandler(
	options: AuthorizedSubmit
): (request: Request, operationId: string) => Promise<Response> {
	return async (request, operationId) => {
		if (request.method !== 'PUT') return response(405);
		try {
			if ((await options.authenticate(request)) !== options.trust.audience) return response(401);
			const headers = request.headers;
			const encoding = headers.get('content-encoding');
			if (
				headers.get('idempotency-key') !== operationId ||
				headers.get('x-signkit-operation-id') !== operationId ||
				mediaType(request) !== 'application/pdf' ||
				(encoding !== null && encoding.toLowerCase() !== 'identity') ||
				request.body === null
			)
				return response(400);
			const token = headers.get('x-signkit-seal-authorization');
			if (token === null) return response(403);
			const reference: PdfSealAuthorizationRequest = {
				envelopeId: headers.get('x-signkit-envelope-id') ?? '',
				operationId,
				sourceSha256: headers.get('x-signkit-source-sha256') ?? '',
				sourceByteSize: Number(headers.get('x-signkit-source-byte-size')),
				requestedProfile: headers.get(
					'x-signkit-requested-profile'
				) as PdfSealAuthorizationRequest['requestedProfile'],
				signerCertificateSha256: headers.get('x-signkit-signer-certificate-sha256') ?? '',
				sealPolicyId: headers.get('x-signkit-seal-policy-id') ?? '',
				validationPolicyId: headers.get('x-signkit-validation-policy-id') ?? '',
				tsaPolicyId: headers.get('x-signkit-tsa-policy-id'),
				tsaTrustBundleSha256: headers.get('x-signkit-tsa-trust-bundle-sha256')
			};
			const accepted = await acceptAuthorizedPdfSeal(reference, token, request.body, options);
			switch (accepted.outcome) {
				case 'signed':
					return response(200, accepted.result);
				case 'denied':
					return response(403);
				case 'conflict':
					return response(409);
				case 'replayed': {
					const existing = await options.readAcceptedOperation(reference);
					return existing === null ? response(503) : response(200, existing);
				}
			}
		} catch {
			// An ambiguous committed reservation never grants a second key call.
			return response(503);
		}
	};
}

function mediaType(request: Request): string | undefined {
	return request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
}

function response(status: number, body?: object): Response {
	const headers = { 'cache-control': 'no-store' };
	return body === undefined
		? new Response(null, { status, headers })
		: Response.json(body, { status, headers });
}
