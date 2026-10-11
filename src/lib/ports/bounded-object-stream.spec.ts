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
	const first = new Uint8Array([90, 10, 20, 91]).subarray(1, 3);
	const second = new Uint8Array([30, 40, 50]);
	const combined = await readBoundedObjectStream(
		streamOfChunks([first, second]),
		50,
		() => new Error(),
		'fixture overflow'
	);
	expect(Array.from(combined)).toEqual([10, 20, 30, 40, 50]);
});

it('returns bytes unmodified when exactly at the ceiling', async () => {
	const chunk = new Uint8Array([1, 2, 3, 4]);
	const result = await readBoundedObjectStream(
		streamOfChunks([chunk]),
		4,
		() => new Error(),
		'fixture overflow'
	);
	expect(Array.from(result)).toEqual([1, 2, 3, 4]);
});

it('throws the caller-provided error when the stream exceeds the ceiling', async () => {
	const oversized = new Uint8Array([1, 2, 3, 4, 5]);
	class OverflowMarker extends Error {}
	await expect(
		readBoundedObjectStream(
			streamOfChunks([oversized]),
			4,
			() => new OverflowMarker(),
			'fixture overflow'
		)
	).rejects.toBeInstanceOf(OverflowMarker);
});

it('preserves the cancellation reason and releases the reader after overflow', async () => {
	let cancellationReason: unknown;
	const stream = new ReadableStream<Uint8Array>({
		start(controller): void {
			controller.enqueue(new Uint8Array([1, 2]));
		},
		cancel(reason): void {
			cancellationReason = reason;
		}
	});
	const overflow = new Error('caller overflow');
	await expect(
		readBoundedObjectStream(stream, 1, () => overflow, 'caller cancellation')
	).rejects.toBe(overflow);
	expect(cancellationReason).toBe('caller cancellation');
	expect(stream.locked).toBe(false);
});

it('propagates a provider cancellation failure before constructing the overflow error', async () => {
	const providerFailure = new Error('provider cancellation failed');
	let errorConstructed = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller): void {
			controller.enqueue(new Uint8Array([1, 2]));
		},
		cancel(): never {
			throw providerFailure;
		}
	});
	await expect(
		readBoundedObjectStream(
			stream,
			1,
			() => {
				errorConstructed = true;
				return new Error('caller overflow');
			},
			'caller cancellation'
		)
	).rejects.toBe(providerFailure);
	expect(errorConstructed).toBe(false);
	expect(stream.locked).toBe(false);
});

it('preserves a provider read failure and releases its reader', async () => {
	const providerFailure = new Error('provider read failed');
	const stream = new ReadableStream<Uint8Array>({
		start(controller): void {
			controller.error(providerFailure);
		}
	});
	await expect(
		readBoundedObjectStream(stream, 10, () => new Error(), 'caller cancellation')
	).rejects.toBe(providerFailure);
	expect(stream.locked).toBe(false);
});

it('returns an empty owned buffer from an empty stream', async () => {
	const result = await readBoundedObjectStream(streamOfChunks([]), 0, () => new Error(), 'empty');
	expect(result.byteLength).toBe(0);
});

it('copies offset views that land exactly on the ceiling', async () => {
	const chunk = new Uint8Array([90, 1, 2, 3, 91]).subarray(1, 4);
	const result = await readBoundedObjectStream(
		streamOfChunks([chunk]),
		3,
		() => new Error(),
		'offset'
	);
	expect(Array.from(result)).toEqual([1, 2, 3]);
});

it('rejects overflow on a later chunk without returning a partial buffer', async () => {
	const overflow = new Error('later overflow');
	await expect(
		readBoundedObjectStream(
			streamOfChunks([new Uint8Array([1]), new Uint8Array([2, 3])]),
			2,
			() => overflow,
			'later overflow'
		)
	).rejects.toBe(overflow);
});
