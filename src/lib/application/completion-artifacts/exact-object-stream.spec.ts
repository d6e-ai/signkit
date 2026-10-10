import { describe, expect, it } from 'vitest';
import { InMemoryObjectStore } from '$lib/ports/object-store-test-support';
import { sha256Hex } from './completion-manifest';
import { verifyImmutableObject } from './exact-object-stream';

describe('verifyImmutableObject', () => {
	it('verifies an immutable PDF replay larger than the manifest gzip ceiling', async () => {
		const bytes = new Uint8Array(2 * 1024 * 1024 + 1);
		bytes.set(new TextEncoder().encode('%PDF-1.7'));
		const sha256 = await sha256Hex(bytes);
		const key = `completion-artifacts/v1/envelopes/envelope/sha256/${sha256}.pdf`;
		const objects = new InMemoryObjectStore();
		objects.seed(key, bytes, sha256);

		await expect(verifyImmutableObject(objects, key, sha256, bytes.byteLength)).resolves.toBe(
			'verified'
		);
	});
});
