import { env } from '$env/dynamic/private';
import { D1RecipientAccessStore } from '$lib/adapters/db/d1-recipient-access-store';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import { readImmutableDraftRevision } from '$lib/application/drafts/draft-persistence';
import { RecipientAccessService, type RecipientAccessApplicationPort } from './recipient-access';
import {
	RecipientWorkspaceService,
	type RecipientWorkspaceApplicationPort
} from './recipient-workspace';

export interface RecipientAccessRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveRecipientAccessApplication(
	context: RecipientAccessRuntimeContext
): Promise<RecipientAccessApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new RecipientAccessService(new D1RecipientAccessStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresRecipientAccessApplication } =
		await import('$lib/application/envelopes/runtime-postgres');
	return resolvePostgresRecipientAccessApplication(databaseUrl);
}

export async function resolveRecipientWorkspaceApplication(
	context: RecipientAccessRuntimeContext
): Promise<RecipientWorkspaceApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const bucket: R2Bucket | undefined = context.platform.env.OBJECTS;
		if (database === undefined || bucket === undefined) return null;
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const objects: R2ObjectStore = new R2ObjectStore(bucket);
		return new RecipientWorkspaceService(
			new RecipientAccessService(new D1RecipientAccessStore(database)),
			(revision) => readImmutableDraftRevision(revision, objects, repository)
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
	const { resolveS3RecipientWorkspaceApplication } =
		await import('$lib/application/drafts/runtime-s3');
	return resolveS3RecipientWorkspaceApplication(configuration);
}
