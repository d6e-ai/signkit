import postgres from 'postgres';
import type { DraftPersistenceService } from '$lib/application/drafts/draft-persistence';
import { PostgresEnvelopeApplicationStore } from '$lib/adapters/db/postgres-envelope-application-store';
import { PostgresEnvelopeFieldStore } from '$lib/adapters/db/postgres-envelope-field-store';
import { PostgresEnvelopeReadyStore } from '$lib/adapters/db/postgres-envelope-ready-store';
import { PostgresEnvelopeSendStore } from '$lib/adapters/db/postgres-envelope-send-store';
import { PostgresEnvelopeVoidStore } from '$lib/adapters/db/postgres-envelope-void-store';
import { PostgresEnvelopeSentPdfStore } from '$lib/adapters/db/postgres-envelope-sent-pdf-store';
import { PostgresRecipientAccessStore } from '$lib/adapters/db/postgres-recipient-access-store';
import { PostgresRecipientFieldDeclarationStore } from '$lib/adapters/db/postgres-recipient-field-declaration-store';
import { PostgresRecipientApproveStore } from '$lib/adapters/db/postgres-recipient-approve-store';
import { PostgresRecipientDeclineStore } from '$lib/adapters/db/postgres-recipient-decline-store';
import { PostgresRecipientDeclinedReceiptStore } from '$lib/adapters/db/postgres-recipient-declined-receipt-store';
import { PostgresRecipientSignStore } from '$lib/adapters/db/postgres-recipient-sign-store';
import { PostgresRecipientViewStore } from '$lib/adapters/db/postgres-recipient-view-store';
import { PostgresRecipientCapabilityReissueStore } from '$lib/adapters/db/postgres-recipient-capability-reissue-store';
import {
	RecipientCapabilityReissueApplication,
	type RecipientCapabilityReissueApplicationPort
} from '$lib/application/signing/recipient-capability-reissue';
import {
	RecipientAccessService,
	type RecipientAccessApplicationPort
} from '$lib/application/signing/recipient-access';
import type { SentDocumentPdfPort } from '$lib/application/documents/sent-document-pdf';
import type { RecipientCapabilitySealer } from '$lib/security/delivery-capability';
import {
	RecipientApprovedApplication,
	type RecipientApprovedApplicationPort
} from '$lib/application/signing/recipient-approved';
import {
	RecipientSignedApplication,
	type RecipientSignedApplicationPort
} from '$lib/application/signing/recipient-signed';
import {
	RecipientDeclinedApplication,
	type RecipientDeclinedApplicationPort
} from '$lib/application/signing/recipient-declined';
import {
	RecipientDeclinedReceiptApplication,
	type RecipientDeclinedReceiptApplicationPort
} from '$lib/application/signing/recipient-declined-receipt';
import {
	RecipientViewedApplication,
	type RecipientViewedApplicationPort
} from '$lib/application/signing/recipient-viewed';
import type { EnvelopeApplicationPort } from './model';
import { EnvelopeFieldApplication, type EnvelopeFieldApplicationPort } from './fields';
import { EnvelopeReadyApplication, type EnvelopeReadyApplicationPort } from './ready';
import { EnvelopeSendApplication, type EnvelopeSendApplicationPort } from './send';
import { EnvelopeVoidApplication, type EnvelopeVoidApplicationPort } from './void';
import { EnvelopeApplication } from './service';

interface PostgresRuntimeResources {
	databaseUrl: string;
	store: PostgresEnvelopeApplicationStore;
	application: EnvelopeApplicationPort;
	readyApplication: EnvelopeReadyApplicationPort;
	fieldStore: PostgresEnvelopeFieldStore;
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

/**
 * Share the same process-local PostgreSQL pool with draft persistence and the
 * per-envelope application store. The caller supplies the draft persistence
 * service so the same object storage/Git dependencies used elsewhere resolve
 * documents, rather than opening a second path to them here.
 */
export function resolvePostgresEnvelopeFieldApplication(
	databaseUrl: string,
	drafts: DraftPersistenceService
): EnvelopeFieldApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new EnvelopeFieldApplication(resources.fieldStore, drafts);
}

export function resolvePostgresEnvelopeSendApplication(
	databaseUrl: string,
	sealer: RecipientCapabilitySealer,
	documentPdf: SentDocumentPdfPort
): EnvelopeSendApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new EnvelopeSendApplication(
		new PostgresEnvelopeSendStore(resources.sql),
		sealer,
		documentPdf
	);
}

export function resolvePostgresEnvelopeSentPdfStore(
	databaseUrl: string
): PostgresEnvelopeSentPdfStore {
	return new PostgresEnvelopeSentPdfStore(resolvePostgresResources(databaseUrl).sql);
}

export function resolvePostgresEnvelopeVoidApplication(
	databaseUrl: string
): EnvelopeVoidApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new EnvelopeVoidApplication(new PostgresEnvelopeVoidStore(resources.sql));
}

export function resolvePostgresEnvelopeReissueApplication(
	databaseUrl: string,
	sealer: RecipientCapabilitySealer
): RecipientCapabilityReissueApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new RecipientCapabilityReissueApplication(
		new PostgresRecipientCapabilityReissueStore(resources.sql),
		sealer
	);
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

export function resolvePostgresRecipientDeclinedReceiptApplication(
	databaseUrl: string
): RecipientDeclinedReceiptApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new RecipientDeclinedReceiptApplication(
		new PostgresRecipientDeclinedReceiptStore(resources.sql)
	);
}

export function resolvePostgresRecipientApprovedApplication(
	databaseUrl: string
): RecipientApprovedApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new RecipientApprovedApplication(new PostgresRecipientApproveStore(resources.sql));
}

export function resolvePostgresRecipientSignedApplication(
	databaseUrl: string
): RecipientSignedApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new RecipientSignedApplication(new PostgresRecipientSignStore(resources.sql));
}

export function resolvePostgresRecipientFieldDeclarationStore(
	databaseUrl: string
): PostgresRecipientFieldDeclarationStore {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new PostgresRecipientFieldDeclarationStore(resources.sql);
}

/**
 * Reuse the process-local pool for independently composed application services.
 * The SQL client carries no request or tenant state.
 */
export function resolvePostgresSql(databaseUrl: string): ReturnType<typeof postgres> {
	return resolvePostgresResources(databaseUrl).sql;
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
	const fieldStore: PostgresEnvelopeFieldStore = new PostgresEnvelopeFieldStore(sql);
	const recipientAccessApplication: RecipientAccessApplicationPort = new RecipientAccessService(
		new PostgresRecipientAccessStore(sql)
	);
	cachedResources = {
		databaseUrl: normalizedDatabaseUrl,
		store,
		application,
		readyApplication,
		fieldStore,
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
