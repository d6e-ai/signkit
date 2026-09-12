import { PostgresInstanceStore } from '$lib/adapters/db/postgres-instance-store';
import { resolvePostgresSql } from '$lib/application/envelopes/runtime-postgres';
import { InstanceApplication, type InstanceApplicationPort } from './instance-service';

/**
 * Share the process-local PostgreSQL pool used by the rest of the Node and
 * Vercel runtimes.
 */
export function resolvePostgresInstanceApplication(databaseUrl: string): InstanceApplicationPort {
	return new InstanceApplication(new PostgresInstanceStore(resolvePostgresSql(databaseUrl)));
}
