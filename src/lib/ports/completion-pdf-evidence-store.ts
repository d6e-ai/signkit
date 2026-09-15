import type { FieldGeometry, FieldType } from '$lib/domain/envelope';

/**
 * Read-only field placement for PDF rendering. `envelope_field` is immutable
 * once an envelope is sent (fields are a whole-set replace only while
 * `ready`), so this is safe to read independently of the audit-verified
 * completion evidence: it locates values the manifest already proved were
 * signed, and can never change what they are.
 *
 * For the executed agreement PDF this read is integrity-critical rather than
 * decorative: a field the executed artifact must draw and cannot place is a
 * fail-closed publication error, never a silently dropped signature. Legacy
 * path-scoped fields (placed before per-document sends, see migration 0041)
 * carry `documentPath` and no geometry; those envelopes publish the evidence
 * summary alone.
 */
export interface CompletionPdfFieldGeometry {
	id: string;
	/** Exactly one of `documentId` and `documentPath` is set. */
	documentId: string | null;
	documentPath: string | null;
	position: number;
	recipientId: string;
	fieldType: FieldType;
	/** The unit-square placement frozen at field publication, or `null` for legacy fields. */
	geometry: FieldGeometry | null;
}

export interface CompletionPdfEvidenceStore {
	readFieldGeometry(
		organizationId: string,
		envelopeId: string
	): Promise<readonly CompletionPdfFieldGeometry[]>;
}
