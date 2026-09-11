import { env } from '$env/dynamic/private';
import { D1EnvelopeApplicationStore } from '$lib/adapters/db/d1-envelope-application-store';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import { DraftPersistenceService } from './draft-persistence';

export interface DraftRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/** Resolve draft persistence only when every durable dependency is configured. */
export async function resolveDraftPersistenceService(
	context: DraftRuntimeContext
): Promise<DraftPersistenceService | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const bucket: R2Bucket | undefined = context.platform.env.OBJECTS;
		if (database === undefined || bucket === undefined) return null;

		return new DraftPersistenceService(
			new D1EnvelopeApplicationStore(database),
			new R2ObjectStore(bucket),
			new IsomorphicGitDraftRepository()
		);
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

	const { resolveS3DraftPersistenceService } = await import('./runtime-s3');
	return resolveS3DraftPersistenceService(configuration);
}
