import { sentPdfObjectKey } from '$lib/application/documents/sent-document-pdf';
import type { EnvelopeSentPdfStore, SentPdfPointer } from '$lib/ports/envelope-sent-pdf-store';
import type { ObjectStore } from '$lib/ports/object-store';
import type { RecipientSigningContext } from '$lib/ports/recipient-access-store';
import type { RecipientAccessApplicationPort } from './recipient-access';

/**
 * Reads the sent agreement PDF for whoever holds the active recipient
 * session, and refuses to disclose anything else.
 *
 * Two properties matter more than throughput here. First, the capability and
 * the pinned commit are revalidated *after* the object read as well as before
 * it, because object storage is slow enough for a revocation to land in
 * between -- a recipient whose access ended mid-read gets nothing. Second,
 * every failure that is not "your access is not active" collapses to one
 * opaque outcome: a caller must not be able to tell a missing object from a
 * corrupted one from an envelope that was re-pinned.
 */

export type RecipientSentPdfResult =
	| { outcome: 'ok'; bytes: Uint8Array; sha256: string; byteSize: number }
	/** No active recipient access. The caller is told nothing beyond "not found". */
	| { outcome: 'not_found' }
	/** Pointer missing, object missing, or integrity check failed. */
	| { outcome: 'unavailable' };

export interface RecipientSentPdfApplicationPort {
	read(token: string): Promise<RecipientSentPdfResult>;
}

export class RecipientSentPdfService implements RecipientSentPdfApplicationPort {
	constructor(
		private readonly access: RecipientAccessApplicationPort,
		private readonly sentPdf: EnvelopeSentPdfStore,
		private readonly objects: ObjectStore,
		private readonly now: () => Date = (): Date => new Date()
	) {}

	async read(token: string): Promise<RecipientSentPdfResult> {
		const before: RecipientSigningContext | null = await this.access.resolve(
			token,
			this.now().toISOString()
		);
		if (before === null) return { outcome: 'not_found' };

		const pointer: SentPdfPointer | null = await this.#pointer(before);
		if (pointer === null) return { outcome: 'unavailable' };

		const stream: ReadableStream<Uint8Array> | null = await this.objects.get(pointer.objectKey);
		if (stream === null) return { outcome: 'unavailable' };
		let bytes: Uint8Array;
		try {
			bytes = await readStreamBounded(stream, pointer.byteSize);
		} catch {
			return { outcome: 'unavailable' };
		}
		if (bytes.byteLength !== pointer.byteSize) return { outcome: 'unavailable' };
		if ((await sha256Hex(bytes)) !== pointer.sha256) return { outcome: 'unavailable' };

		const after: RecipientSigningContext | null = await this.access.resolve(
			token,
			this.now().toISOString()
		);
		if (after === null) return { outcome: 'not_found' };
		if (
			after.organizationId !== before.organizationId ||
			after.envelopeId !== before.envelopeId ||
			after.recipientId !== before.recipientId ||
			after.sentRevision.commitSha !== before.sentRevision.commitSha
		) {
			return { outcome: 'unavailable' };
		}
		const afterPointer: SentPdfPointer | null = await this.#pointer(after);
		if (
			afterPointer === null ||
			afterPointer.objectKey !== pointer.objectKey ||
			afterPointer.sha256 !== pointer.sha256 ||
			afterPointer.byteSize !== pointer.byteSize
		) {
			return { outcome: 'unavailable' };
		}

		return { outcome: 'ok', bytes, sha256: pointer.sha256, byteSize: pointer.byteSize };
	}

	async #pointer(context: RecipientSigningContext): Promise<SentPdfPointer | null> {
		const pointer: SentPdfPointer | null = await this.sentPdf.findSentPdf(
			context.organizationId,
			context.envelopeId,
			context.sentRevision.commitSha
		);
		if (pointer === null) return null;
		// The key is content-addressed and tenant-scoped by construction, so
		// recomputing it is a cheap proof that the stored pointer was never
		// rewritten to reach into another organization or envelope.
		let expectedKey: string;
		try {
			expectedKey = sentPdfObjectKey(context.organizationId, context.envelopeId, pointer.sha256);
		} catch {
			return null;
		}
		if (pointer.objectKey !== expectedKey) return null;
		if (!Number.isSafeInteger(pointer.byteSize) || pointer.byteSize <= 0) return null;
		return pointer;
	}
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
				throw new Error('sent agreement PDF exceeds its pinned size');
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest: ArrayBuffer = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
	return Array.from(new Uint8Array(digest), (byte: number): string =>
		byte.toString(16).padStart(2, '0')
	).join('');
}
