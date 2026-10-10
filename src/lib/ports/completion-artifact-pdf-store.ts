export interface PublishCompletionArtifactPdfCommand {
	envelopeId: string;
	pdfObjectKey: string;
	pdfSha256: string;
	pdfByteSize: number;
	pdfManifestObjectKey: string;
	pdfManifestSha256: string;
	publishedAt: string;
}

export interface CompletionArtifactPdfRecord {
	/** The row's own persisted envelope ID, never the caller's requested ID — lets a reader verify the two agree. */
	envelopeId: string;
	pdfObjectKey: string;
	pdfSha256: string;
	/** Null only for rows created before the authoritative-size migration. */
	pdfByteSize: number | null;
	pdfManifestObjectKey: string;
	pdfManifestSha256: string;
	publishedAt: string;
}

/**
 * Standalone PDF pointer insert for repair and tests. Primary publication
 * writes this row in the same command transaction as the manifest. A missing
 * `completion_artifact` is `artifact_not_found`. An identical existing pointer
 * is a safe replay. A different pointer fails closed. Provider transients are
 * rethrown rather than classified as integrity or not-found.
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
	readCompletionArtifactPdf(envelopeId: string): Promise<CompletionArtifactPdfRecord | null>;
}
