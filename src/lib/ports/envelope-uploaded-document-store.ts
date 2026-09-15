import { MAX_UPLOADED_DOCUMENTS_PER_ENVELOPE } from '$lib/application/documents/uploaded-pdf';

export interface EnvelopeUploadedDocumentRecord {
	organizationId: string;
	envelopeId: string;
	sha256: string;
	objectKey: string;
	byteSize: number;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
	createdAt: string;
}

export type InsertUploadedDocumentResult = 'inserted' | 'duplicate' | 'cap_exceeded' | 'not_found';

export interface EnvelopeUploadedDocumentStore {
	/**
	 * Append-only insert keyed by content address. Concurrent writers are
	 * serialized so the per-envelope cap cannot be exceeded by a race.
	 */
	insert(record: EnvelopeUploadedDocumentRecord): Promise<InsertUploadedDocumentResult>;
	find(
		organizationId: string,
		envelopeId: string,
		sha256: string
	): Promise<EnvelopeUploadedDocumentRecord | null>;
}

export { MAX_UPLOADED_DOCUMENTS_PER_ENVELOPE };
