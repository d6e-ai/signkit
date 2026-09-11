import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	type S3Client
} from '@aws-sdk/client-s3';
import type { ObjectMetadata, ObjectStore, PutObject } from '$lib/ports/object-store';
import { assertObjectKey } from '$lib/ports/object-store';

export class S3ObjectStore implements ObjectStore {
	constructor(
		private readonly client: S3Client,
		private readonly bucket: string
	) {}

	async head(key: string): Promise<ObjectMetadata | null> {
		assertObjectKey(key);
		try {
			const result = await this.client.send(
				new HeadObjectCommand({ Bucket: this.bucket, Key: key })
			);
			return {
				key,
				contentType: result.ContentType ?? null,
				size: result.ContentLength ?? 0,
				sha256: result.Metadata?.sha256 ?? null,
				version: result.VersionId ?? result.ETag ?? null
			};
		} catch (error) {
			const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
				?.httpStatusCode;
			if (status === 404) return null;
			throw error;
		}
	}

	async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
		assertObjectKey(key);
		try {
			const result = await this.client.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: key })
			);
			return result.Body?.transformToWebStream() ?? null;
		} catch (error) {
			const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
				?.httpStatusCode;
			if (status === 404) return null;
			throw error;
		}
	}

	async putImmutable(key: string, object: PutObject): Promise<ObjectMetadata> {
		assertObjectKey(key);
		const result = await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: object.body,
				ContentType: object.contentType,
				IfNoneMatch: '*',
				Metadata: { ...object.metadata, sha256: object.sha256 }
			})
		);
		return {
			key,
			contentType: object.contentType,
			size: object.body instanceof Uint8Array ? object.body.byteLength : 0,
			sha256: object.sha256,
			version: result.VersionId ?? result.ETag ?? null
		};
	}

	async delete(key: string): Promise<void> {
		assertObjectKey(key);
		await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
	}
}
