import { env } from '$env/dynamic/private';
import { D1ApiKeyAuthenticationStore } from '$lib/adapters/db/d1-api-key-authentication-store';
import {
	ApiKeyAuthenticationApplication,
	type ApiKeyAuthenticationPort
} from './api-key-authentication';

export interface ApiKeyAuthenticationRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/**
 * Resolve request-path API key authentication only for a durable store
 * configured for the active deployment target: the D1 binding on Cloudflare,
 * otherwise PostgreSQL from DATABASE_URL. The PostgreSQL path stays behind a
 * dynamic import so the Node driver is never pulled into the Worker bundle,
 * matching `api-key-runtime.ts`.
 *
 * A `null` return means authentication cannot be performed at all, which callers
 * must surface as unavailable rather than as unauthenticated: a deployment
 * without a store must not silently downgrade every agent request to anonymous.
 */
export async function resolveApiKeyAuthentication(
	context: ApiKeyAuthenticationRuntimeContext
): Promise<ApiKeyAuthenticationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		return database === undefined
			? null
			: new ApiKeyAuthenticationApplication(new D1ApiKeyAuthenticationStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresApiKeyAuthentication } =
		await import('./api-key-authentication-runtime-postgres');
	return resolvePostgresApiKeyAuthentication(databaseUrl);
}
