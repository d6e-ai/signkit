import { PostgresApiKeyStore } from '$lib/adapters/db/postgres-api-key-store';
import { resolvePostgresSql } from '$lib/application/envelopes/runtime-postgres';
import { ApiKeyApplication, type ApiKeyApplicationPort } from './api-key-service';

/**
 * Share the process-local PostgreSQL pool used by the rest of the Node and
 * Vercel runtimes. The store holds no request or actor state; every operation
 * receives its owner scope explicitly.
 */
export function resolvePostgresApiKeyApplication(databaseUrl: string): ApiKeyApplicationPort {
	return new ApiKeyApplication(new PostgresApiKeyStore(resolvePostgresSql(databaseUrl)));
}
