import postgres from 'postgres';
import { PostgresEnvelopeApplicationStore } from '$lib/adapters/db/postgres-envelope-application-store';
import type { EnvelopeApplicationPort } from './model';
import { EnvelopeApplication } from './service';

interface PostgresRuntimeResources {
	databaseUrl: string;
	store: PostgresEnvelopeApplicationStore;
	application: EnvelopeApplicationPort;
}

let cachedResources: PostgresRuntimeResources | null = null;

/**
 * Reuse a small process-local pool for adapter-node and Vercel Node runtimes.
 * No request or tenant state is retained in the singleton.
 */
export function resolvePostgresEnvelopeApplication(databaseUrl: string): EnvelopeApplicationPort {
	return resolvePostgresResources(databaseUrl).application;
}

/**
 * Share the same process-local PostgreSQL pool with draft persistence. The
 * store contains no request, organization, or actor state; every operation
 * still receives its organization scope explicitly.
 */
export function resolvePostgresEnvelopeStore(
	databaseUrl: string
): PostgresEnvelopeApplicationStore {
	return resolvePostgresResources(databaseUrl).store;
}

function resolvePostgresResources(databaseUrl: string): PostgresRuntimeResources {
	const normalizedDatabaseUrl: string = databaseUrl.trim();
	assertPostgresUrl(normalizedDatabaseUrl);

	if (cachedResources !== null) {
		if (cachedResources.databaseUrl !== normalizedDatabaseUrl) {
			// Silently switching databases in a warm process risks crossing deployment
			// boundaries and leaks the old pool. A restart is required instead.
			throw new Error('Database configuration changed after runtime initialization');
		}
		return cachedResources;
	}

	const sql: ReturnType<typeof postgres> = postgres(normalizedDatabaseUrl, {
		connect_timeout: 10,
		idle_timeout: 20,
		max: 5
	});
	const store: PostgresEnvelopeApplicationStore = new PostgresEnvelopeApplicationStore(sql);
	const application: EnvelopeApplicationPort = new EnvelopeApplication(store);
	cachedResources = { databaseUrl: normalizedDatabaseUrl, store, application };
	return cachedResources;
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
