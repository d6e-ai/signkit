import { completionArtifactObjectKey } from '$lib/application/completion-artifacts/completion-artifact-service';
import {
	MAX_MANIFEST_GZIP_BYTES,
	sha256Hex
} from '$lib/application/completion-artifacts/completion-manifest';
import { MAX_PUBLISHED_COMPLETION_PDF_BYTES } from '$lib/application/completion-artifacts/completion-pdf-limits';
import {
	ExactObjectStreamError,
	readExactObjectStream
} from '$lib/application/completion-artifacts/exact-object-stream';
import type {
	CompletionArtifactStatusRow,
	CompletionArtifactStore,
	PublishedCompletionArtifact
} from '$lib/ports/completion-artifact-store';
import type {
	CompletionArtifactPdfRecord,
	CompletionArtifactPdfStore
} from '$lib/ports/completion-artifact-pdf-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;

export interface VerifiedCompletionArtifactPointer {
	jsonSha256: string;
	markdownSha256: string;
	pdfSha256: string;
}

export type CompletionAccessReissueArtifactVerification =
	| { outcome: 'verified'; pointer: VerifiedCompletionArtifactPointer }
	| { outcome: 'unpublished' }
	| { outcome: 'integrity_error'; errorCode: string }
	| { outcome: 'retryable_error'; errorCode: string };

type ObjectVerification =
	{ outcome: 'verified' } | { outcome: 'integrity_error' | 'retryable_error'; errorCode: string };

/**
 * Independently re-verifies the completion manifest (JSON + Markdown) and the
 * completion PDF against actual object storage bytes immediately before a
 * reissue is published -- never trusting the `completion_artifact` /
 * `completion_artifact_pdf` database pointers alone. `CompletionPdfAttachmentReader`
 * is deliberately not reused for the PDF leg: it returns `oversize` without
 * reading or hashing bytes beyond `MAX_COMPLETION_MAIL_ATTACHMENT_PDF_BYTES`
 * (3 MiB), since it exists only to decide whether a PDF can be mailed as an
 * attachment. A reissue must verify the full published PDF, up to the
 * publication-time bound of 32 MiB.
 */
export class CompletionAccessReissueArtifactVerifier {
	readonly #artifacts: CompletionArtifactStore;
	readonly #pdfs: CompletionArtifactPdfStore;
	readonly #objects: ObjectStore;

	constructor(
		artifacts: CompletionArtifactStore,
		pdfs: CompletionArtifactPdfStore,
		objects: ObjectStore
	) {
		this.#artifacts = artifacts;
		this.#pdfs = pdfs;
		this.#objects = objects;
	}

	async verify(envelopeId: string): Promise<CompletionAccessReissueArtifactVerification> {
		let status: CompletionArtifactStatusRow | null;
		try {
			status = await this.#artifacts.findCompletionArtifactStatus(envelopeId);
		} catch {
			return { outcome: 'retryable_error', errorCode: 'completion_artifact_status_unavailable' };
		}
		const published: PublishedCompletionArtifact | null = status?.published ?? null;
		if (published === null) return { outcome: 'unpublished' };
		if (published.envelopeId !== envelopeId) {
			return { outcome: 'integrity_error', errorCode: 'completion_artifact_envelope_mismatch' };
		}

		let pdfRecord: CompletionArtifactPdfRecord | null;
		try {
			pdfRecord = await this.#pdfs.readCompletionArtifactPdf(envelopeId);
		} catch {
			return { outcome: 'retryable_error', errorCode: 'completion_pdf_record_unavailable' };
		}
		if (pdfRecord === null) return { outcome: 'unpublished' };
		if (pdfRecord.envelopeId !== envelopeId) {
			return { outcome: 'integrity_error', errorCode: 'completion_pdf_envelope_mismatch' };
		}

		const json: ObjectVerification = await this.#verifyGzipObject(
			envelopeId,
			'json',
			published.jsonSha256
		);
		if (json.outcome !== 'verified') return json;
		const markdown: ObjectVerification = await this.#verifyGzipObject(
			envelopeId,
			'markdown',
			published.markdownSha256
		);
		if (markdown.outcome !== 'verified') return markdown;
		const pdf: ObjectVerification = await this.#verifyPdfObject(envelopeId, pdfRecord.pdfSha256);
		if (pdf.outcome !== 'verified') return pdf;

		return {
			outcome: 'verified',
			pointer: {
				jsonSha256: published.jsonSha256,
				markdownSha256: published.markdownSha256,
				pdfSha256: pdfRecord.pdfSha256
			}
		};
	}

	async #verifyGzipObject(
		envelopeId: string,
		format: 'json' | 'markdown',
		digest: string
	): Promise<ObjectVerification> {
		if (!SHA256_PATTERN.test(digest)) {
			return { outcome: 'integrity_error', errorCode: `completion_${format}_digest_invalid` };
		}
		const key: string = completionArtifactObjectKey(envelopeId, format, digest);
		let metadata: ObjectMetadata | null;
		try {
			metadata = await this.#objects.head(key);
		} catch {
			return { outcome: 'retryable_error', errorCode: `completion_${format}_storage_unavailable` };
		}
		if (metadata === null) {
			return { outcome: 'retryable_error', errorCode: `completion_${format}_object_missing` };
		}
		if (
			metadata.key !== key ||
			metadata.sha256 !== digest ||
			!Number.isSafeInteger(metadata.size) ||
			metadata.size <= 0 ||
			metadata.size > MAX_MANIFEST_GZIP_BYTES
		) {
			return { outcome: 'integrity_error', errorCode: `completion_${format}_metadata_mismatch` };
		}
		return await this.#readAndVerifyDigest(key, metadata.size, digest, format);
	}

	async #verifyPdfObject(envelopeId: string, digest: string): Promise<ObjectVerification> {
		if (!SHA256_PATTERN.test(digest)) {
			return { outcome: 'integrity_error', errorCode: 'completion_pdf_digest_invalid' };
		}
		const key: string = completionArtifactObjectKey(envelopeId, 'pdf', digest);
		let metadata: ObjectMetadata | null;
		try {
			metadata = await this.#objects.head(key);
		} catch {
			return { outcome: 'retryable_error', errorCode: 'completion_pdf_storage_unavailable' };
		}
		if (metadata === null) {
			return { outcome: 'retryable_error', errorCode: 'completion_pdf_object_missing' };
		}
		if (
			metadata.key !== key ||
			metadata.sha256 !== digest ||
			!Number.isSafeInteger(metadata.size) ||
			metadata.size <= 0 ||
			metadata.size > MAX_PUBLISHED_COMPLETION_PDF_BYTES
		) {
			return { outcome: 'integrity_error', errorCode: 'completion_pdf_metadata_mismatch' };
		}
		return await this.#readAndVerifyDigest(key, metadata.size, digest, 'pdf');
	}

	async #readAndVerifyDigest(
		key: string,
		expectedSize: number,
		digest: string,
		label: string
	): Promise<ObjectVerification> {
		let stream: ReadableStream<Uint8Array> | null;
		try {
			stream = await this.#objects.get(key);
		} catch {
			return { outcome: 'retryable_error', errorCode: `completion_${label}_storage_unavailable` };
		}
		if (stream === null) {
			return { outcome: 'retryable_error', errorCode: `completion_${label}_object_missing` };
		}
		let bytes: Uint8Array<ArrayBuffer>;
		try {
			bytes = await readExactObjectStream(stream, expectedSize);
		} catch (error: unknown) {
			if (error instanceof ExactObjectStreamError) {
				return { outcome: 'integrity_error', errorCode: `completion_${label}_size_mismatch` };
			}
			return { outcome: 'retryable_error', errorCode: `completion_${label}_storage_unavailable` };
		}
		if ((await sha256Hex(bytes)) !== digest) {
			return { outcome: 'integrity_error', errorCode: `completion_${label}_digest_mismatch` };
		}
		return { outcome: 'verified' };
	}
}
