import { MAX_PUBLISHED_COMPLETION_PDF_BYTES } from '$lib/application/completion-artifacts/completion-pdf-limits';
import { UUID_V7_PATTERN } from '$lib/ids/uuid-v7';
import type { PdfSealOperationReference } from '$lib/ports/pdf-seal-provider';
import { base64UrlEncode } from '$lib/security/opaque-token';

export interface PdfSealAuthorizationTrust {
	issuer: string;
	audience: string;
	/** Canonical unpadded base64url of an uncompressed P-256 public point. */
	publicKey: string;
}

export interface PdfSealAuthorizationRequest extends PdfSealOperationReference {
	envelopeId: string;
}

export interface PdfSealAuthorizationClaims extends PdfSealAuthorizationRequest {
	version: 1;
	issuer: string;
	audience: string;
	issuedAt: number;
	expiresAt: number;
	evidenceSha256: string;
	sentEventHash: string;
}

export type PdfSealAuthorizationPolicy = Pick<
	PdfSealOperationReference,
	| 'requestedProfile'
	| 'signerCertificateSha256'
	| 'sealPolicyId'
	| 'validationPolicyId'
	| 'tsaPolicyId'
	| 'tsaTrustBundleSha256'
>;

export function matchesPdfSealAuthorizationPolicy(
	request: PdfSealAuthorizationRequest,
	policy: PdfSealAuthorizationPolicy
): boolean {
	return (
		request.requestedProfile === policy.requestedProfile &&
		request.signerCertificateSha256 === policy.signerCertificateSha256 &&
		request.sealPolicyId === policy.sealPolicyId &&
		request.validationPolicyId === policy.validationPolicyId &&
		request.tsaPolicyId === policy.tsaPolicyId &&
		request.tsaTrustBundleSha256 === policy.tsaTrustBundleSha256
	);
}

const AUTHORIZATION_LIFETIME_SECONDS = 300;
const MAX_AUTHORIZATION_LENGTH = 4_096;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL_PATTERN = /^[\x21-\x7e]{1,128}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const protectedHeader = base64UrlEncode(
	encoder.encode(JSON.stringify({ alg: 'ES256', typ: 'signkit-pdf-seal-authorization+json' }))
);

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid authorization encoding');
	const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
		char.charCodeAt(0)
	);
	if (base64UrlEncode(bytes) !== value) throw new TypeError('Invalid authorization encoding');
	return bytes;
}

export function pdfSealAuthorizationReference(
	request: PdfSealAuthorizationRequest
): PdfSealAuthorizationRequest {
	return {
		envelopeId: request.envelopeId,
		operationId: request.operationId,
		sourceSha256: request.sourceSha256,
		sourceByteSize: request.sourceByteSize,
		requestedProfile: request.requestedProfile,
		signerCertificateSha256: request.signerCertificateSha256,
		sealPolicyId: request.sealPolicyId,
		validationPolicyId: request.validationPolicyId,
		tsaPolicyId: request.tsaPolicyId,
		tsaTrustBundleSha256: request.tsaTrustBundleSha256
	};
}

export function validPdfSealAuthorizationRequest(request: PdfSealAuthorizationRequest): boolean {
	return (
		typeof request.envelopeId === 'string' &&
		UUID_V7_PATTERN.test(request.envelopeId) &&
		typeof request.operationId === 'string' &&
		ID_PATTERN.test(request.operationId) &&
		typeof request.sourceSha256 === 'string' &&
		SHA256_PATTERN.test(request.sourceSha256) &&
		Number.isSafeInteger(request.sourceByteSize) &&
		request.sourceByteSize > 0 &&
		request.sourceByteSize <= MAX_PUBLISHED_COMPLETION_PDF_BYTES &&
		typeof request.signerCertificateSha256 === 'string' &&
		SHA256_PATTERN.test(request.signerCertificateSha256) &&
		typeof request.sealPolicyId === 'string' &&
		LABEL_PATTERN.test(request.sealPolicyId) &&
		typeof request.validationPolicyId === 'string' &&
		LABEL_PATTERN.test(request.validationPolicyId) &&
		((request.requestedProfile === 'pades-b-b' &&
			request.tsaPolicyId === null &&
			request.tsaTrustBundleSha256 === null) ||
			(request.requestedProfile === 'pades-b-t' &&
				typeof request.tsaPolicyId === 'string' &&
				LABEL_PATTERN.test(request.tsaPolicyId) &&
				typeof request.tsaTrustBundleSha256 === 'string' &&
				SHA256_PATTERN.test(request.tsaTrustBundleSha256)))
	);
}

function canonicalClaims(claims: PdfSealAuthorizationClaims): PdfSealAuthorizationClaims {
	return {
		version: claims.version,
		issuer: claims.issuer,
		audience: claims.audience,
		issuedAt: claims.issuedAt,
		expiresAt: claims.expiresAt,
		...pdfSealAuthorizationReference(claims),
		evidenceSha256: claims.evidenceSha256,
		sentEventHash: claims.sentEventHash
	};
}

function validClaims(claims: PdfSealAuthorizationClaims, now: Date): boolean {
	const seconds = Math.floor(now.getTime() / 1000);
	return (
		claims.version === 1 &&
		typeof claims.issuer === 'string' &&
		LABEL_PATTERN.test(claims.issuer) &&
		typeof claims.audience === 'string' &&
		LABEL_PATTERN.test(claims.audience) &&
		Number.isSafeInteger(claims.issuedAt) &&
		Number.isSafeInteger(claims.expiresAt) &&
		claims.issuedAt >= 0 &&
		claims.issuedAt <= seconds &&
		claims.expiresAt > seconds &&
		claims.expiresAt - claims.issuedAt <= AUTHORIZATION_LIFETIME_SECONDS &&
		typeof claims.evidenceSha256 === 'string' &&
		SHA256_PATTERN.test(claims.evidenceSha256) &&
		typeof claims.sentEventHash === 'string' &&
		SHA256_PATTERN.test(claims.sentEventHash) &&
		validPdfSealAuthorizationRequest(claims)
	);
}

/** Verify an independent issuer's grant against the exact requested provider operation. */
export async function verifyPdfSealAuthorization(
	token: string,
	request: PdfSealAuthorizationRequest,
	trust: PdfSealAuthorizationTrust,
	now: Date = new Date()
): Promise<PdfSealAuthorizationClaims | null> {
	try {
		if (token.length > MAX_AUTHORIZATION_LENGTH || !validPdfSealAuthorizationRequest(request)) {
			return null;
		}
		const parts = token.split('.');
		if (parts.length !== 3 || parts[0] !== protectedHeader) return null;
		const payload = decoder.decode(decodeBase64Url(parts[1]));
		const claims: PdfSealAuthorizationClaims = JSON.parse(payload);
		if (
			!validClaims(claims, now) ||
			claims.issuer !== trust.issuer ||
			claims.audience !== trust.audience ||
			JSON.stringify(canonicalClaims(claims)) !== payload ||
			JSON.stringify(pdfSealAuthorizationReference(claims)) !==
				JSON.stringify(pdfSealAuthorizationReference(request))
		)
			return null;
		const signature = decodeBase64Url(parts[2]);
		const publicKey = decodeBase64Url(trust.publicKey);
		if (signature.length !== 64 || publicKey.length !== 65 || publicKey[0] !== 4) return null;
		const key = await crypto.subtle.importKey(
			'raw',
			publicKey,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify']
		);
		return (await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			key,
			signature,
			encoder.encode(`${parts[0]}.${parts[1]}`)
		))
			? claims
			: null;
	} catch {
		return null;
	}
}

/** Issuer-side only. The caller supplies the authority's ES256 signing operation. */
export async function signPdfSealAuthorization(
	request: PdfSealAuthorizationRequest,
	evidence: Pick<PdfSealAuthorizationClaims, 'evidenceSha256' | 'sentEventHash'>,
	authority: Pick<PdfSealAuthorizationTrust, 'issuer' | 'audience'>,
	sign: (input: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>,
	now: Date
): Promise<string> {
	const issuedAt = Math.floor(now.getTime() / 1000);
	const claims = canonicalClaims({
		version: 1,
		issuer: authority.issuer,
		audience: authority.audience,
		...pdfSealAuthorizationReference(request),
		evidenceSha256: evidence.evidenceSha256,
		sentEventHash: evidence.sentEventHash,
		issuedAt,
		expiresAt: issuedAt + AUTHORIZATION_LIFETIME_SECONDS
	});
	if (!validClaims(claims, now)) throw new TypeError('Invalid authorization claims');
	const input = `${protectedHeader}.${base64UrlEncode(encoder.encode(JSON.stringify(claims)))}`;
	const signature = await sign(encoder.encode(input));
	if (signature.length !== 64) throw new TypeError('Invalid authorization signature');
	return `${input}.${base64UrlEncode(signature)}`;
}
