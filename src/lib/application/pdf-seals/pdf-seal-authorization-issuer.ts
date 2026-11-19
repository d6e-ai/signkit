import {
	buildCompletionManifest,
	canonicalManifestJson,
	type BuildCompletionManifestInput
} from '$lib/application/completion-artifacts/completion-manifest';
import {
	COMPLETION_PDF_MANIFEST_SCHEMA,
	type CompletionPdfManifestV2
} from '$lib/application/completion-artifacts/completion-pdf';
import { sha256TextHex } from '$lib/domain/audit';
import { CompletionArtifactIntegrityError } from '$lib/ports/completion-artifact-store';
import {
	matchesPdfSealAuthorizationPolicy,
	pdfSealAuthorizationReference,
	signPdfSealAuthorization,
	validPdfSealAuthorizationRequest,
	type PdfSealAuthorizationPolicy,
	type PdfSealAuthorizationRequest,
	type PdfSealAuthorizationTrust
} from './pdf-seal-authorization';

export interface TrustedPdfSealCompletion {
	/** The authoritative inputs through envelope.completed, excluding later publication events. */
	completion: BuildCompletionManifestInput;
	/** Verified from the authority's immutable publication record before returning this object. */
	publishedManifestSha256: string;
	executedPdfManifest: CompletionPdfManifestV2;
	executedPdfByteSize: number;
}

export interface PdfSealAuthorizationIssuerOptions {
	identity: Pick<PdfSealAuthorizationTrust, 'issuer' | 'audience'>;
	policy: PdfSealAuthorizationPolicy;
	/**
	 * Read only from this authority's controlled recipient and publication plane. The
	 * requestor may choose an ID, but cannot supply the snapshot, route or credentials.
	 */
	readTrustedCompletion(
		envelopeId: string,
		audience: string
	): Promise<TrustedPdfSealCompletion | null>;
	sign(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array>;
	now?: () => Date;
}

/** Managed issuer entry point. No instance capability or request-supplied evidence is accepted. */
export async function issuePdfSealAuthorization(
	input: PdfSealAuthorizationRequest,
	options: PdfSealAuthorizationIssuerOptions
): Promise<string | null> {
	const request = pdfSealAuthorizationReference(input);
	if (
		!validPdfSealAuthorizationRequest(request) ||
		!matchesPdfSealAuthorizationPolicy(request, options.policy)
	) {
		return null;
	}
	const snapshot = await options.readTrustedCompletion(
		request.envelopeId,
		options.identity.audience
	);
	if (snapshot === null || snapshot.completion.envelopeId !== request.envelopeId) return null;
	const { completion, executedPdfManifest: pdf } = snapshot;
	if (
		pdf.schema !== COMPLETION_PDF_MANIFEST_SCHEMA ||
		pdf.artifactKind !== 'executed-agreement-v1' ||
		pdf.envelopeId !== request.envelopeId ||
		pdf.pdfSha256 !== request.sourceSha256 ||
		snapshot.executedPdfByteSize !== request.sourceByteSize ||
		pdf.manifestSha256 !== snapshot.publishedManifestSha256
	)
		return null;

	try {
		const manifest = await buildCompletionManifest(completion);
		const instructions = manifest.signingInstructions;
		if (
			instructions === undefined ||
			instructions.parties.length === 0 ||
			manifest.documentSetHash === undefined
		) {
			return null;
		}
		for (const field of completion.fields) {
			if ((await sha256TextHex(field.valueJson)) !== field.valueSha256) return null;
		}
		const evidenceSha256 = await sha256TextHex(canonicalManifestJson(manifest));
		if (evidenceSha256 !== snapshot.publishedManifestSha256) return null;
		const now = options.now?.() ?? new Date();
		if (!(Date.parse(manifest.completedAt) <= now.getTime())) return null;
		return await signPdfSealAuthorization(
			request,
			{ evidenceSha256, sentEventHash: instructions.sentEventHash },
			options.identity,
			options.sign,
			now
		);
	} catch (error: unknown) {
		if (error instanceof CompletionArtifactIntegrityError) return null;
		throw error;
	}
}
