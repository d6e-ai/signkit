import type { Envelope } from '$lib/domain/envelope';
import type { ImmutableDraftRevision } from '$lib/application/drafts/draft-persistence';
import type { EnvelopeStore } from '$lib/ports/envelope-store';
import type { SentPdfDocumentPages } from '$lib/ports/envelope-sent-pdf-store';
import { SentDocumentPdfError, type SentDocumentPdfPort } from './sent-document-pdf';

/**
 * The sender's view of the same rendering a recipient will get.
 *
 * Field placement is only meaningful if the sender is dragging boxes onto the
 * exact pages the signer will see, so the editor renders the envelope's
 * currently pinned revision through the identical deterministic pipeline used
 * at send time. Nothing is stored here: this is a read of a pure function of
 * an already-immutable revision.
 */
export interface EnvelopeDocumentPdf {
	bytes: Uint8Array;
	sha256: string;
	byteSize: number;
	commitSha: string;
	generation: number;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
	documents: readonly SentPdfDocumentPages[];
}

export type EnvelopeDocumentPdfResult =
	| { outcome: 'ok'; pdf: EnvelopeDocumentPdf }
	| { outcome: 'not_found' }
	| { outcome: 'no_documents' }
	| { outcome: 'unavailable' };

export interface EnvelopeDocumentPdfApplicationPort {
	read(organizationId: string, envelopeId: string): Promise<EnvelopeDocumentPdfResult>;
}

export class EnvelopeDocumentPdfService implements EnvelopeDocumentPdfApplicationPort {
	constructor(
		private readonly envelopes: EnvelopeStore,
		private readonly documentPdf: SentDocumentPdfPort
	) {}

	async read(organizationId: string, envelopeId: string): Promise<EnvelopeDocumentPdfResult> {
		const envelope: Envelope | null = await this.envelopes.findForOrganization(
			organizationId,
			envelopeId
		);
		if (envelope === null) return { outcome: 'not_found' };
		if (
			envelope.repositoryHead === null ||
			envelope.repositoryArchiveKey === null ||
			envelope.repositoryArchiveSha256 === null
		) {
			return { outcome: 'no_documents' };
		}
		const revision: ImmutableDraftRevision = {
			organizationId,
			envelopeId,
			commitSha: envelope.repositoryHead,
			archiveKey: envelope.repositoryArchiveKey,
			archiveSha256: envelope.repositoryArchiveSha256
		};
		try {
			const rendered = await this.documentPdf.render(revision);
			return {
				outcome: 'ok',
				pdf: {
					bytes: rendered.bytes,
					sha256: rendered.sha256,
					byteSize: rendered.byteSize,
					commitSha: envelope.repositoryHead,
					generation: envelope.repositoryGeneration,
					pageCount: rendered.pageCount,
					pageWidth: rendered.pageWidth,
					pageHeight: rendered.pageHeight,
					documents: rendered.documents
				}
			};
		} catch (error: unknown) {
			if (error instanceof SentDocumentPdfError) return { outcome: 'no_documents' };
			console.error(JSON.stringify({ event: 'envelope_document_pdf_render_failed' }));
			return { outcome: 'unavailable' };
		}
	}
}
