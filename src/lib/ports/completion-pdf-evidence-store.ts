/**
 * Read-only field placement geometry for PDF rendering. `envelope_field` is
 * immutable once an envelope is sent (fields are a whole-set replace only
 * while `ready`), so this is safe to read independently of the
 * audit-verified completion evidence: it can only ever enrich the PDF's
 * layout, never change what the manifest already proved was signed.
 */
export interface CompletionPdfFieldGeometry {
	id: string;
	documentPath: string;
	position: number;
	recipientId: string;
}

export interface CompletionPdfEvidenceStore {
	readFieldGeometry(
		organizationId: string,
		envelopeId: string
	): Promise<readonly CompletionPdfFieldGeometry[]>;
}
