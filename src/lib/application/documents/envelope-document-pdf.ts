import type { Envelope } from '$lib/domain/envelope';
import type { ImmutableDraftRevision } from '$lib/application/drafts/draft-persistence';
import type { EnvelopeStore } from '$lib/ports/envelope-store';
import {
	SentDocumentPdfError,
	type SentDocumentArtifact,
	type SentDocumentPdfPort
} from './sent-document-pdf';

/**
 * The sender's view of one document in the envelope's pinned revision.
 *
 * Field placement is only meaningful if the sender is dragging boxes onto the
 * exact pages the signer will see for that document, so the editor renders
 * through the identical deterministic pipeline used at send time.
 */
export interface EnvelopeDocumentSummary {
	documentId: string;
	position: number;
	kind: 'markdown' | 'pdf';
	title: string;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
}

export interface EnvelopeDocumentPdf {
	bytes: Uint8Array;
	sha256: string;
	byteSize: number;
	commitSha: string;
	generation: number;
	documentId: string;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
	documents: readonly EnvelopeDocumentSummary[];
}

export type EnvelopeDocumentPdfResult =
	| { outcome: 'ok'; pdf: EnvelopeDocumentPdf }
	| { outcome: 'not_found' }
	| { outcome: 'no_documents' }
	| { outcome: 'unavailable' };

export interface EnvelopeDocumentPdfApplicationPort {
	read(envelopeId: string, documentId: string): Promise<EnvelopeDocumentPdfResult>;
}

export class EnvelopeDocumentPdfService implements EnvelopeDocumentPdfApplicationPort {
	constructor(
		private readonly envelopes: Pick<EnvelopeStore, 'findEnvelope'>,
		private readonly documentPdf: SentDocumentPdfPort
	) {}

	async read(envelopeId: string, documentId: string): Promise<EnvelopeDocumentPdfResult> {
		const envelope: Envelope | null = await this.envelopes.findEnvelope(envelopeId);
		if (envelope === null) return { outcome: 'not_found' };
		if (
			envelope.repositoryHead === null ||
			envelope.repositoryArchiveKey === null ||
			envelope.repositoryArchiveSha256 === null
		) {
			return { outcome: 'no_documents' };
		}
		const revision: ImmutableDraftRevision = {
			envelopeId,
			commitSha: envelope.repositoryHead,
			archiveKey: envelope.repositoryArchiveKey,
			archiveSha256: envelope.repositoryArchiveSha256
		};
		try {
			const listed = await this.documentPdf.listDocuments(revision);
			const summaries: EnvelopeDocumentSummary[] = listed.documents.map(
				(document: Omit<SentDocumentArtifact, 'objectKey' | 'sha256' | 'byteSize'>) => ({
					documentId: document.documentId,
					position: document.position,
					kind: document.kind,
					title: document.title,
					pageCount: document.pageCount,
					pageWidth: document.pageWidth,
					pageHeight: document.pageHeight
				})
			);
			if (!summaries.some((document) => document.documentId === documentId)) {
				return { outcome: 'no_documents' };
			}
			const rendered = await this.documentPdf.renderDocument(revision, documentId);
			return {
				outcome: 'ok',
				pdf: {
					bytes: rendered.bytes,
					sha256: rendered.sha256,
					byteSize: rendered.byteSize,
					commitSha: envelope.repositoryHead,
					generation: envelope.repositoryGeneration,
					documentId: rendered.documentId,
					pageCount: rendered.pageCount,
					pageWidth: rendered.pageWidth,
					pageHeight: rendered.pageHeight,
					documents: summaries
				}
			};
		} catch (error: unknown) {
			if (error instanceof SentDocumentPdfError) return { outcome: 'no_documents' };
			console.error(JSON.stringify({ event: 'envelope_document_pdf_render_failed' }));
			return { outcome: 'unavailable' };
		}
	}
}
