import { PostgresInstanceDisplayStore } from '$lib/adapters/db/postgres-instance-display-store';
import { resolvePostgresSql } from '$lib/application/runtime/postgres-sql-runtime';

export function resolvePostgresInstanceDisplayStore(
	databaseUrl: string
): PostgresInstanceDisplayStore {
	return new PostgresInstanceDisplayStore(resolvePostgresSql(databaseUrl));
}
