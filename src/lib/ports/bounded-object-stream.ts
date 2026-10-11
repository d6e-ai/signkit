/**
 * Accumulates a `ReadableStream<Uint8Array>` into one owned buffer, failing
 * closed the moment the running total exceeds `maximumBytes`.
 *
 * The caller does not need to know the exact size upfront: this enforces
 * only a ceiling, so a shorter-than-ceiling stream is returned as-is for the
 * caller to apply its own exact size/hash check. `onOverflow` builds the
 * caller's own error so each call site keeps its existing error type and
 * message.
 */
export async function readBoundedObjectStream(
	stream: ReadableStream<Uint8Array>,
	maximumBytes: number,
	onOverflow: () => Error
): Promise<Uint8Array> {
	const reader: ReadableStreamDefaultReader<Uint8Array> = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size: number = 0;
	try {
		for (;;) {
			const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
			if (result.done) break;
			size += result.value.byteLength;
			if (size > maximumBytes) {
				try {
					await reader.cancel('Object stream exceeded its maximum byte limit');
				} catch {
					// The size failure remains authoritative when provider cancellation fails.
				}
				throw onOverflow();
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
