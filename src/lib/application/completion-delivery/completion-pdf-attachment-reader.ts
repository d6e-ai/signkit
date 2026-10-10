import { completionArtifactObjectKey } from '$lib/application/completion-artifacts/completion-artifact-service';
import { sha256Hex } from '$lib/application/completion-artifacts/completion-manifest';
import { MAX_PUBLISHED_COMPLETION_PDF_BYTES } from '$lib/application/completion-artifacts/completion-pdf-limits';
import {
	ExactObjectStreamError,
	readExactObjectStream
} from '$lib/application/completion-artifacts/exact-object-stream';
import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore
} from '$lib/ports/completion-artifact-pdf-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';

/**
 * Conservative raw-PDF budget for a mailed attachment, well under Cloudflare's
 * general 5 MiB per-message limit once base64 (~4/3 expansion) and surrounding
 * MIME/headers overhead are accounted for. Cloudflare documents a 25 MiB
 * exception only for messages sent to a verified *destination* address (not a
 * verified sender or sending domain), which is deliberately not assumed here,
 * since completion delivery sends to arbitrary, unverified recipient
 * addresses across every configured mail provider.
 */
export const MAX_COMPLETION_MAIL_ATTACHMENT_PDF_BYTES: number = 3 * 1024 * 1024;

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;

export type CompletionPdfAttachmentOutcome =
	| { outcome: 'unpublished' }
	| { outcome: 'oversize'; byteSize: number }
	| { outcome: 'attached'; bytes: Uint8Array<ArrayBuffer>; byteSize: number }
	| { outcome: 'retryable_error'; errorCode: string }
	| { outcome: 'integrity_error'; errorCode: string };

export interface CompletionPdfAttachmentReaderPort {
	read(envelopeId: string): Promise<CompletionPdfAttachmentOutcome>;
}

function isPositiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

/**
 * Stands in for a real `CompletionPdfAttachmentReaderPort` in a production
 * deployment whose database is configured for completion delivery but whose
 * paired object storage (the R2 `OBJECTS` binding or S3 configuration) is
 * not. Always fails closed as retryable rather than letting the absence of a
 * reader be mistaken for "no PDF published yet" and silently sent link-only.
 */
export class MissingCompletionPdfAttachmentReader implements CompletionPdfAttachmentReaderPort {
	async read(): Promise<CompletionPdfAttachmentOutcome> {
		return { outcome: 'retryable_error', errorCode: 'completion_pdf_storage_not_configured' };
	}
}

/**
 * Reads and fully reverifies the immutable published completion PDF for a
 * completed envelope, for attaching to the completion notification email.
 *
 * This mirrors `PublicCompletionArtifactService`'s pdf-format re-derivation
 * (content-addressed key re-derived from the recorded digest, metadata
 * cross-checked, exact-size bounded read, digest recomputed over the actual
 * bytes) rather than trusting the durable record or object metadata alone.
 * `envelopeId` is the only identifier used to resolve the artifact — the
 * caller's already-verified `ClaimedCompletionDelivery` establishes that this
 * delivery is genuinely for that envelope; a recipient or delivery ID is
 * never used to widen or shortcut that lookup.
 */
export class CompletionPdfAttachmentReader implements CompletionPdfAttachmentReaderPort {
	readonly #pdfStore: CompletionArtifactPdfStore;
	readonly #objects: ObjectStore;

	constructor(pdfStore: CompletionArtifactPdfStore, objects: ObjectStore) {
		this.#pdfStore = pdfStore;
		this.#objects = objects;
	}

	async read(envelopeId: string): Promise<CompletionPdfAttachmentOutcome> {
		let record: CompletionArtifactPdfRecord | null;
		try {
			record = await this.#pdfStore.readCompletionArtifactPdf(envelopeId);
		} catch {
			return { outcome: 'retryable_error', errorCode: 'completion_pdf_record_unavailable' };
		}
		if (record === null) return { outcome: 'unpublished' };
		if (record.envelopeId !== envelopeId) {
			return { outcome: 'integrity_error', errorCode: 'completion_pdf_envelope_mismatch' };
		}

		if (!SHA256_PATTERN.test(record.pdfSha256)) {
			return { outcome: 'integrity_error', errorCode: 'completion_pdf_digest_invalid' };
		}
		const expectedKey: string = completionArtifactObjectKey(envelopeId, 'pdf', record.pdfSha256);
		if (record.pdfObjectKey !== expectedKey) {
			return { outcome: 'integrity_error', errorCode: 'completion_pdf_key_mismatch' };
		}
		if (record.pdfByteSize !== null && !isPositiveSafeInteger(record.pdfByteSize)) {
			return { outcome: 'integrity_error', errorCode: 'completion_pdf_byte_size_invalid' };
		}

		// The recorded byte size is never trusted for the oversize decision on
		// its own — a forged or corrupted large value must not be mistaken for
		// verified metadata. `head()` and the digest/key checks below always run
		// first; only the actual verified object size decides oversize.
		let metadata: ObjectMetadata | null;
		try {
			metadata = await this.#objects.head(expectedKey);
		} catch {
			return { outcome: 'retryable_error', errorCode: 'completion_pdf_storage_unavailable' };
		}
		if (metadata === null) {
			return { outcome: 'retryable_error', errorCode: 'completion_pdf_object_missing' };
		}
		if (
			metadata.key !== expectedKey ||
			metadata.sha256 !== record.pdfSha256 ||
			!isPositiveSafeInteger(metadata.size) ||
			metadata.size > MAX_PUBLISHED_COMPLETION_PDF_BYTES ||
			(record.pdfByteSize !== null && record.pdfByteSize !== metadata.size)
		) {
			return { outcome: 'integrity_error', errorCode: 'completion_pdf_metadata_mismatch' };
		}
		if (metadata.size > MAX_COMPLETION_MAIL_ATTACHMENT_PDF_BYTES) {
			return { outcome: 'oversize', byteSize: metadata.size };
		}

		let stream: ReadableStream<Uint8Array> | null;
		try {
			stream = await this.#objects.get(expectedKey);
		} catch {
			return { outcome: 'retryable_error', errorCode: 'completion_pdf_storage_unavailable' };
		}
		if (stream === null) {
			return { outcome: 'retryable_error', errorCode: 'completion_pdf_object_missing' };
		}

		let bytes: Uint8Array<ArrayBuffer>;
		try {
			bytes = await readExactObjectStream(stream, metadata.size);
		} catch (error: unknown) {
			if (error instanceof ExactObjectStreamError) {
				return { outcome: 'integrity_error', errorCode: 'completion_pdf_size_mismatch' };
			}
			return { outcome: 'retryable_error', errorCode: 'completion_pdf_storage_unavailable' };
		}

		if ((await sha256Hex(bytes)) !== record.pdfSha256) {
			return { outcome: 'integrity_error', errorCode: 'completion_pdf_digest_mismatch' };
		}
		return { outcome: 'attached', bytes, byteSize: bytes.byteLength };
	}
}
