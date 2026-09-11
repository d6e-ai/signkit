import { env } from '$env/dynamic/private';
import { D1RecipientAccessStore } from '$lib/adapters/db/d1-recipient-access-store';
import { D1RecipientApproveStore } from '$lib/adapters/db/d1-recipient-approve-store';
import { D1RecipientDeclineStore } from '$lib/adapters/db/d1-recipient-decline-store';
import { D1RecipientFieldDeclarationStore } from '$lib/adapters/db/d1-recipient-field-declaration-store';
import { D1RecipientSignStore } from '$lib/adapters/db/d1-recipient-sign-store';
import { D1RecipientViewStore } from '$lib/adapters/db/d1-recipient-view-store';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import { readImmutableDraftRevision } from '$lib/application/drafts/draft-persistence';
import { RecipientAccessService, type RecipientAccessApplicationPort } from './recipient-access';
import {
	RecipientWorkspaceService,
	type RecipientWorkspaceApplicationPort
} from './recipient-workspace';
import {
	RecipientViewedApplication,
	type RecipientViewedApplicationPort
} from './recipient-viewed';
import {
	RecipientDeclinedApplication,
	type RecipientDeclinedApplicationPort
} from './recipient-declined';
import {
	RecipientApprovedApplication,
	type RecipientApprovedApplicationPort
} from './recipient-approved';
import {
	RecipientSignedApplication,
	type RecipientSignedApplicationPort
} from './recipient-signed';

export interface RecipientAccessRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveRecipientAccessApplication(
	context: RecipientAccessRuntimeContext
): Promise<RecipientAccessApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new RecipientAccessService(new D1RecipientAccessStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresRecipientAccessApplication } =
		await import('$lib/application/envelopes/runtime-postgres');
	return resolvePostgresRecipientAccessApplication(databaseUrl);
}

export async function resolveRecipientWorkspaceApplication(
	context: RecipientAccessRuntimeContext
): Promise<RecipientWorkspaceApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const bucket: R2Bucket | undefined = context.platform.env.OBJECTS;
		if (database === undefined || bucket === undefined) return null;
		const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
		const objects: R2ObjectStore = new R2ObjectStore(bucket);
		const fields: D1RecipientFieldDeclarationStore = new D1RecipientFieldDeclarationStore(database);
		return new RecipientWorkspaceService(
			new RecipientAccessService(new D1RecipientAccessStore(database)),
			(revision) => readImmutableDraftRevision(revision, objects, repository),
			(context) =>
				fields.listOwnFields(context.organizationId, context.envelopeId, context.recipientId)
		);
	}

	const configuration = {
		databaseUrl: env.DATABASE_URL,
		endpoint: env.S3_ENDPOINT,
		region: env.S3_REGION,
		bucket: env.S3_BUCKET,
		accessKeyId: env.S3_ACCESS_KEY_ID,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY,
		forcePathStyle: env.S3_FORCE_PATH_STYLE
	};
	if (Object.values(configuration).every((value: string | undefined): boolean => !value?.trim())) {
		return null;
	}
	const { resolveS3RecipientWorkspaceApplication } =
		await import('$lib/application/drafts/runtime-s3');
	return resolveS3RecipientWorkspaceApplication(configuration);
}

export async function resolveRecipientViewedApplication(
	context: RecipientAccessRuntimeContext
): Promise<RecipientViewedApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new RecipientViewedApplication(
			new RecipientAccessService(new D1RecipientAccessStore(database)),
			new D1RecipientViewStore(database)
		);
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresRecipientViewedApplication } =
		await import('$lib/application/envelopes/runtime-postgres');
	return resolvePostgresRecipientViewedApplication(databaseUrl);
}

export async function resolveRecipientDeclinedApplication(
	context: RecipientAccessRuntimeContext
): Promise<RecipientDeclinedApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new RecipientDeclinedApplication(new D1RecipientDeclineStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresRecipientDeclinedApplication } =
		await import('$lib/application/envelopes/runtime-postgres');
	return resolvePostgresRecipientDeclinedApplication(databaseUrl);
}

export async function resolveRecipientApprovedApplication(
	context: RecipientAccessRuntimeContext
): Promise<RecipientApprovedApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new RecipientApprovedApplication(new D1RecipientApproveStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresRecipientApprovedApplication } =
		await import('$lib/application/envelopes/runtime-postgres');
	return resolvePostgresRecipientApprovedApplication(databaseUrl);
}

export async function resolveRecipientSignedApplication(
	context: RecipientAccessRuntimeContext
): Promise<RecipientSignedApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new RecipientSignedApplication(new D1RecipientSignStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresRecipientSignedApplication } =
		await import('$lib/application/envelopes/runtime-postgres');
	return resolvePostgresRecipientSignedApplication(databaseUrl);
}
