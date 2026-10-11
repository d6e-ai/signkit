import postgres from 'postgres';

interface CachedPostgresSql {
	databaseUrl: string;
	sql: ReturnType<typeof postgres>;
}

let cachedSql: CachedPostgresSql | null = null;

/**
 * Feature-neutral entry point for the process-local PostgreSQL pool shared
 * by every application runtime that needs raw SQL access (Node and Vercel
 * Node deployments; Cloudflare Workers use D1 instead). Resolving the pool
 * here never constructs any feature's application services, stores, or
 * request/actor/session state -- callers that need a feature's application
 * compose it themselves from this shared sql client.
 */
export function resolvePostgresSql(databaseUrl: string): ReturnType<typeof postgres> {
	const normalizedDatabaseUrl: string = databaseUrl.trim();
	assertPostgresUrl(normalizedDatabaseUrl);

	if (cachedSql !== null) {
		if (cachedSql.databaseUrl !== normalizedDatabaseUrl) {
			// Silently switching databases in a warm process risks crossing deployment
			// boundaries and leaks the old pool. A restart is required instead.
			throw new Error('Database configuration changed after runtime initialization');
		}
		return cachedSql.sql;
	}

	const sql: ReturnType<typeof postgres> = postgres(normalizedDatabaseUrl, {
		connect_timeout: 10,
		idle_timeout: 20,
		max: 5
	});
	cachedSql = { databaseUrl: normalizedDatabaseUrl, sql };
	return cachedSql.sql;
}

function assertPostgresUrl(databaseUrl: string): void {
	if (databaseUrl.length === 0) throw new Error('DATABASE_URL is required');

	let url: URL;
	try {
		url = new URL(databaseUrl);
	} catch {
		throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
	}
	if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
		throw new Error('DATABASE_URL must use the postgres or postgresql scheme');
	}
}
