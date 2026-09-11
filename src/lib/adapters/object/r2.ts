import type { ObjectMetadata, ObjectStore, PutObject } from '$lib/ports/object-store';
import { assertObjectKey } from '$lib/ports/object-store';

export class R2ObjectStore implements ObjectStore {
	constructor(private readonly bucket: R2Bucket) {}

	async head(key: string): Promise<ObjectMetadata | null> {
		assertObjectKey(key);
		const object = await this.bucket.head(key);
		return object ? this.metadata(object) : null;
	}

	async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
		assertObjectKey(key);
		const object = await this.bucket.get(key);
		return object?.body ?? null;
	}

	async putImmutable(key: string, object: PutObject): Promise<ObjectMetadata> {
		assertObjectKey(key);
		const stored = await this.bucket.put(key, object.body, {
			onlyIf: { etagDoesNotMatch: '*' },
			httpMetadata: { contentType: object.contentType },
			customMetadata: { ...object.metadata, sha256: object.sha256 }
		});
		if (stored === null) throw new Error(`Object already exists: ${key}`);
		return this.metadata(stored);
	}

	async delete(key: string): Promise<void> {
		assertObjectKey(key);
		await this.bucket.delete(key);
	}

	private metadata(object: R2Object): ObjectMetadata {
		return {
			key: object.key,
			contentType: object.httpMetadata?.contentType ?? null,
			size: object.size,
			sha256: object.customMetadata?.sha256 ?? null,
			version: object.version
		};
	}
}
