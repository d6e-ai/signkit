import type { ImmutableDraftRevision } from '$lib/application/drafts/draft-persistence';
import {
	sentPdfObjectKey,
	type SentDocumentPdfPort,
	type SentPdfArtifact
} from './sent-document-pdf';

/**
 * A stand-in for the real renderer in tests that care about what a send
 * *publishes*, not about typography. It produces a structurally valid,
 * content-addressed pointer so store and application assertions exercise the
 * same shape production does.
 */
export const FAKE_SENT_PDF_SHA256: string = 'd'.repeat(64);

export function fakeSentPdfArtifact(
	organizationId: string,
	envelopeId: string,
	overrides: Partial<SentPdfArtifact> = {}
): SentPdfArtifact {
	const sha256: string = overrides.sha256 ?? FAKE_SENT_PDF_SHA256;
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

	async publish(revision: ImmutableDraftRevision): Promise<SentPdfArtifact> {
		if (this.failure !== null) throw this.failure;
		this.published.push(revision);
		return fakeSentPdfArtifact(revision.organizationId, revision.envelopeId);
	}

	async render(revision: ImmutableDraftRevision): Promise<{ bytes: Uint8Array } & SentPdfArtifact> {
		if (this.failure !== null) throw this.failure;
		return {
			bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
			...fakeSentPdfArtifact(revision.organizationId, revision.envelopeId)
		};
	}
}
