import { env } from '$env/dynamic/private';
import { D1WorkloadKeyStore } from '$lib/adapters/db/d1-workload-key-store';
import { WorkloadKeyApplication, type WorkloadKeyApplicationPort } from './workload-key-service';

export interface WorkloadKeyRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/**
 * Resolve workload key management only for a durable store configured for the
 * active deployment target: the D1 binding on Cloudflare, otherwise PostgreSQL
 * from DATABASE_URL. The PostgreSQL path stays behind a dynamic import so the
 * Node driver is never pulled into the Worker bundle.
 */
export async function resolveWorkloadKeyApplication(
	context: WorkloadKeyRuntimeContext
): Promise<WorkloadKeyApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		return database === undefined
			? null
			: new WorkloadKeyApplication(new D1WorkloadKeyStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresWorkloadKeyApplication } = await import('./runtime-postgres');
	return resolvePostgresWorkloadKeyApplication(databaseUrl);
}
