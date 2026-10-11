import { env } from '$env/dynamic/private';
import type { ObjectStore } from '$lib/ports/object-store';
import { AesGcmCompletionTokenSealer } from '$lib/security/completion-token-sealer';
import { CompletionAccessReissueArtifactVerifier } from './completion-access-reissue-artifact-verifier';
import {
	CompletionAccessReissueService,
	type CompletionAccessReissueApplicationPort
} from './completion-access-reissue-service';

export interface CompletionAccessReissueRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/** Shares `DELIVERY_ENCRYPTION_KEY`/`_PREVIOUS` with completion delivery -- see `AesGcmCompletionTokenSealer`. */
export async function resolveCompletionAccessReissueApplication(
	context: CompletionAccessReissueRuntimeContext
): Promise<CompletionAccessReissueApplicationPort | null> {
	const encodedKey: string | undefined = nonempty(
		context.platform?.env?.DELIVERY_ENCRYPTION_KEY ?? env.DELIVERY_ENCRYPTION_KEY
	);
	if (encodedKey === undefined) return null;
	const previousEncodedKey: string | undefined = nonempty(
		context.platform?.env?.DELIVERY_ENCRYPTION_KEY_PREVIOUS ?? env.DELIVERY_ENCRYPTION_KEY_PREVIOUS
	);
	const sealer: AesGcmCompletionTokenSealer = new AesGcmCompletionTokenSealer(
		encodedKey,
		previousEncodedKey
	);

	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const bucket: R2Bucket | undefined = context.platform.env.OBJECTS;
		if (database === undefined || bucket === undefined) return null;
		const [
			{ D1CompletionAccessReissueStore },
			{ D1CompletionArtifactStore },
			{ D1CompletionArtifactPdfStore },
			{ R2ObjectStore }
		] = await Promise.all([
			import('$lib/adapters/db/d1-completion-access-reissue'),
			import('$lib/adapters/db/d1-completion-artifact-store'),
			import('$lib/adapters/db/d1-completion-artifact-pdf-store'),
			import('$lib/adapters/object/r2')
		]);
		const verifier: CompletionAccessReissueArtifactVerifier =
			new CompletionAccessReissueArtifactVerifier(
				new D1CompletionArtifactStore(database),
				new D1CompletionArtifactPdfStore(database),
				new R2ObjectStore(bucket)
			);
		return new CompletionAccessReissueService(
			new D1CompletionAccessReissueStore(database),
			verifier,
			sealer
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
		{ PostgresCompletionAccessReissueStore },
		{ PostgresCompletionArtifactStore },
		{ PostgresCompletionArtifactPdfStore },
		{ resolvePostgresSql },
		{ resolveS3ObjectStore }
	] = await Promise.all([
		import('$lib/adapters/db/postgres-completion-access-reissue'),
		import('$lib/adapters/db/postgres-completion-artifact-store'),
		import('$lib/adapters/db/postgres-completion-artifact-pdf-store'),
		import('$lib/application/runtime/postgres-sql-runtime'),
		import('$lib/application/drafts/runtime-s3')
	]);
	let objects: ObjectStore;
	try {
		objects = resolveS3ObjectStore({ databaseUrl, ...s3OnlyConfiguration });
	} catch {
		// Partial or invalid storage configuration must resolve to "not
		// configured", matching every other completion-delivery resolver.
		return null;
	}
	const sql: ReturnType<typeof resolvePostgresSql> = resolvePostgresSql(databaseUrl);
	const verifier: CompletionAccessReissueArtifactVerifier =
		new CompletionAccessReissueArtifactVerifier(
			new PostgresCompletionArtifactStore(sql),
			new PostgresCompletionArtifactPdfStore(sql),
			objects
		);
	return new CompletionAccessReissueService(
		new PostgresCompletionAccessReissueStore(sql),
		verifier,
		sealer
	);
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
