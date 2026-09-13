export interface ObjectMetadata {
	key: string;
	contentType: string | null;
	size: number;
	sha256: string | null;
	version: string | null;
}

export interface PutObject {
	contentType: string;
	body: Uint8Array | ReadableStream<Uint8Array>;
	sha256: string;
	metadata?: Readonly<Record<string, string>>;
}

export const MAX_LIST_OBJECTS_LIMIT: number = 1000;

export interface ListObjectsOptions {
	prefix?: string;
	cursor?: string;
	limit?: number;
}

export interface ListObjectsItem {
	key: string;
	size: number;
	uploadedAt?: string;
}

export interface ListObjectsResult {
	objects: readonly ListObjectsItem[];
	truncated: boolean;
	cursor?: string;
}

export interface ObjectStore {
	head(key: string): Promise<ObjectMetadata | null>;
	get(key: string): Promise<ReadableStream<Uint8Array> | null>;
	putImmutable(key: string, object: PutObject): Promise<ObjectMetadata>;
	delete(key: string): Promise<void>;
	list(options?: ListObjectsOptions): Promise<ListObjectsResult>;
	deleteMany(keys: readonly string[]): Promise<void>;
}

export function assertObjectKey(key: string): void {
	if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\')) {
		throw new Error('Invalid object key');
	}
}
