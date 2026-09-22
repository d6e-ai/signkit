import { env } from '$env/dynamic/private';
import { D1CompletionArtifactStore } from '$lib/adapters/db/d1-completion-artifact-store';
import { D1CompletionArtifactPdfStore } from '$lib/adapters/db/d1-completion-artifact-pdf-store';
import { D1CompletionPdfEvidenceStore } from '$lib/adapters/db/d1-completion-pdf-evidence-store';
import { D1EnvelopeSentDocumentStore } from '$lib/adapters/db/d1-envelope-sent-document-store';
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
			new IsomorphicGitDraftRepository(),
			undefined,
			undefined,
			undefined,
			new D1CompletionArtifactPdfStore(database),
			new D1CompletionPdfEvidenceStore(database),
			new D1EnvelopeSentDocumentStore(database)
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
	const [
		{ PostgresCompletionArtifactStore },
		{ PostgresCompletionArtifactPdfStore },
		{ PostgresCompletionPdfEvidenceStore },
		{ PostgresEnvelopeSentDocumentStore },
		{ resolvePostgresSql },
		{ resolveS3ObjectStore }
	] = await Promise.all([
		import('$lib/adapters/db/postgres-completion-artifact-store'),
		import('$lib/adapters/db/postgres-completion-artifact-pdf-store'),
		import('$lib/adapters/db/postgres-completion-pdf-evidence-store'),
		import('$lib/adapters/db/postgres-envelope-sent-document-store'),
		import('$lib/application/envelopes/runtime-postgres'),
		import('$lib/application/drafts/runtime-s3')
	]);
	const sql = resolvePostgresSql(databaseUrl);
	const objects: ObjectStore = resolveS3ObjectStore({ databaseUrl, ...s3OnlyConfiguration });
	return new CompletionArtifactPublicationService(
		new PostgresCompletionArtifactStore(sql),
		objects,
		new IsomorphicGitDraftRepository(),
		undefined,
		undefined,
		undefined,
		new PostgresCompletionArtifactPdfStore(sql),
		new PostgresCompletionPdfEvidenceStore(sql),
		new PostgresEnvelopeSentDocumentStore(sql)
	);
}

export async function resolveCompletionArtifactStatusService(
	context: CompletionArtifactRuntimeContext
): Promise<CompletionArtifactStatusService | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new CompletionArtifactStatusService(
			new D1CompletionArtifactStore(database),
			new D1CompletionArtifactPdfStore(database)
		);
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const [
		{ PostgresCompletionArtifactStore },
		{ PostgresCompletionArtifactPdfStore },
		{ resolvePostgresSql }
	] = await Promise.all([
		import('$lib/adapters/db/postgres-completion-artifact-store'),
		import('$lib/adapters/db/postgres-completion-artifact-pdf-store'),
		import('$lib/application/envelopes/runtime-postgres')
	]);
	const sql = resolvePostgresSql(databaseUrl);
	return new CompletionArtifactStatusService(
		new PostgresCompletionArtifactStore(sql),
		new PostgresCompletionArtifactPdfStore(sql)
	);
}

export async function resolveCompletionEvidenceService(
	context: CompletionArtifactRuntimeContext
): Promise<import('./completion-evidence-service').CompletionEvidenceService | null> {
	const { CompletionEvidenceService } = await import('./completion-evidence-service');
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const bucket: R2Bucket | undefined = context.platform.env.OBJECTS;
		if (database === undefined || bucket === undefined) return null;
		return new CompletionEvidenceService(
			new D1CompletionArtifactStore(database),
			new R2ObjectStore(bucket),
			new D1CompletionArtifactPdfStore(database)
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
	const [
		{ PostgresCompletionArtifactStore },
		{ PostgresCompletionArtifactPdfStore },
		{ resolvePostgresSql },
		{ resolveS3ObjectStore }
	] = await Promise.all([
		import('$lib/adapters/db/postgres-completion-artifact-store'),
		import('$lib/adapters/db/postgres-completion-artifact-pdf-store'),
		import('$lib/application/envelopes/runtime-postgres'),
		import('$lib/application/drafts/runtime-s3')
	]);
	const sql = resolvePostgresSql(databaseUrl);
	const objects: ObjectStore = resolveS3ObjectStore({ databaseUrl, ...s3OnlyConfiguration });
	return new CompletionEvidenceService(
		new PostgresCompletionArtifactStore(sql),
		objects,
		new PostgresCompletionArtifactPdfStore(sql)
	);
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
