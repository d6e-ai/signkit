import {
	MAX_LIST_OBJECTS_LIMIT,
	type ListObjectsOptions,
	type ListObjectsResult,
	type ObjectMetadata,
	type ObjectStore,
	type PutObject
} from './object-store';

interface StoredObject {
	body: Uint8Array;
	contentType: string;
	sha256: string;
}

function increment(counts: Map<string, number>, key: string): void {
	counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sum(counts: Map<string, number>): number {
	let total = 0;
	for (const count of counts.values()) total += count;
	return total;
}

function toMetadata(key: string, object: StoredObject): ObjectMetadata {
	return {
		key,
		contentType: object.contentType,
		size: object.body.byteLength,
		sha256: object.sha256,
		version: null
	};
}

/**
 * Faithful in-memory `ObjectStore` double for authoring/evidence specs.
 *
 * Behaves like a real content-addressed store (`putImmutable` rejects an
 * existing key, `get`/`head` reflect what was actually written or seeded) and
 * tracks per-key call counts so specs can assert retry/replay behavior
 * without hand-rolling their own fake. `throwAfterNextPut` simulates a write
 * that lands but whose confirmation is lost, for specs covering uncertain-
 * write recovery.
 *
 * Specs asserting a specific failure mode (a store that is down, that only
 * serves one seeded key, or that lies about a written digest) should keep
 * writing that bespoke `ObjectStore` literal rather than routing it through
 * this double — hiding it here would obscure what the test is proving.
 */
export class InMemoryObjectStore implements ObjectStore {
	private readonly objects = new Map<string, StoredObject>();
	readonly getCallsByKey = new Map<string, number>();
	readonly putCallsByKey = new Map<string, number>();
	deleteCalls = 0;

	/** When true, the next `putImmutable` that would otherwise succeed stores the object and then throws. */
	throwAfterNextPut = false;

	get size(): number {
		return this.objects.size;
	}

	get getCalls(): number {
		return sum(this.getCallsByKey);
	}

	get putCalls(): number {
		return sum(this.putCallsByKey);
	}

	keys(): readonly string[] {
		return [...this.objects.keys()];
	}

	seed(key: string, body: Uint8Array, sha256: string = ''): void {
		this.objects.set(key, { body: Uint8Array.from(body), contentType: 'test', sha256 });
	}

	async head(key: string): Promise<ObjectMetadata | null> {
		const object = this.objects.get(key);
		return object ? toMetadata(key, object) : null;
	}

	async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
		increment(this.getCallsByKey, key);
		const object = this.objects.get(key);
		if (!object) return null;
		const body = Uint8Array.from(object.body);
		return new ReadableStream<Uint8Array>({
			start(controller): void {
				controller.enqueue(body);
				controller.close();
			}
		});
	}

	async putImmutable(key: string, object: PutObject): Promise<ObjectMetadata> {
		increment(this.putCallsByKey, key);
		if (this.objects.has(key)) throw new Error('Object already exists');
		if (!(object.body instanceof Uint8Array)) {
			throw new Error('InMemoryObjectStore requires a buffered Uint8Array body');
		}
		const stored: StoredObject = {
			body: Uint8Array.from(object.body),
			contentType: object.contentType,
			sha256: object.sha256
		};
		this.objects.set(key, stored);
		if (this.throwAfterNextPut) {
			this.throwAfterNextPut = false;
			throw new Error('Response was lost after put');
		}
		return toMetadata(key, stored);
	}

	async delete(key: string): Promise<void> {
		this.deleteCalls += 1;
		this.objects.delete(key);
	}

	async deleteMany(keys: readonly string[]): Promise<void> {
		for (const key of keys) await this.delete(key);
	}

	async list(options: ListObjectsOptions = {}): Promise<ListObjectsResult> {
		const prefix = options.prefix ?? '';
		const limit = Math.min(options.limit ?? MAX_LIST_OBJECTS_LIMIT, MAX_LIST_OBJECTS_LIMIT);
		const after = options.cursor ?? options.startAfter;
		const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
		const startIndex = after === undefined ? 0 : keys.findIndex((key) => key > after);
		const visible = startIndex === -1 ? [] : keys.slice(startIndex);
		const page = visible.slice(0, limit);
		const truncated = page.length < visible.length;
		return {
			objects: page.map((key) => {
				const object = this.objects.get(key) as StoredObject;
				return { key, size: object.body.byteLength };
			}),
			truncated,
			...(truncated ? { cursor: page[page.length - 1] } : {})
		};
	}
}
