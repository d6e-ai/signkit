import { env } from '$env/dynamic/private';
import { D1CompletionArtifactStore } from '$lib/adapters/db/d1-completion-artifact-store';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import type { ObjectStore } from '$lib/ports/object-store';
import { CompletionArtifactPublicationService } from './completion-artifact-service';
import { CompletionArtifactStatusService } from './completion-artifact-status';

export interface CompletionArtifactRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveCompletionArtifactPublicationService(
	context: CompletionArtifactRuntimeContext
): Promise<CompletionArtifactPublicationService | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const bucket: R2Bucket | undefined = context.platform.env.OBJECTS;
		if (database === undefined || bucket === undefined) return null;
		return new CompletionArtifactPublicationService(
			new D1CompletionArtifactStore(database),
			new R2ObjectStore(bucket),
			new IsomorphicGitDraftRepository()
		);
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const s3OnlyConfiguration = {
		endpoint: env.S3_ENDPOINT,
		region: env.S3_REGION,
		bucket: env.S3_BUCKET,
		accessKeyId: env.S3_ACCESS_KEY_ID,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY,
		forcePathStyle: env.S3_FORCE_PATH_STYLE
	};
	if (
		Object.values(s3OnlyConfiguration).every((value: string | undefined): boolean => !value?.trim())
	) {
		return null;
	}
	const [{ PostgresCompletionArtifactStore }, { resolvePostgresSql }, { resolveS3ObjectStore }] =
		await Promise.all([
			import('$lib/adapters/db/postgres-completion-artifact-store'),
			import('$lib/application/envelopes/runtime-postgres'),
			import('$lib/application/drafts/runtime-s3')
		]);
	const objects: ObjectStore = resolveS3ObjectStore({ databaseUrl, ...s3OnlyConfiguration });
	return new CompletionArtifactPublicationService(
		new PostgresCompletionArtifactStore(resolvePostgresSql(databaseUrl)),
		objects,
		new IsomorphicGitDraftRepository()
	);
}

export async function resolveCompletionArtifactStatusService(
	context: CompletionArtifactRuntimeContext
): Promise<CompletionArtifactStatusService | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new CompletionArtifactStatusService(new D1CompletionArtifactStore(database));
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const [{ PostgresCompletionArtifactStore }, { resolvePostgresSql }] = await Promise.all([
		import('$lib/adapters/db/postgres-completion-artifact-store'),
		import('$lib/application/envelopes/runtime-postgres')
	]);
	return new CompletionArtifactStatusService(
		new PostgresCompletionArtifactStore(resolvePostgresSql(databaseUrl))
	);
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
