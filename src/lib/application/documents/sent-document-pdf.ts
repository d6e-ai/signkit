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
import { uploadedPdfObjectKey } from '$lib/application/documents/uploaded-pdf';
import {
	documentSetHash,
	parseDocumentSet,
	type DocumentSetLeaf,
	type DocumentSetManifest,
	type MarkdownDocumentLeaf,
	type PdfDocumentLeaf
} from '$lib/domain/document-set';
import { isMarkdownPath } from '$lib/domain/envelope';
import type { DraftDocument, DraftRepository } from '$lib/ports/draft-repository';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import {
	RecipientMarkdownRenderError,
	renderRecipientMarkdown
} from '$lib/security/recipient-markdown';

/**
 * Renders and stores one PDF per document in the envelope's document set.
 *
 * The Git archive stays the source of truth for history. Recipients never see
 * a concatenation: each document is its own content-addressed object. Uploaded
 * PDFs are copied byte-identically; Markdown is rendered deterministically per
 * document. Objects are written immutably before any database row references
 * them.
 */

export const SENT_PDF_CONTENT_TYPE: string = 'application/pdf';
export const MAX_SENT_PDF_BYTES: number = 24 * 1024 * 1024;
export const MAX_SENT_PDF_DOCUMENTS: number = 20;
const MAX_TOTAL_MARKDOWN_BYTES: number = 1024 * 1024;

export class SentDocumentPdfError extends Error {
	readonly code = 'SENT_DOCUMENT_PDF_ERROR';

	constructor(message: string) {
		super(message);
		this.name = 'SentDocumentPdfError';
	}
}

export interface SentDocumentArtifact {
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
}

export interface SentDocumentSetArtifact {
	documentSetHash: string;
	documentCount: number;
	documents: readonly SentDocumentArtifact[];
}

export interface RenderedSentDocument extends SentDocumentArtifact {
	bytes: Uint8Array;
}

export interface SentDocumentPdfPort {
	publish(revision: ImmutableDraftRevision): Promise<SentDocumentSetArtifact>;
	renderDocument(
		revision: ImmutableDraftRevision,
		documentId: string
	): Promise<RenderedSentDocument>;
	listDocuments(revision: ImmutableDraftRevision): Promise<{
		documentSetHash: string;
		documents: readonly Omit<SentDocumentArtifact, 'objectKey' | 'sha256' | 'byteSize'>[];
	}>;
}

export class SentDocumentPdfService implements SentDocumentPdfPort {
	constructor(
		private readonly objects: ObjectStore,
		private readonly repository: DraftRepository
	) {}

	async listDocuments(revision: ImmutableDraftRevision): Promise<{
		documentSetHash: string;
		documents: readonly Omit<SentDocumentArtifact, 'objectKey' | 'sha256' | 'byteSize'>[];
	}> {
		const loaded = await this.loadSet(revision);
		const documents: Omit<SentDocumentArtifact, 'objectKey' | 'sha256' | 'byteSize'>[] = [];
		for (const leaf of loaded.manifest.documents) {
			documents.push(await this.summarizeLeaf(revision, loaded.markdown, leaf));
		}
		return { documentSetHash: loaded.documentSetHash, documents };
	}

	async renderDocument(
		revision: ImmutableDraftRevision,
		documentId: string
	): Promise<RenderedSentDocument> {
		const loaded = await this.loadSet(revision);
		const leaf: DocumentSetLeaf | undefined = loaded.manifest.documents.find(
			(entry: DocumentSetLeaf): boolean => entry.id === documentId
		);
		if (leaf === undefined) {
			throw new SentDocumentPdfError('The requested document is not in the sent revision');
		}
		return this.renderLeaf(revision, loaded.markdown, leaf);
	}

	async publish(revision: ImmutableDraftRevision): Promise<SentDocumentSetArtifact> {
		const loaded = await this.loadSet(revision);
		const documents: SentDocumentArtifact[] = [];
		for (const leaf of loaded.manifest.documents) {
			const rendered: RenderedSentDocument = await this.renderLeaf(revision, loaded.markdown, leaf);
			await this.persistImmutablePdf(rendered.objectKey, rendered.bytes, rendered.sha256);
			const { bytes: _bytes, ...artifact } = rendered;
			void _bytes;
			documents.push(artifact);
		}
		return {
			documentSetHash: loaded.documentSetHash,
			documentCount: documents.length,
			documents
		};
	}

	private async loadSet(revision: ImmutableDraftRevision): Promise<{
		manifest: DocumentSetManifest;
		markdown: ReadonlyMap<string, DraftDocument>;
		documentSetHash: string;
	}> {
		if (typeof this.repository.readManifest !== 'function') {
			throw new SentDocumentPdfError('The sent revision has no document set');
		}
		const verified = await readImmutableDraftRevision(revision, this.objects, this.repository);
		let manifestJson: string | null;
		try {
			manifestJson = await this.repository.readManifest(verified.archive, revision.commitSha);
		} catch {
			throw new SentDocumentPdfError('The sent revision document set is invalid');
		}
		if (manifestJson === null) {
			throw new SentDocumentPdfError('The sent revision has no document set');
		}
		let manifest: DocumentSetManifest;
		try {
			manifest = parseDocumentSet(manifestJson);
		} catch {
			throw new SentDocumentPdfError('The sent revision document set is invalid');
		}
		const markdown: Map<string, DraftDocument> = new Map(
			verified.documents.map((document: DraftDocument): [string, DraftDocument] => [
				document.path,
				document
			])
		);
		return {
			manifest,
			markdown,
			documentSetHash: await documentSetHash(manifest)
		};
	}

	private async summarizeLeaf(
		revision: ImmutableDraftRevision,
		markdown: ReadonlyMap<string, DraftDocument>,
		leaf: DocumentSetLeaf
	): Promise<Omit<SentDocumentArtifact, 'objectKey' | 'sha256' | 'byteSize'>> {
		if (leaf.kind === 'pdf') {
			return {
				documentId: leaf.id,
				position: leaf.position,
				kind: 'pdf',
				title: leaf.title,
				pageCount: leaf.pageCount,
				pageWidth: leaf.pageWidth,
				pageHeight: leaf.pageHeight
			};
		}
		const rendered: RenderedSentDocument = await this.renderMarkdownLeaf(revision, markdown, leaf);
		return {
			documentId: rendered.documentId,
			position: rendered.position,
			kind: rendered.kind,
			title: rendered.title,
			pageCount: rendered.pageCount,
			pageWidth: rendered.pageWidth,
			pageHeight: rendered.pageHeight
		};
	}

	private async renderLeaf(
		revision: ImmutableDraftRevision,
		markdown: ReadonlyMap<string, DraftDocument>,
		leaf: DocumentSetLeaf
	): Promise<RenderedSentDocument> {
		return renderSentDocumentLeaf(this.objects, revision, markdown, leaf);
	}

	private async renderMarkdownLeaf(
		revision: ImmutableDraftRevision,
		markdown: ReadonlyMap<string, DraftDocument>,
		leaf: MarkdownDocumentLeaf
	): Promise<RenderedSentDocument> {
		return renderMarkdownLeaf(revision, markdown, leaf);
	}

	private async persistImmutablePdf(key: string, bytes: Uint8Array, sha256: string): Promise<void> {
		try {
			const stored: ObjectMetadata = await this.objects.putImmutable(key, {
				contentType: SENT_PDF_CONTENT_TYPE,
				body: bytes,
				sha256,
				metadata: { format: 'signkit-sent-agreement-pdf-v1' }
			});
			if (stored.key !== key || stored.sha256 !== sha256 || stored.size !== bytes.byteLength) {
				throw new SentDocumentPdfError('Object store did not confirm the sent agreement PDF');
			}
		} catch (error: unknown) {
			const existing: ObjectMetadata | null = await this.objects.head(key);
			if (existing === null || existing.sha256 !== sha256 || existing.size !== bytes.byteLength) {
				throw error;
			}
			const stream: ReadableStream<Uint8Array> | null = await this.objects.get(key);
			if (stream === null) throw error;
			let body: Uint8Array;
			try {
				body = await readStreamBounded(stream, bytes.byteLength);
			} catch {
				throw error;
			}
			if (body.byteLength !== bytes.byteLength || (await sha256Hex(body)) !== sha256) {
				throw error;
			}
		}
	}
}

export function renderRevisionPdf(documents: readonly DraftDocument[]): AgreementPdfResult {
	return renderMarkdownRevisionPdf(documents);
}

/**
 * Renders one document of a sent revision to the exact bytes recipients were
 * served: an uploaded PDF is returned verbatim after passing its pinned size
 * and SHA-256 checks, and Markdown is re-rendered deterministically.
 *
 * Exported because the executed agreement PDF has to start from the same
 * bytes, and re-deriving them from the already-verified revision is safer than
 * trusting a second, unverified pointer read.
 */
export async function renderSentDocumentLeaf(
	objects: ObjectStore,
	revision: ImmutableDraftRevision,
	markdown: ReadonlyMap<string, DraftDocument>,
	leaf: DocumentSetLeaf
): Promise<RenderedSentDocument> {
	if (leaf.kind === 'pdf') return renderUploadedLeaf(objects, revision, leaf);
	return renderMarkdownLeaf(revision, markdown, leaf);
}

async function renderUploadedLeaf(
	objects: ObjectStore,
	revision: ImmutableDraftRevision,
	leaf: PdfDocumentLeaf
): Promise<RenderedSentDocument> {
	const uploadedKey: string = uploadedPdfObjectKey(revision.envelopeId, leaf.sha256);
	const stream: ReadableStream<Uint8Array> | null = await objects.get(uploadedKey);
	if (stream === null) {
		throw new SentDocumentPdfError('Uploaded agreement PDF is missing');
	}
	let bytes: Uint8Array;
	try {
		bytes = await readStreamBounded(stream, MAX_SENT_PDF_BYTES);
	} catch (error: unknown) {
		if (error instanceof SentDocumentPdfError) throw error;
		throw new SentDocumentPdfError('Uploaded agreement PDF could not be read');
	}
	if (bytes.byteLength !== leaf.byteSize) {
		throw new SentDocumentPdfError('Uploaded agreement PDF size does not match its manifest');
	}
	const digest: string = await sha256Hex(bytes);
	if (digest !== leaf.sha256) {
		throw new SentDocumentPdfError('Uploaded agreement PDF failed SHA-256 verification');
	}
	return {
		bytes,
		documentId: leaf.id,
		position: leaf.position,
		kind: 'pdf',
		title: leaf.title,
		objectKey: sentPdfObjectKey(revision.envelopeId, digest),
		sha256: digest,
		byteSize: bytes.byteLength,
		pageCount: leaf.pageCount,
		pageWidth: leaf.pageWidth,
		pageHeight: leaf.pageHeight
	};
}

async function renderMarkdownLeaf(
	revision: ImmutableDraftRevision,
	markdown: ReadonlyMap<string, DraftDocument>,
	leaf: MarkdownDocumentLeaf
): Promise<RenderedSentDocument> {
	if (!isMarkdownPath(leaf.path)) {
		throw new SentDocumentPdfError('The sent revision Markdown path is invalid');
	}
	const document: DraftDocument | undefined = markdown.get(leaf.path);
	if (document === undefined) {
		throw new SentDocumentPdfError('The sent revision Markdown document is missing');
	}
	const result: AgreementPdfResult = renderMarkdownRevisionPdf([document]);
	const bytes: Uint8Array = result.bytes;
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_SENT_PDF_BYTES) {
		throw new SentDocumentPdfError('Rendered agreement PDF is outside the supported size');
	}
	const digest: string = await sha256Hex(bytes);
	return {
		bytes,
		documentId: leaf.id,
		position: leaf.position,
		kind: 'markdown',
		title: leaf.title,
		objectKey: sentPdfObjectKey(revision.envelopeId, digest),
		sha256: digest,
		byteSize: bytes.byteLength,
		pageCount: result.pageCount,
		pageWidth: result.pageWidth,
		pageHeight: result.pageHeight
	};
}

function renderMarkdownRevisionPdf(documents: readonly DraftDocument[]): AgreementPdfResult {
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
	/^sent-documents\/v1\/envelopes\/([^/]+)\/sha256\/([a-f0-9]{64})\.pdf$/;

export function sentPdfObjectKey(envelopeId: string, sha256: string): string {
	if (!SHA256_PATTERN.test(sha256)) throw new SentDocumentPdfError('Sent PDF digest is invalid');
	return `sent-documents/v1/envelopes/${encodeScopeSegment(envelopeId)}/sha256/${sha256}.pdf`;
}

export interface ParsedSentPdfKey {
	envelopeId: string;
	sha256: string;
}

export function parseSentPdfObjectKey(key: string): ParsedSentPdfKey | null {
	const match: RegExpExecArray | null = SENT_PDF_KEY_PATTERN.exec(key);
	if (match === null) return null;
	try {
		const parsed: ParsedSentPdfKey = {
			envelopeId: decodeURIComponent(match[1]),
			sha256: match[2]
		};
		if (sentPdfObjectKey(parsed.envelopeId, parsed.sha256) !== key) {
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

export interface SentAuditDocument {
	id: string;
	sha256: string;
	byteSize: number;
	pageCount: number;
}

export function sentAuditDocuments(
	documents: readonly Pick<
		SentDocumentArtifact,
		'documentId' | 'sha256' | 'byteSize' | 'pageCount'
	>[]
): readonly SentAuditDocument[] {
	return documents.map(
		(
			document: Pick<SentDocumentArtifact, 'documentId' | 'sha256' | 'byteSize' | 'pageCount'>
		): SentAuditDocument => ({
			id: document.documentId,
			sha256: document.sha256,
			byteSize: document.byteSize,
			pageCount: document.pageCount
		})
	);
}

async function readStreamBounded(
	stream: ReadableStream<Uint8Array>,
	maximumBytes: number
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size: number = 0;
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > maximumBytes) {
				await reader.cancel('sent agreement PDF exceeds its pinned size');
				throw new SentDocumentPdfError('Sent agreement PDF exceeds its pinned size');
			}
			chunks.push(result.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes: Uint8Array = new Uint8Array(size);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
