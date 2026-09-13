import { env } from '$env/dynamic/private';
import { D1EnvelopeStore } from '$lib/adapters/db/d1-envelope-store';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import type { DraftRepository } from '$lib/ports/draft-repository';
import type { EnvelopeStore } from '$lib/ports/envelope-store';
import type { ObjectStore } from '$lib/ports/object-store';

export interface DocxExportRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export interface EnvelopeDocxExportDependencies {
	envelopes: Pick<EnvelopeStore, 'findForOrganization'>;
	objects: ObjectStore;
	repository: DraftRepository;
}

/** Resolve commit-pinned DOCX export only when durable stores are configured. */
export async function resolveEnvelopeDocxExport(
	context: DocxExportRuntimeContext
): Promise<EnvelopeDocxExportDependencies | null> {
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

	const { resolvePostgresEnvelopeStore } =
		await import('$lib/application/envelopes/runtime-postgres');
	const { resolveS3ObjectStore } = await import('$lib/application/drafts/runtime-s3');
	return {
		envelopes: resolvePostgresEnvelopeStore(configuration.databaseUrl as string),
		objects: resolveS3ObjectStore(configuration),
		repository: new IsomorphicGitDraftRepository()
	};
}
