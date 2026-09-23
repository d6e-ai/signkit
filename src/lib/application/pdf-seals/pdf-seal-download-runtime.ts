import { env } from '$env/dynamic/private';
import { D1PdfSealPublicationStore } from '$lib/adapters/db/d1-pdf-seal-publication-store';
import { D1PdfSealRequestStore } from '$lib/adapters/db/d1-pdf-seal-request-store';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import type { PdfSealDownloadApplicationPort } from './pdf-seal-download';
import { PdfSealDownloadService } from './pdf-seal-download';

export interface PdfSealDownloadRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolvePdfSealDownloadApplication(
	context: PdfSealDownloadRuntimeContext
): Promise<PdfSealDownloadApplicationPort | null> {
	const platformEnv = context.platform?.env;
	if (platformEnv !== undefined) {
		if (platformEnv.DB === undefined || platformEnv.OBJECTS === undefined) return null;
		return new PdfSealDownloadService(
			new D1PdfSealRequestStore(platformEnv.DB),
			new D1PdfSealPublicationStore(platformEnv.DB),
			new R2ObjectStore(platformEnv.OBJECTS)
		);
	}

	const databaseUrl: string | undefined = nonEmpty(env.DATABASE_URL);
	if (databaseUrl === undefined || !hasAnyS3Configuration()) return null;
	const [requestAdapter, publicationAdapter, postgresRuntime, s3Runtime] = await Promise.all([
		import('$lib/adapters/db/postgres-pdf-seal-request-store'),
		import('$lib/adapters/db/postgres-pdf-seal-publication-store'),
		import('$lib/application/envelopes/runtime-postgres'),
		import('$lib/application/drafts/runtime-s3')
	]);
	const sql = postgresRuntime.resolvePostgresSql(databaseUrl);
	const objects = s3Runtime.resolveS3ObjectStore({
		databaseUrl,
		endpoint: env.S3_ENDPOINT,
		region: env.S3_REGION,
		bucket: env.S3_BUCKET,
		accessKeyId: env.S3_ACCESS_KEY_ID,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY,
		forcePathStyle: env.S3_FORCE_PATH_STYLE
	});
	return new PdfSealDownloadService(
		new requestAdapter.PostgresPdfSealRequestStore(sql),
		new publicationAdapter.PostgresPdfSealPublicationStore(sql),
		objects
	);
}

function hasAnyS3Configuration(): boolean {
	return [
		env.S3_ENDPOINT,
		env.S3_REGION,
		env.S3_BUCKET,
		env.S3_ACCESS_KEY_ID,
		env.S3_SECRET_ACCESS_KEY,
		env.S3_FORCE_PATH_STYLE
	].some((value: string | undefined): boolean => nonEmpty(value) !== undefined);
}

function nonEmpty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
