import postgres from 'postgres';
import { resolvePostgresSql } from '$lib/application/runtime/postgres-sql-runtime';
import type { DraftPersistenceService } from '$lib/application/drafts/draft-persistence';
import { PostgresEnvelopeApplicationStore } from '$lib/adapters/db/postgres-envelope-application-store';
import { PostgresEnvelopeFieldStore } from '$lib/adapters/db/postgres-envelope-field-store';
import { PostgresEnvelopeReadyStore } from '$lib/adapters/db/postgres-envelope-ready-store';
import { PostgresEnvelopeReopenStore } from '$lib/adapters/db/postgres-envelope-reopen-store';
import { PostgresEnvelopeSendStore } from '$lib/adapters/db/postgres-envelope-send-store';
import { PostgresEnvelopeVoidStore } from '$lib/adapters/db/postgres-envelope-void-store';
import { PostgresEnvelopeSentPdfStore } from '$lib/adapters/db/postgres-envelope-sent-pdf-store';
import { PostgresEnvelopeSentDocumentStore } from '$lib/adapters/db/postgres-envelope-sent-document-store';
import { PostgresEnvelopeUploadedDocumentStore } from '$lib/adapters/db/postgres-envelope-uploaded-document-store';
import { PostgresRecipientAccessStore } from '$lib/adapters/db/postgres-recipient-access-store';
import { PostgresRecipientFieldDeclarationStore } from '$lib/adapters/db/postgres-recipient-field-declaration-store';
import { PostgresRecipientApproveStore } from '$lib/adapters/db/postgres-recipient-approve-store';
import { PostgresRecipientDeclineStore } from '$lib/adapters/db/postgres-recipient-decline-store';
import { PostgresRecipientDeclinedReceiptStore } from '$lib/adapters/db/postgres-recipient-declined-receipt-store';
import { PostgresRecipientCompletedReceiptStore } from '$lib/adapters/db/postgres-recipient-completed-receipt-store';
import { PostgresRecipientSignStore } from '$lib/adapters/db/postgres-recipient-sign-store';
import { PostgresSignatureAssetLedger } from '$lib/adapters/db/postgres-signature-asset-ledger';
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
import { PostgresCompletionPdfEvidenceStore } from '$lib/adapters/db/postgres-completion-pdf-evidence-store';
import type { CompletionPdfEvidenceStore } from '$lib/ports/completion-pdf-evidence-store';
import type { RecipientCapabilitySealer } from '$lib/security/delivery-capability';
import type { ObjectStore } from '$lib/ports/object-store';
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
	RecipientCompletedReceiptApplication,
	type RecipientCompletedReceiptApplicationPort
} from '$lib/application/signing/recipient-completed-receipt';
import {
	RecipientViewedApplication,
	type RecipientViewedApplicationPort
} from '$lib/application/signing/recipient-viewed';
import type { EnvelopeApplicationPort } from './model';
import {
	EnvelopeAuthoringFieldsRead,
	EnvelopeFieldApplication,
	type EnvelopeAuthoringFieldsReadPort,
	type EnvelopeFieldApplicationPort
} from './fields';
import { EnvelopeReadyApplication, type EnvelopeReadyApplicationPort } from './ready';
import { EnvelopeReopenApplication, type EnvelopeReopenApplicationPort } from './reopen';
import { EnvelopeSendApplication, type EnvelopeSendApplicationPort } from './send';
import { EnvelopeVoidApplication, type EnvelopeVoidApplicationPort } from './void';
import { EnvelopeApplication } from './service';

interface PostgresRuntimeResources {
	store: PostgresEnvelopeApplicationStore;
	application: EnvelopeApplicationPort;
	readyApplication: EnvelopeReadyApplicationPort;
	reopenApplication: EnvelopeReopenApplicationPort;
	fieldStore: PostgresEnvelopeFieldStore;
	authoringFieldsRead: EnvelopeAuthoringFieldsReadPort;
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
 * store contains no request or actor state; every operation receives its
 * explicit instance actor context.
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

export function resolvePostgresEnvelopeReopenApplication(
	databaseUrl: string
): EnvelopeReopenApplicationPort {
	return resolvePostgresResources(databaseUrl).reopenApplication;
}

export function resolvePostgresEnvelopeAuthoringFieldsRead(
	databaseUrl: string
): EnvelopeAuthoringFieldsReadPort {
	return resolvePostgresResources(databaseUrl).authoringFieldsRead;
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
	documentPdf: (fieldPlacements: CompletionPdfEvidenceStore) => SentDocumentPdfPort
): EnvelopeSendApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new EnvelopeSendApplication(
		new PostgresEnvelopeSendStore(resources.sql),
		sealer,
		documentPdf(new PostgresCompletionPdfEvidenceStore(resources.sql))
	);
}

export function resolvePostgresEnvelopeSentPdfStore(
	databaseUrl: string
): PostgresEnvelopeSentPdfStore {
	return new PostgresEnvelopeSentPdfStore(resolvePostgresResources(databaseUrl).sql);
}

export function resolvePostgresEnvelopeSentDocumentStore(
	databaseUrl: string
): PostgresEnvelopeSentDocumentStore {
	return new PostgresEnvelopeSentDocumentStore(resolvePostgresResources(databaseUrl).sql);
}

export function resolvePostgresEnvelopeUploadedDocumentStore(
	databaseUrl: string
): PostgresEnvelopeUploadedDocumentStore {
	return new PostgresEnvelopeUploadedDocumentStore(resolvePostgresResources(databaseUrl).sql);
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

export function resolvePostgresRecipientCompletedReceiptApplication(
	databaseUrl: string
): RecipientCompletedReceiptApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new RecipientCompletedReceiptApplication(
		new PostgresRecipientCompletedReceiptStore(resources.sql)
	);
}

export function resolvePostgresRecipientApprovedApplication(
	databaseUrl: string
): RecipientApprovedApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new RecipientApprovedApplication(new PostgresRecipientApproveStore(resources.sql));
}

export function resolvePostgresRecipientSignedApplication(
	databaseUrl: string,
	signatureAssets: ObjectStore | null = null
): RecipientSignedApplicationPort {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new RecipientSignedApplication(
		new PostgresRecipientSignStore(resources.sql),
		undefined,
		undefined,
		signatureAssets,
		signatureAssets === null ? null : new PostgresSignatureAssetLedger(resources.sql)
	);
}

export function resolvePostgresSignatureAssetLedger(
	databaseUrl: string
): PostgresSignatureAssetLedger {
	return new PostgresSignatureAssetLedger(resolvePostgresResources(databaseUrl).sql);
}

export function resolvePostgresRecipientFieldDeclarationStore(
	databaseUrl: string
): PostgresRecipientFieldDeclarationStore {
	const resources: PostgresRuntimeResources = resolvePostgresResources(databaseUrl);
	return new PostgresRecipientFieldDeclarationStore(resources.sql);
}

function resolvePostgresResources(databaseUrl: string): PostgresRuntimeResources {
	// resolvePostgresSql owns URL validation, the pool singleton, and the
	// warm-process URL-change guard; this function only adds the heavier
	// envelope-specific application graph on top of that shared sql client.
	const sql: ReturnType<typeof postgres> = resolvePostgresSql(databaseUrl);

	if (cachedResources !== null) {
		return cachedResources;
	}

	const store: PostgresEnvelopeApplicationStore = new PostgresEnvelopeApplicationStore(sql);
	const application: EnvelopeApplicationPort = new EnvelopeApplication(store);
	const readyApplication: EnvelopeReadyApplicationPort = new EnvelopeReadyApplication(
		new PostgresEnvelopeReadyStore(sql)
	);
	const reopenApplication: EnvelopeReopenApplicationPort = new EnvelopeReopenApplication(
		new PostgresEnvelopeReopenStore(sql)
	);
	const fieldStore: PostgresEnvelopeFieldStore = new PostgresEnvelopeFieldStore(sql);
	const authoringFieldsRead: EnvelopeAuthoringFieldsReadPort = new EnvelopeAuthoringFieldsRead(
		fieldStore
	);
	const recipientAccessApplication: RecipientAccessApplicationPort = new RecipientAccessService(
		new PostgresRecipientAccessStore(sql)
	);
	cachedResources = {
		store,
		application,
		readyApplication,
		reopenApplication,
		fieldStore,
		authoringFieldsRead,
		recipientAccessApplication,
		sql
	};
	return cachedResources;
}
