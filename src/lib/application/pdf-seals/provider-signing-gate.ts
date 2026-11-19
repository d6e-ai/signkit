import { readExactObjectStream } from '$lib/application/completion-artifacts/exact-object-stream';
import { sha256Hex } from '$lib/application/completion-artifacts/completion-manifest';
import { sha256TextHex } from '$lib/domain/audit';
import {
	matchesPdfSealAuthorizationPolicy,
	pdfSealAuthorizationReference,
	verifyPdfSealAuthorization,
	type PdfSealAuthorizationClaims,
	type PdfSealAuthorizationPolicy,
	type PdfSealAuthorizationRequest,
	type PdfSealAuthorizationTrust
} from './pdf-seal-authorization';

export interface ProviderSigningReservation {
	issuer: string;
	audience: string;
	envelopeId: string;
	operationId: string;
	authorizationSha256: string;
	expiresAt: string;
}

export interface ProviderSigningLedger {
	/** Atomic, permanent reservation in a store owned by the service controlling the key. */
	reserve(command: ProviderSigningReservation): Promise<'reserved' | 'existing' | 'conflict'>;
}

export interface ProviderSigningGateOptions<Result> {
	trust: PdfSealAuthorizationTrust;
	policy: PdfSealAuthorizationPolicy;
	ledger: ProviderSigningLedger;
	/** Provider-owned non-exportable key operation, with a provider-owned key selection. */
	sign(claims: PdfSealAuthorizationClaims, source: Uint8Array<ArrayBuffer>): Promise<Result>;
	now?: () => Date;
}

export type ProviderSigningAdmission<Result> =
	{ outcome: 'denied' | 'replayed' | 'conflict' } | { outcome: 'signed'; result: Result };

/**
 * The ingress to key use. Status/recovery can read an accepted operation; only
 * the caller receiving a new durable reservation may run the private operation.
 */
export async function acceptAuthorizedPdfSeal<Result>(
	input: PdfSealAuthorizationRequest,
	token: string,
	source: ReadableStream<Uint8Array>,
	options: ProviderSigningGateOptions<Result>
): Promise<ProviderSigningAdmission<Result>> {
	const request = pdfSealAuthorizationReference(input);
	const now = options.now ?? (() => new Date());
	const claims = await verifyPdfSealAuthorization(token, request, options.trust, now());
	if (claims === null || !matchesPdfSealAuthorizationPolicy(request, options.policy)) {
		return { outcome: 'denied' };
	}
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = await readExactObjectStream(source, request.sourceByteSize);
	} catch {
		return { outcome: 'denied' };
	}
	if ((await sha256Hex(bytes)) !== request.sourceSha256) return { outcome: 'denied' };
	const authorizationSha256 = await sha256TextHex(
		JSON.stringify({
			...request,
			evidenceSha256: claims.evidenceSha256,
			sentEventHash: claims.sentEventHash
		})
	);
	const expiry = claims.expiresAt * 1000;
	if (!(expiry > now().getTime())) return { outcome: 'denied' };
	const reservation = await options.ledger.reserve({
		issuer: claims.issuer,
		audience: claims.audience,
		envelopeId: request.envelopeId,
		operationId: request.operationId,
		authorizationSha256,
		expiresAt: new Date(expiry).toISOString()
	});
	if (reservation === 'conflict') return { outcome: 'conflict' };
	if (reservation === 'existing') return { outcome: 'replayed' };
	if (reservation !== 'reserved') return { outcome: 'denied' };
	return { outcome: 'signed', result: await options.sign(claims, bytes) };
}
