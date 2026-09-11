import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { S3ObjectStore } from '$lib/adapters/object/s3';
import { IsomorphicGitDraftRepository } from '$lib/history/isomorphic-git-repository';
import {
	resolvePostgresEnvelopeStore,
	resolvePostgresRecipientAccessApplication,
	resolvePostgresRecipientFieldDeclarationStore
} from '$lib/application/envelopes/runtime-postgres';
import type { PostgresRecipientFieldDeclarationStore } from '$lib/adapters/db/postgres-recipient-field-declaration-store';
import { DraftPersistenceService, readImmutableDraftRevision } from './draft-persistence';
import {
	RecipientWorkspaceService,
	type RecipientWorkspaceApplicationPort
} from '$lib/application/signing/recipient-workspace';

export interface S3DraftRuntimeConfiguration {
	databaseUrl?: string;
	endpoint?: string;
	region?: string;
	bucket?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	forcePathStyle?: string;
}

interface ValidatedS3DraftRuntimeConfiguration {
	databaseUrl: string;
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
}

interface CachedS3Resources {
	configuration: ValidatedS3DraftRuntimeConfiguration;
	objects: S3ObjectStore;
}

let cachedS3Resources: CachedS3Resources | null = null;

export function resolveS3DraftPersistenceService(
	configuration: S3DraftRuntimeConfiguration
): DraftPersistenceService {
	const validated: ValidatedS3DraftRuntimeConfiguration = validateConfiguration(configuration);
	const resources: CachedS3Resources = resolveS3Resources(validated);

	return new DraftPersistenceService(
		resolvePostgresEnvelopeStore(validated.databaseUrl),
		resources.objects,
		new IsomorphicGitDraftRepository()
	);
}

export function resolveS3RecipientWorkspaceApplication(
	configuration: S3DraftRuntimeConfiguration
): RecipientWorkspaceApplicationPort {
	const validated: ValidatedS3DraftRuntimeConfiguration = validateConfiguration(configuration);
	const resources: CachedS3Resources = resolveS3Resources(validated);
	const repository: IsomorphicGitDraftRepository = new IsomorphicGitDraftRepository();
	const fields: PostgresRecipientFieldDeclarationStore =
		resolvePostgresRecipientFieldDeclarationStore(validated.databaseUrl);
	return new RecipientWorkspaceService(
		resolvePostgresRecipientAccessApplication(validated.databaseUrl),
		(revision) => readImmutableDraftRevision(revision, resources.objects, repository),
		(context) =>
			fields.listOwnFields(context.organizationId, context.envelopeId, context.recipientId)
	);
}

function resolveS3Resources(
	configuration: ValidatedS3DraftRuntimeConfiguration
): CachedS3Resources {
	if (cachedS3Resources !== null) {
		if (!sameConfiguration(cachedS3Resources.configuration, configuration)) {
			throw new Error('S3 configuration changed after runtime initialization');
		}
		return cachedS3Resources;
	}

	const clientConfiguration: S3ClientConfig = {
		endpoint: configuration.endpoint,
		region: configuration.region,
		forcePathStyle: configuration.forcePathStyle,
		credentials: {
			accessKeyId: configuration.accessKeyId,
			secretAccessKey: configuration.secretAccessKey
		}
	};
	const client: S3Client = new S3Client(clientConfiguration);
	cachedS3Resources = {
		configuration,
		objects: new S3ObjectStore(client, configuration.bucket)
	};
	return cachedS3Resources;
}

function validateConfiguration(
	configuration: S3DraftRuntimeConfiguration
): ValidatedS3DraftRuntimeConfiguration {
	const databaseUrl: string = required(configuration.databaseUrl, 'DATABASE_URL');
	const endpoint: string = required(configuration.endpoint, 'S3_ENDPOINT');
	const region: string = required(configuration.region, 'S3_REGION');
	const bucket: string = required(configuration.bucket, 'S3_BUCKET');
	const accessKeyId: string = required(configuration.accessKeyId, 'S3_ACCESS_KEY_ID');
	const secretAccessKey: string = required(configuration.secretAccessKey, 'S3_SECRET_ACCESS_KEY');

	let endpointUrl: URL;
	try {
		endpointUrl = new URL(endpoint);
	} catch {
		throw new Error('S3_ENDPOINT must be a valid URL');
	}
	if (endpointUrl.protocol !== 'https:' && !isLoopbackHttp(endpointUrl)) {
		throw new Error('S3_ENDPOINT must use HTTPS except for loopback development');
	}

	return {
		databaseUrl,
		endpoint: endpointUrl.toString(),
		region,
		bucket,
		accessKeyId,
		secretAccessKey,
		forcePathStyle: parseBoolean(configuration.forcePathStyle ?? 'true', 'S3_FORCE_PATH_STYLE')
	};
}

function required(value: string | undefined, name: string): string {
	const normalized: string = value?.trim() ?? '';
	if (normalized.length === 0) throw new Error(`${name} is required for S3 draft persistence`);
	return normalized;
}

function parseBoolean(value: string, name: string): boolean {
	const normalized: string = value.trim().toLowerCase();
	if (normalized === 'true') return true;
	if (normalized === 'false') return false;
	throw new Error(`${name} must be true or false`);
}

function isLoopbackHttp(url: URL): boolean {
	if (url.protocol !== 'http:') return false;
	const hostname: string = url.hostname.replace(/^\[|\]$/g, '');
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function sameConfiguration(
	left: ValidatedS3DraftRuntimeConfiguration,
	right: ValidatedS3DraftRuntimeConfiguration
): boolean {
	return (
		left.databaseUrl === right.databaseUrl &&
		left.endpoint === right.endpoint &&
		left.region === right.region &&
		left.bucket === right.bucket &&
		left.accessKeyId === right.accessKeyId &&
		left.secretAccessKey === right.secretAccessKey &&
		left.forcePathStyle === right.forcePathStyle
	);
}
