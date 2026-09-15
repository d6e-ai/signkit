import { completionArtifactObjectKey } from '$lib/application/completion-artifacts/completion-artifact-service';
import {
	COMPLETION_MANIFEST_SCHEMA,
	MAX_MANIFEST_GZIP_BYTES,
	MAX_MANIFEST_SOURCE_BYTES,
	sha256Hex
} from '$lib/application/completion-artifacts/completion-manifest';
import type {
	CompletionArtifactLocator,
	CompletionDeliveryStore
} from '$lib/ports/completion-delivery-store';
import type { ObjectStore } from '$lib/ports/object-store';
import type { CompletionArtifactPdfStore } from '$lib/ports/completion-artifact-pdf-store';
import { MAX_COMPLETION_PDF_BYTES } from '$lib/application/completion-artifacts/completion-pdf';
import { hashCompletionToken, isCompletionToken } from '$lib/security/completion-token';

export type PublicCompletionArtifactFormat = 'json' | 'markdown' | 'pdf';

export interface PublicCompletionArtifact {
	content: string | Uint8Array;
	contentType: string;
}

export class PublicCompletionArtifactNotFoundError extends Error {
	constructor() {
		super('Completion artifact was not found');
		this.name = 'PublicCompletionArtifactNotFoundError';
	}
}

export class PublicCompletionArtifactIntegrityError extends Error {
	constructor() {
		super('Completion artifact failed integrity verification');
		this.name = 'PublicCompletionArtifactIntegrityError';
	}
}

export class PublicCompletionArtifactStorageError extends Error {
	constructor() {
		super('Completion artifact storage is unavailable');
		this.name = 'PublicCompletionArtifactStorageError';
	}
}

const JSON_CONTENT_TYPE: string = 'application/json';
const MARKDOWN_CONTENT_TYPE: string = 'text/markdown; charset=utf-8';
const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;
const GZIP_SLICE_BYTES: number = 16 * 1024;

/**
 * Resolves a public completion-artifact grant from a raw `skca1_` token and
 * returns only decompressed JSON or Markdown. Locator keys, tenant IDs, token
 * material, and digests never appear on the public result or in thrown errors.
 */
export class PublicCompletionArtifactService {
	readonly #store: CompletionDeliveryStore;
	readonly #objects: ObjectStore;
	readonly #pdfStore: CompletionArtifactPdfStore | null;

	constructor(
		store: CompletionDeliveryStore,
		objects: ObjectStore,
		pdfStore: CompletionArtifactPdfStore | null = null
	) {
		this.#store = store;
		this.#objects = objects;
		this.#pdfStore = pdfStore;
	}

	async read(
		rawToken: string,
		format: PublicCompletionArtifactFormat,
		now: Date = new Date()
	): Promise<PublicCompletionArtifact> {
		if (!isCompletionToken(rawToken)) {
			throw new PublicCompletionArtifactNotFoundError();
		}
		const tokenHash: string = await hashCompletionToken(rawToken);
		const locator: CompletionArtifactLocator | null = await this.#resolveLocator(tokenHash, now);
		if (locator === null) {
			throw new PublicCompletionArtifactNotFoundError();
		}

		if (format === 'pdf') {
			if (this.#pdfStore === null) {
				throw new PublicCompletionArtifactNotFoundError();
			}
			const pdfRecord = await this.#pdfStore.readCompletionArtifactPdf(
				locator.organizationId,
				locator.envelopeId
			);
			if (pdfRecord === null) {
				throw new PublicCompletionArtifactNotFoundError();
			}
			if (!SHA256_PATTERN.test(pdfRecord.pdfSha256)) {
				throw new PublicCompletionArtifactIntegrityError();
			}
			const expectedPdfKey: string = completionArtifactObjectKey(
				locator.organizationId,
				locator.envelopeId,
				'pdf',
				pdfRecord.pdfSha256
			);
			if (pdfRecord.pdfObjectKey !== expectedPdfKey) {
				throw new PublicCompletionArtifactIntegrityError();
			}
			let stream: ReadableStream<Uint8Array> | null;
			try {
				stream = await this.#objects.get(expectedPdfKey);
			} catch (error: unknown) {
				throwIfPublicCompletionError(error);
				throw new PublicCompletionArtifactStorageError();
			}
			if (stream === null) {
				throw new PublicCompletionArtifactIntegrityError();
			}
			let pdfBytes: Uint8Array;
			try {
				pdfBytes = await readStreamBounded(stream, MAX_COMPLETION_PDF_BYTES);
			} catch (error: unknown) {
				throwIfPublicCompletionError(error);
				throw new PublicCompletionArtifactStorageError();
			}
			if ((await sha256Hex(pdfBytes)) !== pdfRecord.pdfSha256) {
				throw new PublicCompletionArtifactIntegrityError();
			}
			return { content: pdfBytes, contentType: 'application/pdf' };
		}

		const digest: string = format === 'json' ? locator.jsonSha256 : locator.markdownSha256;
		const storedKey: string = format === 'json' ? locator.jsonObjectKey : locator.markdownObjectKey;
		if (!SHA256_PATTERN.test(digest)) {
			throw new PublicCompletionArtifactIntegrityError();
		}
		const expectedKey: string = completionArtifactObjectKey(
			locator.organizationId,
			locator.envelopeId,
			format,
			digest
		);
		if (storedKey !== expectedKey) {
			throw new PublicCompletionArtifactIntegrityError();
		}

		const gzipped: Uint8Array = await this.#readGzipObject(expectedKey);
		if ((await sha256Hex(gzipped)) !== digest) {
			throw new PublicCompletionArtifactIntegrityError();
		}

		const sourceBytes: Uint8Array = await gunzipBounded(gzipped, MAX_MANIFEST_SOURCE_BYTES);
		const content: string = decodeUtf8(sourceBytes);
		if (format === 'json') {
			assertManifestJson(content);
			return { content, contentType: JSON_CONTENT_TYPE };
		}
		return { content, contentType: MARKDOWN_CONTENT_TYPE };
	}

	async #resolveLocator(tokenHash: string, now: Date): Promise<CompletionArtifactLocator | null> {
		try {
			return await this.#store.resolveArtifactLocatorByTokenHash(tokenHash, now.toISOString());
		} catch (error: unknown) {
			throwIfPublicCompletionError(error);
			throw new PublicCompletionArtifactStorageError();
		}
	}

	async #readGzipObject(key: string): Promise<Uint8Array> {
		let stream: ReadableStream<Uint8Array> | null;
		try {
			stream = await this.#objects.get(key);
		} catch (error: unknown) {
			throwIfPublicCompletionError(error);
			throw new PublicCompletionArtifactStorageError();
		}
		if (stream === null) {
			throw new PublicCompletionArtifactIntegrityError();
		}
		try {
			return await readStreamBounded(stream, MAX_MANIFEST_GZIP_BYTES);
		} catch (error: unknown) {
			throwIfPublicCompletionError(error);
			throw new PublicCompletionArtifactStorageError();
		}
	}
}

function throwIfPublicCompletionError(error: unknown): void {
	if (
		error instanceof PublicCompletionArtifactNotFoundError ||
		error instanceof PublicCompletionArtifactIntegrityError ||
		error instanceof PublicCompletionArtifactStorageError
	) {
		throw error;
	}
}

function assertManifestJson(content: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content) as unknown;
	} catch {
		throw new PublicCompletionArtifactIntegrityError();
	}
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		Array.isArray(parsed) ||
		!('schema' in parsed) ||
		parsed.schema !== COMPLETION_MANIFEST_SCHEMA
	) {
		throw new PublicCompletionArtifactIntegrityError();
	}
}

function decodeUtf8(bytes: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new PublicCompletionArtifactIntegrityError();
	}
}

async function gunzipBounded(gzipped: Uint8Array, maximumBytes: number): Promise<Uint8Array> {
	let decompressed: ReadableStream<Uint8Array>;
	try {
		decompressed = readableByteSlices(gzipped).pipeThrough(
			new DecompressionStream('gzip') as TransformStream<Uint8Array, Uint8Array>
		);
	} catch {
		throw new PublicCompletionArtifactIntegrityError();
	}
	try {
		return await readStreamBounded(decompressed, maximumBytes);
	} catch (error: unknown) {
		throwIfPublicCompletionError(error);
		throw new PublicCompletionArtifactIntegrityError();
	}
}

function readableByteSlices(bytes: Uint8Array): ReadableStream<Uint8Array> {
	let offset: number = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller): void {
			if (offset >= bytes.byteLength) {
				controller.close();
				return;
			}
			const end: number = Math.min(offset + GZIP_SLICE_BYTES, bytes.byteLength);
			controller.enqueue(bytes.subarray(offset, end));
			offset = end;
		}
	});
}

async function readStreamBounded(
	stream: ReadableStream<Uint8Array>,
	maximumBytes: number
): Promise<Uint8Array> {
	const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size: number = 0;
	try {
		while (true) {
			const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > maximumBytes) {
				try {
					await reader.cancel();
				} catch {
					// Ignore cancellation failure.
				}
				throw new PublicCompletionArtifactIntegrityError();
			}
			chunks.push(result.value);
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Ignore lock release failure.
		}
	}
	const bytes: Uint8Array = new Uint8Array(size);
	let offset: number = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
