import {
	AgreementPdfBoundExceededError,
	renderAgreementPdf,
	type AgreementPdfDocument,
	type AgreementPdfResult
} from '$lib/adapters/pdf/agreement-pdf';
import {
	readImmutableDraftRevision,
	type ImmutableDraftRevision
} from '$lib/application/drafts/draft-persistence';
import type { DraftDocument, DraftRepository } from '$lib/ports/draft-repository';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import type { SentPdfDocumentPages } from '$lib/ports/envelope-sent-pdf-store';
import {
	RecipientMarkdownRenderError,
	renderRecipientMarkdown
} from '$lib/security/recipient-markdown';

/**
 * Renders and stores the PDF a recipient is actually shown.
 *
 * The Git archive stays the source of truth for history, but it is never what
 * a recipient sees: they get a fixed-layout rendering of one exact commit, so
 * "what was agreed to" is a concrete artifact with concrete page coordinates
 * rather than whatever a given Markdown renderer happened to produce that
 * day. That is also what makes DocuSign-style field placement meaningful --
 * page 3 at (0.42, 0.61) has to mean the same thing for the sender placing
 * the field and the signer filling it in.
 *
 * The object is content-addressed and written immutably before any database
 * row references it, mirroring how draft archives are published: a failed
 * publication leaves an unreferenced object for the orphan sweep, never a
 * durable pointer to bytes that do not exist.
 */

export const SENT_PDF_CONTENT_TYPE: string = 'application/pdf';
/** Comfortably above a long agreement, far below anything that could exhaust a Worker. */
export const MAX_SENT_PDF_BYTES: number = 24 * 1024 * 1024;
export const MAX_SENT_PDF_DOCUMENTS: number = 50;
const MAX_TOTAL_MARKDOWN_BYTES: number = 1024 * 1024;

export class SentDocumentPdfError extends Error {
	readonly code = 'SENT_DOCUMENT_PDF_ERROR';

	constructor(message: string) {
		super(message);
		this.name = 'SentDocumentPdfError';
	}
}

export interface SentPdfArtifact {
	objectKey: string;
	sha256: string;
	byteSize: number;
	pageCount: number;
	pageWidth: number;
	pageHeight: number;
	documents: readonly SentPdfDocumentPages[];
}

export interface SentDocumentPdfPort {
	/** Renders, stores, and returns the pinned pointer for one immutable revision. */
	publish(revision: ImmutableDraftRevision): Promise<SentPdfArtifact>;
	/**
	 * Renders one immutable revision without storing it. Used by the sender's
	 * placement editor, which needs the same page geometry the recipient will
	 * see before the envelope has been sent at all.
	 */
	render(revision: ImmutableDraftRevision): Promise<{ bytes: Uint8Array } & SentPdfArtifact>;
}

export class SentDocumentPdfService implements SentDocumentPdfPort {
	constructor(
		private readonly objects: ObjectStore,
		private readonly repository: DraftRepository
	) {}

	async render(revision: ImmutableDraftRevision): Promise<{ bytes: Uint8Array } & SentPdfArtifact> {
		const documents: readonly DraftDocument[] = await readImmutableDraftRevision(
			revision,
			this.objects,
			this.repository
		);
		const result: AgreementPdfResult = renderRevisionPdf(documents);
		const bytes: Uint8Array = result.bytes;
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_SENT_PDF_BYTES) {
			throw new SentDocumentPdfError('Rendered agreement PDF is outside the supported size');
		}
		const sha256: string = await sha256Hex(bytes);
		return {
			bytes,
			objectKey: sentPdfObjectKey(revision.organizationId, revision.envelopeId, sha256),
			sha256,
			byteSize: bytes.byteLength,
			pageCount: result.pageCount,
			pageWidth: result.pageWidth,
			pageHeight: result.pageHeight,
			documents: result.documents.map((entry): SentPdfDocumentPages => ({
				path: documents[entry.index].path,
				title: entry.title,
				firstPage: entry.firstPage,
				lastPage: entry.lastPage
			}))
		};
	}

	async publish(revision: ImmutableDraftRevision): Promise<SentPdfArtifact> {
		const rendered = await this.render(revision);
		try {
			const stored: ObjectMetadata = await this.objects.putImmutable(rendered.objectKey, {
				contentType: SENT_PDF_CONTENT_TYPE,
				body: rendered.bytes,
				sha256: rendered.sha256,
				metadata: { format: 'signkit-sent-agreement-pdf-v1' }
			});
			if (
				stored.key !== rendered.objectKey ||
				stored.sha256 !== rendered.sha256 ||
				stored.size !== rendered.byteSize
			) {
				throw new SentDocumentPdfError('Object store did not confirm the sent agreement PDF');
			}
		} catch (error: unknown) {
			// A provider can fail a precondition or lose the response after
			// accepting the write. Reuse is only safe once we have read the
			// immutable object back and re-derived its digest ourselves.
			const existing: ObjectMetadata | null = await this.objects.head(rendered.objectKey);
			if (
				existing === null ||
				existing.sha256 !== rendered.sha256 ||
				existing.size !== rendered.byteSize
			) {
				throw error;
			}
		}
		const { bytes: _bytes, ...artifact } = rendered;
		void _bytes;
		return artifact;
	}
}

export function renderRevisionPdf(documents: readonly DraftDocument[]): AgreementPdfResult {
	if (documents.length === 0) {
		throw new SentDocumentPdfError('The sent revision contains no documents');
	}
	if (documents.length > MAX_SENT_PDF_DOCUMENTS) {
		throw new SentDocumentPdfError('The sent revision contains too many documents');
	}
	let totalBytes: number = 0;
	const encoder: TextEncoder = new TextEncoder();
	const pages: AgreementPdfDocument[] = documents.map((document: DraftDocument) => {
		totalBytes += encoder.encode(document.content).byteLength;
		if (totalBytes > MAX_TOTAL_MARKDOWN_BYTES) {
			throw new SentDocumentPdfError('The sent revision exceeds the total document size limit');
		}
		try {
			return {
				title: agreementDocumentTitle(document.path),
				nodes: renderRecipientMarkdown(document.content).nodes
			};
		} catch (error: unknown) {
			// A document too large or too deeply nested to sanitize is a bounded
			// read failure, not a rendering bug: it collapses into the same
			// fail-closed error every other bound here uses.
			if (error instanceof RecipientMarkdownRenderError) {
				throw new SentDocumentPdfError('A document exceeds the safe rendering budget');
			}
			throw error;
		}
	});
	try {
		return renderAgreementPdf(pages);
	} catch (error: unknown) {
		if (error instanceof AgreementPdfBoundExceededError) {
			throw new SentDocumentPdfError(error.message);
		}
		throw error;
	}
}

/**
 * The heading shown above a document in the PDF. Derived from the Markdown
 * path with the same rule the browser uses for its document navigation, so a
 * recipient sees one consistent name in both places.
 */
export function agreementDocumentTitle(path: string): string {
	const name: string = path
		.replace(/^documents\//, '')
		.replace(/\.md$/, '')
		.replaceAll(/[-_]+/g, ' ')
		.trim();
	return name.length > 0 ? name : path;
}

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;
const SENT_PDF_KEY_PATTERN: RegExp =
	/^sent-documents\/v1\/organizations\/([^/]+)\/envelopes\/([^/]+)\/sha256\/([a-f0-9]{64})\.pdf$/;

export function sentPdfObjectKey(
	organizationId: string,
	envelopeId: string,
	sha256: string
): string {
	if (!SHA256_PATTERN.test(sha256)) throw new SentDocumentPdfError('Sent PDF digest is invalid');
	return `sent-documents/v1/organizations/${encodeScopeSegment(organizationId)}/envelopes/${encodeScopeSegment(envelopeId)}/sha256/${sha256}.pdf`;
}

export interface ParsedSentPdfKey {
	organizationId: string;
	envelopeId: string;
	sha256: string;
}

export function parseSentPdfObjectKey(key: string): ParsedSentPdfKey | null {
	const match: RegExpExecArray | null = SENT_PDF_KEY_PATTERN.exec(key);
	if (match === null) return null;
	try {
		const parsed: ParsedSentPdfKey = {
			organizationId: decodeURIComponent(match[1]),
			envelopeId: decodeURIComponent(match[2]),
			sha256: match[3]
		};
		if (sentPdfObjectKey(parsed.organizationId, parsed.envelopeId, parsed.sha256) !== key) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function encodeScopeSegment(value: string): string {
	return encodeURIComponent(value).replaceAll('.', '%2E');
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
