export type ExactObjectStreamFailureReason =
	'invalid_expected_size' | 'stream_too_long' | 'stream_too_short';

export class ExactObjectStreamError extends Error {
	constructor(readonly reason: ExactObjectStreamFailureReason) {
		super(reason);
		this.name = 'ExactObjectStreamError';
	}
}

/**
 * Reads an already size-attested object into one owned ArrayBuffer.
 *
 * Callers must obtain `expectedSize` from object metadata and impose their
 * own format-specific ceiling before calling this helper. Unlike a chunk
 * accumulator, this never retains both every source chunk and a second
 * concatenated artifact-sized buffer.
 */
export async function readExactObjectStream(
	stream: ReadableStream<Uint8Array>,
	expectedSize: number
): Promise<Uint8Array<ArrayBuffer>> {
	if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
		throw new ExactObjectStreamError('invalid_expected_size');
	}

	const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(expectedSize));
	const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
	let offset: number = 0;
	try {
		while (true) {
			const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (result.done) break;
			if (result.value.byteLength > expectedSize - offset) {
				try {
					await reader.cancel('Object stream exceeds its attested size');
				} catch {
					// The size failure remains authoritative when provider cancellation fails.
				}
				throw new ExactObjectStreamError('stream_too_long');
			}
			bytes.set(result.value, offset);
			offset += result.value.byteLength;
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Ignore lock release failure.
		}
	}
	if (offset !== expectedSize) {
		throw new ExactObjectStreamError('stream_too_short');
	}
	return bytes;
}

export type ImmutableObjectVerification = 'missing' | 'verified' | 'mismatched';

/**
 * Reconciles an uncertain immutable write against the exact bytes the caller
 * attempted to store. The producer-supplied expected size is the bound: a PDF
 * replay is not accidentally constrained by the much smaller manifest limit.
 */
export async function verifyImmutableObject(
	objects: ObjectStore,
	key: string,
	expectedSha256: string,
	expectedSize: number
): Promise<ImmutableObjectVerification> {
	const metadata: ObjectMetadata | null = await objects.head(key);
	if (metadata === null) return 'missing';
	if (
		metadata.key !== key ||
		metadata.size !== expectedSize ||
		metadata.sha256 !== expectedSha256 ||
		!Number.isSafeInteger(expectedSize) ||
		expectedSize < 0
	) {
		return 'mismatched';
	}
	const stream: ReadableStream<Uint8Array> | null = await objects.get(key);
	if (stream === null) return 'missing';
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = await readExactObjectStream(stream, expectedSize);
	} catch (error: unknown) {
		if (error instanceof ExactObjectStreamError) return 'mismatched';
		throw error;
	}
	return (await sha256Hex(bytes)) === expectedSha256 ? 'verified' : 'mismatched';
}
import type { ObjectMetadata, ObjectStore } from '$lib/ports/object-store';
import { sha256Hex } from './completion-manifest';
