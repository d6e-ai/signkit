import postgres from 'postgres';
import { PostgresEnvelopeApplicationStore } from '$lib/adapters/db/postgres-envelope-application-store';
import type { EnvelopeApplicationPort } from './model';
import { EnvelopeApplication } from './service';

let cachedDatabaseUrl: string | null = null;
let cachedApplication: EnvelopeApplicationPort | null = null;

/**
 * Reuse a small process-local pool for adapter-node and Vercel Node runtimes.
 * No request or tenant state is retained in the singleton.
 */
export function resolvePostgresEnvelopeApplication(databaseUrl: string): EnvelopeApplicationPort {
	if (cachedApplication !== null && cachedDatabaseUrl === databaseUrl) return cachedApplication;

	const sql: ReturnType<typeof postgres> = postgres(databaseUrl, {
		connect_timeout: 10,
		idle_timeout: 20,
		max: 5
	});
	const application: EnvelopeApplicationPort = new EnvelopeApplication(
		new PostgresEnvelopeApplicationStore(sql)
	);
	cachedDatabaseUrl = databaseUrl;
	cachedApplication = application;
	return application;
}
