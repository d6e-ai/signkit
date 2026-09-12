import { PostgresWorkloadKeyStore } from '$lib/adapters/db/postgres-workload-key-store';
import { resolvePostgresSql } from '$lib/application/envelopes/runtime-postgres';
import { WorkloadKeyApplication, type WorkloadKeyApplicationPort } from './workload-key-service';

/**
 * Share the process-local PostgreSQL pool used by the rest of the Node and
 * Vercel runtimes. The store holds no request, organization, or actor state;
 * every operation receives its organization scope explicitly.
 */
export function resolvePostgresWorkloadKeyApplication(
	databaseUrl: string
): WorkloadKeyApplicationPort {
	return new WorkloadKeyApplication(new PostgresWorkloadKeyStore(resolvePostgresSql(databaseUrl)));
}
