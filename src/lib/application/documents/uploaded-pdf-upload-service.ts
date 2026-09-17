import {
	DraftDocumentSetError,
	DraftEnvelopeImmutableError,
	DraftEnvelopeNotFoundError,
	DraftGenerationConflictError,
	DraftIdempotencyConflictError,
	type CommitDraftResult,
	type DraftPersistenceService
} from '$lib/application/drafts/draft-persistence';
import {
	MAX_UPLOADED_PDF_BYTES,
	UPLOADED_PDF_CONTENT_TYPE,
	uploadedPdfObjectKey
} from '$lib/application/documents/uploaded-pdf';
import {
	PdfPageMetadataError,
	parsePdfPageMetadata,
	type PdfPageMetadata
} from '$lib/adapters/pdf/pdf-page-metadata';
import { sha256Hex } from '$lib/application/documents/sent-document-pdf';
import type { DraftActor } from '$lib/ports/draft-repository';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import type {
	EnvelopeUploadedDocumentStore,
	InsertUploadedDocumentResult
} from '$lib/ports/envelope-uploaded-document-store';

export type UploadedPdfUploadErrorCode =
	'invalid_pdf' | 'too_large' | 'cap_exceeded' | 'integrity_error';

export class UploadedPdfUploadError extends Error {
	readonly code = 'UPLOADED_PDF_UPLOAD_ERROR';

	constructor(
		readonly reason: UploadedPdfUploadErrorCode,
		message: string,
		readonly pdfReason?: string
	) {
		super(message);
		this.name = 'UploadedPdfUploadError';
	}
}

export interface UploadPdfInput {
	envelopeId: string;
	expectedGeneration: number;
	actor: DraftActor;
	idempotencyKey: string;
	bytes: Uint8Array;
	filename?: string;
	title?: string;
	position?: number;
	updatedAt?: string;
}

export class UploadedPdfUploadService {
	constructor(
		private readonly drafts: Pick<DraftPersistenceService, 'commit'>,
		private readonly objects: ObjectStore,
		private readonly uploadedDocuments: EnvelopeUploadedDocumentStore
	) {}

	async upload(input: UploadPdfInput): Promise<CommitDraftResult> {
		if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_UPLOADED_PDF_BYTES) {
			throw new UploadedPdfUploadError(
				'too_large',
				`The uploaded PDF must not exceed ${MAX_UPLOADED_PDF_BYTES} bytes`
			);
		}

		let metadata: PdfPageMetadata;
		try {
			metadata = parsePdfPageMetadata(input.bytes);
		} catch (error: unknown) {
			if (error instanceof PdfPageMetadataError) {
				throw new UploadedPdfUploadError('invalid_pdf', error.message, error.reason);
			}
			throw error;
		}

		const sha256: string = await sha256Hex(input.bytes);
		const objectKey: string = uploadedPdfObjectKey(input.envelopeId, sha256);
		await this.persistImmutablePdf(objectKey, input.bytes, sha256);

		const createdAt: string = input.updatedAt ?? new Date().toISOString();
		const insert: InsertUploadedDocumentResult = await this.uploadedDocuments.insert({
			envelopeId: input.envelopeId,
			sha256,
			objectKey,
			byteSize: input.bytes.byteLength,
			pageCount: metadata.pageCount,
			pageWidth: metadata.pageWidth,
			pageHeight: metadata.pageHeight,
			createdAt
		});
		if (insert === 'cap_exceeded') {
			throw new UploadedPdfUploadError(
				'cap_exceeded',
				'This envelope has reached the uploaded PDF digest cap'
			);
		}
		if (insert === 'not_found') {
			throw new DraftEnvelopeNotFoundError();
		}

		const title: string = titleFromUpload(input.title, input.filename);
		return this.drafts.commit({
			envelopeId: input.envelopeId,
			expectedGeneration: input.expectedGeneration,
			edits: [],
			message: `Upload PDF ${title}`,
			actor: input.actor,
			idempotencyKey: input.idempotencyKey,
			documentSet: {
				op: 'appendPdf',
				title,
				sha256,
				byteSize: input.bytes.byteLength,
				pageCount: metadata.pageCount,
				pageWidth: metadata.pageWidth,
				pageHeight: metadata.pageHeight,
				position: input.position
			},
			updatedAt: input.updatedAt
		});
	}

	private async persistImmutablePdf(key: string, bytes: Uint8Array, sha256: string): Promise<void> {
		try {
			const stored: ObjectMetadata = await this.objects.putImmutable(key, {
				contentType: UPLOADED_PDF_CONTENT_TYPE,
				body: bytes,
				sha256,
				metadata: { format: 'signkit-uploaded-pdf-v1' }
			});
			if (stored.key !== key || stored.sha256 !== sha256 || stored.size !== bytes.byteLength) {
				throw new UploadedPdfUploadError(
					'integrity_error',
					'Object store did not confirm the uploaded PDF'
				);
			}
		} catch (error: unknown) {
			if (error instanceof UploadedPdfUploadError) throw error;
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

export {
	DraftDocumentSetError,
	DraftEnvelopeImmutableError,
	DraftEnvelopeNotFoundError,
	DraftGenerationConflictError,
	DraftIdempotencyConflictError
};

function titleFromUpload(title: string | undefined, filename: string | undefined): string {
	const source: string = (title ?? filename ?? 'document').trim().replace(/\.pdf$/i, '');
	if (source.length === 0) return 'document';
	return source.slice(0, 200);
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
				await reader.cancel('uploaded PDF exceeds its pinned size');
				throw new UploadedPdfUploadError('integrity_error', 'Uploaded PDF exceeds its pinned size');
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
