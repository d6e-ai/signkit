import type {
	ListObjectsOptions,
	ListObjectsResult,
	ObjectMetadata,
	ObjectStore,
	PutObject
} from '$lib/ports/object-store';
import { assertObjectKey, MAX_LIST_OBJECTS_LIMIT } from '$lib/ports/object-store';

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

	async list(options?: ListObjectsOptions): Promise<ListObjectsResult> {
		const limit = Math.min(options?.limit ?? 1000, MAX_LIST_OBJECTS_LIMIT);
		const listed = await this.bucket.list({
			prefix: options?.prefix,
			cursor: options?.cursor,
			startAfter: options?.cursor ? undefined : options?.startAfter,
			limit
		});
		return {
			objects: listed.objects.map((obj) => ({
				key: obj.key,
				size: obj.size,
				uploadedAt: obj.uploaded.toISOString()
			})),
			truncated: listed.truncated,
			...(listed.truncated ? { cursor: listed.cursor } : {})
		};
	}

	async deleteMany(keys: readonly string[]): Promise<void> {
		if (keys.length === 0) return;
		for (const key of keys) assertObjectKey(key);
		await this.bucket.delete([...keys]);
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
