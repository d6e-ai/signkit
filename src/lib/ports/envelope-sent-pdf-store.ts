/**
 * The page range one agreement document occupies inside the sent PDF.
 *
 * Field geometry pins a field to a page of the whole artifact, so the only
 * way to prove that a field placed on page 7 really belongs to the document
 * it names is to carry the document-to-page map alongside the pointer.
 */
export interface SentPdfDocumentPages {
	path: string;
	title: string;
	/** 1-indexed and inclusive. */
	firstPage: number;
	lastPage: number;
}

/**
 * The immutable, integrity-pinned pointer to the PDF rendering of the exact
 * revision an envelope was sent at.
 *
 * Object key, SHA-256, and byte size travel together: a reader that fetches
 * the object re-derives the digest and compares the length before disclosing
 * a single byte, so a swapped, truncated, or resurrected object fails closed
 * rather than reaching a recipient.
 */
export interface SentPdfPointer {
	organizationId: string;
	envelopeId: string;
	commitSha: string;
	objectKey: string;
	sha256: string;
	byteSize: number;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
	documents: readonly SentPdfDocumentPages[];
	createdAt: string;
}

export interface EnvelopeSentPdfStore {
	/**
	 * Reads the pointer for one envelope at one commit. Scoping by commit is
	 * what makes the read replay-safe: a pointer published for a different
	 * revision can never satisfy a request pinned to this one.
	 */
	findSentPdf(
		organizationId: string,
		envelopeId: string,
		commitSha: string
	): Promise<SentPdfPointer | null>;
}
