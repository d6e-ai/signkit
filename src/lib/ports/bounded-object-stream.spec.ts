import { expect, it } from 'vitest';
import { readBoundedObjectStream } from './bounded-object-stream';

function streamOfChunks(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller): void {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		}
	});
}

it('reassembles chunked input', async () => {
	const first = new Uint8Array([10, 20]);
	const second = new Uint8Array([30, 40, 50]);
	const combined = await readBoundedObjectStream(
		streamOfChunks([first, second]),
		50,
		() => new Error()
	);
	expect(Array.from(combined)).toEqual([10, 20, 30, 40, 50]);
});

it('returns bytes unmodified when exactly at the ceiling', async () => {
	const chunk = new Uint8Array([1, 2, 3, 4]);
	const result = await readBoundedObjectStream(streamOfChunks([chunk]), 4, () => new Error());
	expect(Array.from(result)).toEqual([1, 2, 3, 4]);
});

it('throws the caller-provided error when the stream exceeds the ceiling', async () => {
	const oversized = new Uint8Array([1, 2, 3, 4, 5]);
	class OverflowMarker extends Error {}
	await expect(
		readBoundedObjectStream(streamOfChunks([oversized]), 4, () => new OverflowMarker())
	).rejects.toBeInstanceOf(OverflowMarker);
});
