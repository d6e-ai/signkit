import { env } from '$env/dynamic/private';
import { D1EnvelopeStore } from '$lib/adapters/db/d1-envelope-store';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import type { DraftRepository } from '$lib/ports/draft-repository';
import type { EnvelopeStore } from '$lib/ports/envelope-store';
import type { ObjectStore } from '$lib/ports/object-store';

export interface EnvelopeDocumentDependenciesRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export interface EnvelopeDocumentDependencies {
	envelopes: Pick<EnvelopeStore, 'findEnvelope'>;
	objects: ObjectStore;
	repository: DraftRepository;
}

/**
 * Feature-neutral commit-pinned document dependencies: the envelope pointer,
 * object store, and Git repository that any document-reading feature needs,
 * resolved only when durable stores are configured. No feature's envelope
 * application is constructed here.
 */
export async function resolveEnvelopeDocumentDependencies(
	context: EnvelopeDocumentDependenciesRuntimeContext
): Promise<EnvelopeDocumentDependencies | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const bucket: R2Bucket | undefined = context.platform.env.OBJECTS;
		if (database === undefined || bucket === undefined) return null;
		return {
			envelopes: new D1EnvelopeStore(database),
			objects: new R2ObjectStore(bucket),
			repository: new IsomorphicGitDraftRepository()
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

	const { PostgresEnvelopeStore } = await import('$lib/adapters/db/postgres-envelope-store');
	const { resolvePostgresSql } = await import('./postgres-sql-runtime');
	const { resolveS3ObjectStore } = await import('$lib/application/drafts/runtime-s3');
	return {
		envelopes: new PostgresEnvelopeStore(resolvePostgresSql(configuration.databaseUrl as string)),
		objects: resolveS3ObjectStore(configuration),
		repository: new IsomorphicGitDraftRepository()
	};
}
