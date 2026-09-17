import { PostgresApiKeyAuthenticationStore } from '$lib/adapters/db/postgres-api-key-authentication-store';
import { resolvePostgresSql } from '$lib/application/envelopes/runtime-postgres';
import {
	ApiKeyAuthenticationApplication,
	type ApiKeyAuthenticationPort
} from './api-key-authentication';

/**
 * Share the process-local PostgreSQL pool used by the rest of the Node and
 * Vercel runtimes. The store holds no request state; every call carries its own
 * token hash and instant.
 */
export function resolvePostgresApiKeyAuthentication(databaseUrl: string): ApiKeyAuthenticationPort {
	return new ApiKeyAuthenticationApplication(
		new PostgresApiKeyAuthenticationStore(resolvePostgresSql(databaseUrl))
	);
}
