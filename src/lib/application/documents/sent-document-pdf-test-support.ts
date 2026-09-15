import type { ImmutableDraftRevision } from '$lib/application/drafts/draft-persistence';
import {
	sentPdfObjectKey,
	type SentDocumentArtifact,
	type SentDocumentPdfPort,
	type SentDocumentSetArtifact,
	type RenderedSentDocument
} from './sent-document-pdf';

/**
 * A stand-in for the real renderer in tests that care about what a send
 * *publishes*, not about typography. It produces a structurally valid,
 * content-addressed pointer so store and application assertions exercise the
 * same shape production does.
 */
export const FAKE_SENT_PDF_SHA256: string = 'd'.repeat(64);
export const FAKE_DOCUMENT_SET_HASH: string = 'e'.repeat(64);
export const FAKE_SENT_DOCUMENT_ID: string = '01900000-0000-7000-8000-000000000010';

export function fakeSentDocumentArtifact(
	organizationId: string,
	envelopeId: string,
	overrides: Partial<SentDocumentArtifact> = {}
): SentDocumentArtifact {
	const sha256: string = overrides.sha256 ?? FAKE_SENT_PDF_SHA256;
	return {
		documentId: FAKE_SENT_DOCUMENT_ID,
		position: 0,
		kind: 'markdown',
		title: 'agreement',
		objectKey: sentPdfObjectKey(organizationId, envelopeId, sha256),
		sha256,
		byteSize: 4096,
		pageCount: 2,
		pageWidth: 595.28,
		pageHeight: 841.89,
		...overrides
	};
}

export function fakeSentDocumentSetArtifact(
	organizationId: string,
	envelopeId: string,
	overrides: Partial<SentDocumentSetArtifact> = {}
): SentDocumentSetArtifact {
	const documents: readonly SentDocumentArtifact[] = overrides.documents ?? [
		fakeSentDocumentArtifact(organizationId, envelopeId)
	];
	return {
		documentSetHash: FAKE_DOCUMENT_SET_HASH,
		documentCount: documents.length,
		documents,
		...overrides
	};
}

/** Legacy concatenated pointer shape retained for envelope_sent_pdf tests. */
export function fakeSentPdfArtifact(
	organizationId: string,
	envelopeId: string,
	overrides: Record<string, unknown> = {}
): {
	objectKey: string;
	sha256: string;
	byteSize: number;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
	documents: readonly {
		path: string;
		title: string;
		firstPage: number;
		lastPage: number;
	}[];
} {
	const sha256: string =
		typeof overrides.sha256 === 'string' ? overrides.sha256 : FAKE_SENT_PDF_SHA256;
	return {
		objectKey: sentPdfObjectKey(organizationId, envelopeId, sha256),
		sha256,
		byteSize: 4096,
		pageCount: 2,
		pageWidth: 595.28,
		pageHeight: 841.89,
		documents: [{ path: 'documents/agreement.md', title: 'agreement', firstPage: 1, lastPage: 2 }],
		...overrides
	};
}

export class FakeSentDocumentPdf implements SentDocumentPdfPort {
	readonly published: ImmutableDraftRevision[] = [];

	constructor(private readonly failure: Error | null = null) {}

	async publish(revision: ImmutableDraftRevision): Promise<SentDocumentSetArtifact> {
		if (this.failure !== null) throw this.failure;
		this.published.push(revision);
		return fakeSentDocumentSetArtifact(revision.organizationId, revision.envelopeId);
	}

	async renderDocument(
		revision: ImmutableDraftRevision,
		documentId: string
	): Promise<RenderedSentDocument> {
		if (this.failure !== null) throw this.failure;
		const artifact: SentDocumentArtifact = fakeSentDocumentArtifact(
			revision.organizationId,
			revision.envelopeId,
			{ documentId }
		);
		return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), ...artifact };
	}

	async listDocuments(revision: ImmutableDraftRevision): Promise<{
		documentSetHash: string;
		documents: readonly Omit<SentDocumentArtifact, 'objectKey' | 'sha256' | 'byteSize'>[];
	}> {
		if (this.failure !== null) throw this.failure;
		const set = fakeSentDocumentSetArtifact(revision.organizationId, revision.envelopeId);
		return {
			documentSetHash: set.documentSetHash,
			documents: set.documents.map((document) => ({
				documentId: document.documentId,
				position: document.position,
				kind: document.kind,
				title: document.title,
				pageCount: document.pageCount,
				pageWidth: document.pageWidth,
				pageHeight: document.pageHeight
			}))
		};
	}
}
