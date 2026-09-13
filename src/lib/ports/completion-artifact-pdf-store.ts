export interface PublishCompletionArtifactPdfCommand {
	organizationId: string;
	envelopeId: string;
	pdfObjectKey: string;
	pdfSha256: string;
	pdfManifestObjectKey: string;
	pdfManifestSha256: string;
	publishedAt: string;
}

export interface CompletionArtifactPdfRecord {
	pdfObjectKey: string;
	pdfSha256: string;
	pdfManifestObjectKey: string;
	pdfManifestSha256: string;
	publishedAt: string;
}

/**
 * The PDF is a pure, deterministic function of already-verified completion
 * evidence, so publication needs no audit event, lease, or CAS of its own:
 * an insert either lands the one-and-only row for this envelope, or a prior
 * attempt already did, in which case the existing row's digests must match
 * exactly (content-addressing makes a mismatch cryptographically impossible
 * for honest data, so a mismatch is a fail-closed integrity error rather
 * than a silent overwrite).
 */
export type PublishCompletionArtifactPdfResult =
	| { outcome: 'published' }
	| { outcome: 'already_published' }
	| { outcome: 'integrity_error' }
	| { outcome: 'artifact_not_found' };

export interface CompletionArtifactPdfStore {
	publishCompletionArtifactPdf(
		command: PublishCompletionArtifactPdfCommand
	): Promise<PublishCompletionArtifactPdfResult>;
	readCompletionArtifactPdf(
		organizationId: string,
		envelopeId: string
	): Promise<CompletionArtifactPdfRecord | null>;
}
