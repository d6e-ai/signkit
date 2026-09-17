import type { EnvelopeDocument } from '$lib/domain/envelope';

/**
 * One tracked document's stable metadata, keyed by its Markdown path within
 * one envelope's draft. Reused across draft commits: a path that keeps
 * existing keeps its `id` and `title` even as its content and generation
 * change; a path that disappears from the draft is dropped from this
 * projection.
 */
export interface EnvelopeDocumentInput {
	markdownPath: `documents/${string}.md`;
	/**
	 * Display title. When omitted for a newly observed path, an implementation
	 * derives one from the file name so every tracked document always has a
	 * stable, human-readable title without a separate round trip.
	 */
	title?: string;
}

/**
 * Durable store for `envelope_document` metadata. This is deliberately a
 * plain SQL projection with no audit event, idempotency key, or generation
 * check of its own: it is a display cache derived from the Git-backed draft,
 * not an independent source of truth, so `sync` is safe to call repeatedly
 * and reflects the draft's current document set exactly.
 */
export interface EnvelopeDocumentStore {
	listForEnvelope(envelopeId: string): Promise<readonly EnvelopeDocument[]>;
	/**
	 * Replaces the tracked document set to match `documents` exactly: paths
	 * already present keep their `id`, `title`, and `position` order key
	 * where possible; new paths are inserted; paths no longer present are
	 * deleted. Returns the resulting projection ordered by `position`.
	 */
	sync(
		envelopeId: string,
		documents: readonly EnvelopeDocumentInput[]
	): Promise<readonly EnvelopeDocument[]>;
	renameDocument(
		envelopeId: string,
		markdownPath: `documents/${string}.md`,
		title: string
	): Promise<EnvelopeDocument | null>;
}
