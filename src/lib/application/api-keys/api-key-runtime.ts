import { env } from '$env/dynamic/private';
import { D1ApiKeyStore } from '$lib/adapters/db/d1-api-key-store';
import { ApiKeyApplication, type ApiKeyApplicationPort } from './api-key-service';

export interface ApiKeyRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/**
 * Resolve API key management only for a durable store configured for the
 * active deployment target: the D1 binding on Cloudflare, otherwise PostgreSQL
 * from DATABASE_URL. The PostgreSQL path stays behind a dynamic import so the
 * Node driver is never pulled into the Worker bundle.
 */
export async function resolveApiKeyApplication(
	context: ApiKeyRuntimeContext
): Promise<ApiKeyApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		return database === undefined ? null : new ApiKeyApplication(new D1ApiKeyStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresApiKeyApplication } = await import('./runtime-postgres');
	return resolvePostgresApiKeyApplication(databaseUrl);
}
