import type { CompletionArtifactStore } from '$lib/ports/completion-artifact-store';
import type { CompletionArtifactPdfStore } from '$lib/ports/completion-artifact-pdf-store';
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import { completionArtifactObjectKey } from './completion-artifact-service';
import {
	MAX_MANIFEST_GZIP_BYTES,
	MAX_MANIFEST_SOURCE_BYTES,
	sha256Hex
} from './completion-manifest';
import { MAX_PUBLISHED_COMPLETION_PDF_BYTES } from './completion-pdf-limits';
import { ExactObjectStreamError, readExactObjectStream } from './exact-object-stream';

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;

export interface CompletionEvidenceResult {
	content: string;
	contentType: string;
	digest: string;
}

export interface CompletionPdfResult {
	bytes: Uint8Array<ArrayBuffer>;
	sha256: string;
}

export interface CompletionEvidenceApplicationPort {
	readEvidence(
		envelopeId: string,
		format?: 'json' | 'markdown'
	): Promise<CompletionEvidenceResult | null>;
	readPdf(envelopeId: string): Promise<CompletionPdfResult | null>;
	envelopeExists(envelopeId: string): Promise<boolean>;
}

export class CompletionEvidenceReadError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = 'CompletionEvidenceReadError';
		this.code = code;
	}
}

export function completionEvidenceFailureLog(error: unknown): {
	errorName: string;
	code?: string;
} {
	const errorName: string = error instanceof Error ? error.name : 'UnknownError';
	if (error instanceof CompletionEvidenceReadError) {
		return { errorName, code: error.code };
	}
	return { errorName };
}

export class CompletionEvidenceService implements CompletionEvidenceApplicationPort {
	readonly #store: CompletionArtifactStore;
	readonly #objects: ObjectStore;
	readonly #pdfStore: CompletionArtifactPdfStore;

	constructor(
		store: CompletionArtifactStore,
		objects: ObjectStore,
		pdfStore: CompletionArtifactPdfStore
	) {
		this.#store = store;
		this.#objects = objects;
		this.#pdfStore = pdfStore;
	}

	async readEvidence(
		envelopeId: string,
		format: 'json' | 'markdown' = 'json'
	): Promise<CompletionEvidenceResult | null> {
		const status = await this.#store.findCompletionArtifactStatus(envelopeId);
		if (status === null || status.published === null) {
			return null;
		}

		const isMarkdown = format === 'markdown';
		const digest = isMarkdown ? status.published.markdownSha256 : status.published.jsonSha256;
		if (!SHA256_PATTERN.test(digest)) {
			throw new CompletionEvidenceReadError('artifact_digest_invalid');
		}
		const key = completionArtifactObjectKey(envelopeId, isMarkdown ? 'markdown' : 'json', digest);

		const stream = await this.#objects.get(key);
		if (stream === null) {
			throw new CompletionEvidenceReadError('artifact_object_missing');
		}

		const gzipped = await readStreamBounded(stream, MAX_MANIFEST_GZIP_BYTES);
		if ((await sha256Hex(gzipped)) !== digest) {
			throw new CompletionEvidenceReadError('artifact_integrity_mismatch');
		}
		const unzipped = await gunzip(gzipped, MAX_MANIFEST_SOURCE_BYTES);
		let content: string;
		try {
			content = new TextDecoder('utf-8', { fatal: true }).decode(unzipped);
		} catch {
			throw new CompletionEvidenceReadError('artifact_decode_failed');
		}

		return {
			content,
			contentType: isMarkdown ? 'text/markdown; charset=utf-8' : 'application/json',
			digest
		};
	}

	async readPdf(envelopeId: string): Promise<CompletionPdfResult | null> {
		const pdfRecord = await this.#pdfStore.readCompletionArtifactPdf(envelopeId);
		if (pdfRecord === null) {
			return null;
		}
		if (!SHA256_PATTERN.test(pdfRecord.pdfSha256)) {
			throw new CompletionEvidenceReadError('pdf_digest_invalid');
		}
		const expectedKey = completionArtifactObjectKey(envelopeId, 'pdf', pdfRecord.pdfSha256);
		if (pdfRecord.pdfObjectKey !== expectedKey) {
			throw new CompletionEvidenceReadError('pdf_key_mismatch');
		}

		const metadata: ObjectMetadata | null = await this.#objects.head(expectedKey);
		if (metadata === null) {
			throw new CompletionEvidenceReadError('pdf_object_missing');
		}
		if (
			metadata.key !== expectedKey ||
			metadata.sha256 !== pdfRecord.pdfSha256 ||
			!Number.isSafeInteger(metadata.size) ||
			metadata.size <= 0
		) {
			throw new CompletionEvidenceReadError('pdf_integrity_mismatch');
		}
		if (metadata.size > MAX_PUBLISHED_COMPLETION_PDF_BYTES) {
			throw new CompletionEvidenceReadError('stream_too_large');
		}

		const stream: ReadableStream<Uint8Array> | null = await this.#objects.get(expectedKey);
		if (stream === null) {
			throw new CompletionEvidenceReadError('pdf_object_missing');
		}

		let bytes: Uint8Array<ArrayBuffer>;
		try {
			bytes = await readExactObjectStream(stream, metadata.size);
		} catch (error: unknown) {
			if (error instanceof ExactObjectStreamError) {
				throw new CompletionEvidenceReadError('pdf_integrity_mismatch');
			}
			throw error;
		}
		if ((await sha256Hex(bytes)) !== pdfRecord.pdfSha256) {
			throw new CompletionEvidenceReadError('pdf_integrity_mismatch');
		}

		return {
			bytes,
			sha256: pdfRecord.pdfSha256
		};
	}

	async envelopeExists(envelopeId: string): Promise<boolean> {
		const status = await this.#store.findCompletionArtifactStatus(envelopeId);
		return status !== null;
	}
}

async function readStreamBounded(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				totalBytes += value.byteLength;
				if (totalBytes > maxBytes) {
					throw new CompletionEvidenceReadError('stream_too_large');
				}
				chunks.push(value);
			}
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

async function gunzip(gzipped: Uint8Array, maxBytes: number): Promise<Uint8Array> {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(gzipped);
			controller.close();
		}
	}).pipeThrough(new DecompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>);
	return await readStreamBounded(stream, maxBytes);
}
