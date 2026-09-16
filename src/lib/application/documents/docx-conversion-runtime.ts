import { env } from '$env/dynamic/private';
import { D1DocxConversionStore } from '$lib/adapters/db/d1-docx-conversion-store';
import { D1EnvelopeStore } from '$lib/adapters/db/d1-envelope-store';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import { resolveDocxImportLimits } from '$lib/adapters/documents/docx-import';
import { resolveDraftPersistenceService } from '$lib/application/drafts/runtime';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import type { ObjectStore } from '$lib/ports/object-store';
import { DocxConversionService } from './docx-conversion-service';
import { DocxImportService } from './docx-import-service';

export interface DocxConversionRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveDocxConversionService(
	context: DocxConversionRuntimeContext
): Promise<DocxConversionService | null> {
	const drafts = await resolveDraftPersistenceService(context);
	if (drafts === null) return null;
	const repository = new IsomorphicGitDraftRepository();

	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const bucket: R2Bucket | undefined = context.platform.env.OBJECTS;
		if (database === undefined || bucket === undefined) return null;
		return new DocxConversionService({
			store: new D1DocxConversionStore(database),
			objects: new R2ObjectStore(bucket),
			importService: new DocxImportService(drafts),
			draftRepository: repository,
			envelopes: new D1EnvelopeStore(database),
			importLimits: resolveDocxImportLimits(context.platform)
		});
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
	const [
		{ PostgresDocxConversionStore },
		{ resolvePostgresEnvelopeStore, resolvePostgresSql },
		{ resolveS3ObjectStore }
	] = await Promise.all([
		import('$lib/adapters/db/postgres-docx-conversion-store'),
		import('$lib/application/envelopes/runtime-postgres'),
		import('$lib/application/drafts/runtime-s3')
	]);
	const objects: ObjectStore = resolveS3ObjectStore(configuration);
	return new DocxConversionService({
		store: new PostgresDocxConversionStore(resolvePostgresSql(configuration.databaseUrl ?? '')),
		objects,
		importService: new DocxImportService(drafts),
		draftRepository: repository,
		envelopes: resolvePostgresEnvelopeStore(configuration.databaseUrl ?? ''),
		importLimits: resolveDocxImportLimits(context.platform)
	});
}
