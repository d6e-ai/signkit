import type { CompletionArtifactStore } from '$lib/ports/completion-artifact-store';
import type { CompletionArtifactPdfStore } from '$lib/ports/completion-artifact-pdf-store';
import type { ObjectStore } from '$lib/ports/object-store';
import { completionArtifactObjectKey } from './completion-artifact-service';
import { MAX_MANIFEST_GZIP_BYTES, MAX_MANIFEST_SOURCE_BYTES } from './completion-manifest';

export interface CompletionEvidenceResult {
	content: string;
	contentType: string;
	digest: string;
}

export interface CompletionPdfResult {
	stream: ReadableStream<Uint8Array>;
	sha256: string;
}

export interface CompletionEvidenceApplicationPort {
	readEvidence(
		organizationId: string,
		envelopeId: string,
		format?: 'json' | 'markdown'
	): Promise<CompletionEvidenceResult | null>;
	readPdf(organizationId: string, envelopeId: string): Promise<CompletionPdfResult | null>;
	envelopeExists(organizationId: string, envelopeId: string): Promise<boolean>;
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
		organizationId: string,
		envelopeId: string,
		format: 'json' | 'markdown' = 'json'
	): Promise<CompletionEvidenceResult | null> {
		const status = await this.#store.findCompletionArtifactStatus(organizationId, envelopeId);
		if (status === null || status.published === null) {
			return null;
		}

		const isMarkdown = format === 'markdown';
		const digest = isMarkdown ? status.published.markdownSha256 : status.published.jsonSha256;
		const key = completionArtifactObjectKey(
			organizationId,
			envelopeId,
			isMarkdown ? 'markdown' : 'json',
			digest
		);

		const stream = await this.#objects.get(key);
		if (stream === null) {
			throw new CompletionEvidenceReadError('artifact_object_missing');
		}

		const gzipped = await readStreamBounded(stream, MAX_MANIFEST_GZIP_BYTES);
		const unzipped = await gunzip(gzipped, MAX_MANIFEST_SOURCE_BYTES);
		const content = new TextDecoder('utf-8', { fatal: true }).decode(unzipped);

		return {
			content,
			contentType: isMarkdown ? 'text/markdown; charset=utf-8' : 'application/json',
			digest
		};
	}

	async readPdf(organizationId: string, envelopeId: string): Promise<CompletionPdfResult | null> {
		const pdfRecord = await this.#pdfStore.readCompletionArtifactPdf(organizationId, envelopeId);
		if (pdfRecord === null) {
			return null;
		}

		const stream = await this.#objects.get(pdfRecord.pdfObjectKey);
		if (stream === null) {
			throw new CompletionEvidenceReadError('pdf_object_missing');
		}

		return {
			stream,
			sha256: pdfRecord.pdfSha256
		};
	}

	async envelopeExists(organizationId: string, envelopeId: string): Promise<boolean> {
		const status = await this.#store.findCompletionArtifactStatus(organizationId, envelopeId);
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
