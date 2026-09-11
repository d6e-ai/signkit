import postgres from 'postgres';
import { PostgresEnvelopeApplicationStore } from '$lib/adapters/db/postgres-envelope-application-store';
import { PostgresEnvelopeReadyStore } from '$lib/adapters/db/postgres-envelope-ready-store';
import { PostgresEnvelopeSendStore } from '$lib/adapters/db/postgres-envelope-send-store';
import { PostgresRecipientAccessStore } from '$lib/adapters/db/postgres-recipient-access-store';
import { PostgresRecipientDeclineStore } from '$lib/adapters/db/postgres-recipient-decline-store';
import { PostgresRecipientViewStore } from '$lib/adapters/db/postgres-recipient-view-store';
import {
	RecipientAccessService,
	type RecipientAccessApplicationPort
} from '$lib/application/signing/recipient-access';
import type { RecipientCapabilitySealer } from '$lib/security/delivery-capability';
import {
	RecipientDeclinedApplication,
	type RecipientDeclinedApplicationPort
} from '$lib/application/signing/recipient-declined';
import {
	RecipientViewedApplication,
	type RecipientViewedApplicationPort
} from '$lib/application/signing/recipient-viewed';
import type { EnvelopeApplicationPort } from './model';
import { EnvelopeReadyApplication, type EnvelopeReadyApplicationPort } from './ready';
import { EnvelopeSendApplication, type EnvelopeSendApplicationPort } from './send';
import { EnvelopeApplication } from './service';

interface PostgresRuntimeResources {
	databaseUrl: string;
	store: PostgresEnvelopeApplicationStore;
	application: EnvelopeApplicationPort;
	readyApplication: EnvelopeReadyApplicationPort;
	recipientAccessApplication: RecipientAccessApplicationPort;
	sql: ReturnType<typeof postgres>;
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

export function resolvePostgresEnvelopeReadyApplication(
	databaseUrl: string
): EnvelopeReadyApplicationPort {
	return resolvePostgresResources(databaseUrl).readyApplication;
}

export function resolvePostgresEnvelopeSendApplication(
	databaseUrl: string,
	sealer: RecipientCapabilitySealer
): EnvelopeSendApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new EnvelopeSendApplication(new PostgresEnvelopeSendStore(resources.sql), sealer);
}

export function resolvePostgresRecipientAccessApplication(
	databaseUrl: string
): RecipientAccessApplicationPort {
	return resolvePostgresResources(databaseUrl).recipientAccessApplication;
}

export function resolvePostgresRecipientViewedApplication(
	databaseUrl: string
): RecipientViewedApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new RecipientViewedApplication(
		resources.recipientAccessApplication,
		new PostgresRecipientViewStore(resources.sql)
	);
}

export function resolvePostgresRecipientDeclinedApplication(
	databaseUrl: string
): RecipientDeclinedApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new RecipientDeclinedApplication(new PostgresRecipientDeclineStore(resources.sql));
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
	const readyApplication: EnvelopeReadyApplicationPort = new EnvelopeReadyApplication(
		new PostgresEnvelopeReadyStore(sql)
	);
	const recipientAccessApplication: RecipientAccessApplicationPort = new RecipientAccessService(
		new PostgresRecipientAccessStore(sql)
	);
	cachedResources = {
		databaseUrl: normalizedDatabaseUrl,
		store,
		application,
		readyApplication,
		recipientAccessApplication,
		sql
	};
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
