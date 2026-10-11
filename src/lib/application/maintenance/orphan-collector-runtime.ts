import { env } from '$env/dynamic/private';
import { D1SignatureAssetLedger } from '$lib/adapters/db/d1-signature-asset-ledger';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import {
	D1_ORPHAN_SWEEP_STATEMENT_BUDGET,
	D1OrphanReferenceStore,
	D1OrphanSweepCheckpointStore,
	OrphanCollector,
	PostgresOrphanReferenceStore,
	PostgresOrphanSweepCheckpointStore
} from './orphan-collector';

export interface OrphanCollectorRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/** Resolve orphan collection only when object storage and its SQL reference store are configured. */
export async function resolveOrphanCollector(
	context: OrphanCollectorRuntimeContext
): Promise<OrphanCollector | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const bucket: R2Bucket | undefined = context.platform.env.OBJECTS;
		if (database === undefined || bucket === undefined) return null;
		return new OrphanCollector(
			new R2ObjectStore(bucket),
			new D1OrphanReferenceStore(database),
			(): Date => new Date(),
			new D1OrphanSweepCheckpointStore(database),
			new D1SignatureAssetLedger(database),
			D1_ORPHAN_SWEEP_STATEMENT_BUDGET
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

	const [{ resolveS3ObjectStore }, { resolvePostgresSql }, { PostgresSignatureAssetLedger }] =
		await Promise.all([
			import('$lib/application/drafts/runtime-s3'),
			import('$lib/application/runtime/postgres-sql-runtime'),
			import('$lib/adapters/db/postgres-signature-asset-ledger')
		]);
	// Resolve object storage first so incomplete S3 configuration fails closed
	// without opening a process-local Postgres pool.
	const objectStore = resolveS3ObjectStore(configuration);
	const sql = resolvePostgresSql(configuration.databaseUrl ?? '');
	return new OrphanCollector(
		objectStore,
		new PostgresOrphanReferenceStore(sql),
		(): Date => new Date(),
		new PostgresOrphanSweepCheckpointStore(sql),
		new PostgresSignatureAssetLedger(sql)
	);
}
