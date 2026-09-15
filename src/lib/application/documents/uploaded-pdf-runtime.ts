import { env } from '$env/dynamic/private';
import { D1EnvelopeUploadedDocumentStore } from '$lib/adapters/db/d1-envelope-uploaded-document-store';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import { resolveDraftPersistenceService } from '$lib/application/drafts/runtime';
import type { DraftPersistenceService } from '$lib/application/drafts/draft-persistence';
import type { ObjectStore } from '$lib/ports/object-store';
import type { EnvelopeUploadedDocumentStore } from '$lib/ports/envelope-uploaded-document-store';

export interface UploadedPdfRuntimeContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export interface UploadedPdfUploadDependencies {
	drafts: Pick<DraftPersistenceService, 'commit'>;
	objects: ObjectStore;
	uploadedDocuments: EnvelopeUploadedDocumentStore;
}

export async function resolveUploadedPdfUpload(
	context: UploadedPdfRuntimeContext
): Promise<UploadedPdfUploadDependencies | null> {
	const drafts: DraftPersistenceService | null = await resolveDraftPersistenceService(context);
	if (drafts === null) return null;

	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const bucket: R2Bucket | undefined = context.platform.env.OBJECTS;
		if (database === undefined || bucket === undefined) return null;
		return {
			drafts,
			objects: new R2ObjectStore(bucket),
			uploadedDocuments: new D1EnvelopeUploadedDocumentStore(database)
		};
	}

	const configuration = {
		databaseUrl: env.DATABASE_URL,
		endpoint: env.S3_ENDPOINT,
		region: env.S3_REGION,
		bucket: env.S3_BUCKET,
		accessKeyId: env.S3_ACCESS_KEY_ID,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY,
		forcePathStyle: env.S3_FORCE_PATH_STYLE
	};
	if (Object.values(configuration).every((value: string | undefined): boolean => !value?.trim())) {
		return null;
	}

	const { resolvePostgresEnvelopeUploadedDocumentStore } =
		await import('$lib/application/envelopes/runtime-postgres');
	const { resolveS3ObjectStore } = await import('$lib/application/drafts/runtime-s3');
	return {
		drafts,
		objects: resolveS3ObjectStore(configuration),
		uploadedDocuments: resolvePostgresEnvelopeUploadedDocumentStore(
			configuration.databaseUrl as string
		)
	};
}
