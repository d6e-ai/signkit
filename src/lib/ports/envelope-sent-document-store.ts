/**
 * The immutable, integrity-pinned pointer to one document's sent PDF and to
 * the ordered set those documents belong to.
 *
 * Object key, SHA-256, and byte size travel together: a reader that fetches
 * the object re-derives the digest and compares the length before disclosing
 * a single byte. The set row is the publication marker; document rows without
 * a matching set are inert.
 */

export interface SentDocumentPointer {
	envelopeId: string;
	commitSha: string;
	documentId: string;
	position: number;
	kind: 'markdown' | 'pdf';
	title: string;
	objectKey: string;
	sha256: string;
	byteSize: number;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
	createdAt: string;
}

export interface SentDocumentSetPointer {
	envelopeId: string;
	commitSha: string;
	documentSetHash: string;
	documentCount: number;
	documents: readonly SentDocumentPointer[];
	createdAt: string;
}

export interface EnvelopeSentDocumentStore {
	findSet(envelopeId: string, commitSha: string): Promise<SentDocumentSetPointer | null>;
	findDocument(
		envelopeId: string,
		commitSha: string,
		documentId: string
	): Promise<SentDocumentPointer | null>;
}
