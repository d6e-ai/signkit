import { env } from '$env/dynamic/private';
import { D1PdfSealJobStore } from '$lib/adapters/db/d1-pdf-seal-job-store';
import { D1PdfSealPublicationStore } from '$lib/adapters/db/d1-pdf-seal-publication-store';
import { R2ObjectStore } from '$lib/adapters/object/r2';
import { RemotePdfSealProvider } from '$lib/adapters/pdf/remote-pdf-seal-provider';
import { RemotePdfSealValidator } from '$lib/adapters/pdf/remote-pdf-seal-validator';
import { MAX_SEALED_PDF_BYTES, type PdfSealJobStore } from '$lib/ports/pdf-seal-job-store';
import type { ObjectStore } from '$lib/ports/object-store';
import type { PdfSealPublicationStore } from '$lib/ports/pdf-seal-publication-store';
import type { PdfSealProfile, PdfSealProvider } from '$lib/ports/pdf-seal-provider';
import type { PdfSealValidator } from '$lib/ports/pdf-seal-validator';
import type { PdfSealAuthorizationTrust } from './pdf-seal-authorization';
import { PdfSealDrainService } from './pdf-seal-drain-service';
import { PdfSealService } from './pdf-seal-service';

const SHA256_PATTERN: RegExp = /^[a-f0-9]{64}$/;
const SAFE_POLICY_PATTERN: RegExp = /^[\x21-\x7e]{1,128}$/;
const BEARER_TOKEN_PATTERN: RegExp = /^[A-Za-z0-9\-._~+/]+=*$/;
const CONFIGURATION_KEYS = [
	'PDF_SEAL_PROFILE',
	'PDF_SEAL_PROVIDER_URL',
	'PDF_SEAL_PROVIDER_TOKEN',
	'PDF_SEAL_VALIDATOR_URL',
	'PDF_SEAL_VALIDATOR_TOKEN',
	'PDF_SEAL_SIGNER_CERTIFICATE_SHA256',
	'PDF_SEAL_POLICY_ID',
	'PDF_SEAL_VALIDATION_POLICY_ID',
	'PDF_SEAL_TSA_POLICY_ID',
	'PDF_SEAL_TSA_TRUST_BUNDLE_SHA256',
	'PDF_SEAL_AUTHORIZATION_ISSUER',
	'PDF_SEAL_AUTHORIZATION_AUDIENCE',
	'PDF_SEAL_AUTHORIZATION_PUBLIC_KEY'
] as const;
const AUTHORIZATION_KEYS = [
	'PDF_SEAL_AUTHORIZATION_ISSUER',
	'PDF_SEAL_AUTHORIZATION_AUDIENCE',
	'PDF_SEAL_AUTHORIZATION_PUBLIC_KEY'
] as const;
/** Raw uncompressed P-256 point, unpadded base64url. */
const AUTHORIZATION_PUBLIC_KEY_PATTERN: RegExp = /^B[A-Za-z0-9_-]{86}$/;

type PdfSealConfigurationKey = (typeof CONFIGURATION_KEYS)[number];
export type PdfSealRuntimeEnvironment = Partial<Record<PdfSealConfigurationKey, string>>;

export interface PdfSealRequestPolicy {
	requestedProfile: PdfSealProfile;
	signerCertificateSha256: string;
	sealPolicyId: string;
	validationPolicyId: string;
	tsaPolicyId: string | null;
	tsaTrustBundleSha256: string | null;
}

export interface PdfSealRuntimeConfiguration {
	providerUrl: string;
	providerToken: string;
	authorizationTrust: PdfSealAuthorizationTrust;
	validatorUrl: string;
	validatorToken: string;
	requestPolicy: PdfSealRequestPolicy;
}

export interface PdfSealRuntime {
	drainService: PdfSealDrainService;
	/** Frozen into jobs only by the later explicit request API; drains never enqueue. */
	requestPolicy: PdfSealRequestPolicy;
}

export interface PdfSealRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/** Detail-free by design: configuration values can include bearer secrets. */
export class PdfSealRuntimeConfigurationError extends Error {
	constructor() {
		super('pdf_seal_invalid_configuration');
		this.name = 'PdfSealRuntimeConfigurationError';
	}
}

export function parsePdfSealRuntimeConfiguration(
	values: PdfSealRuntimeEnvironment
): PdfSealRuntimeConfiguration | null {
	const isSet = (key: PdfSealConfigurationKey): boolean =>
		values[key] !== undefined && values[key] !== '';
	// Unset or legacy (no authorization tuple at all) stays disabled; a partial
	// tuple falls through and fails closed on the required checks below.
	if (!AUTHORIZATION_KEYS.some(isSet)) return null;
	const authorizationTrust: PdfSealAuthorizationTrust = {
		issuer: requiredTrimmed(values.PDF_SEAL_AUTHORIZATION_ISSUER),
		audience: requiredTrimmed(values.PDF_SEAL_AUTHORIZATION_AUDIENCE),
		publicKey: requiredPublicKey(values.PDF_SEAL_AUTHORIZATION_PUBLIC_KEY)
	};

	const profileValue: string = requiredTrimmed(values.PDF_SEAL_PROFILE);
	if (profileValue !== 'pades-b-b' && profileValue !== 'pades-b-t') invalidConfiguration();
	const providerUrl: string = requiredHttpsUrl(values.PDF_SEAL_PROVIDER_URL);
	const providerToken: string = requiredBearerToken(values.PDF_SEAL_PROVIDER_TOKEN);
	const validatorUrl: string = requiredHttpsUrl(values.PDF_SEAL_VALIDATOR_URL);
	const validatorToken: string = requiredBearerToken(values.PDF_SEAL_VALIDATOR_TOKEN);
	const signerCertificateSha256: string = requiredDigest(values.PDF_SEAL_SIGNER_CERTIFICATE_SHA256);
	const sealPolicyId: string = requiredPolicy(values.PDF_SEAL_POLICY_ID);
	const validationPolicyId: string = requiredPolicy(values.PDF_SEAL_VALIDATION_POLICY_ID);
	const tsaPolicyValue: string | undefined = optionalTrimmed(values.PDF_SEAL_TSA_POLICY_ID);
	const tsaTrustValue: string | undefined = optionalTrimmed(
		values.PDF_SEAL_TSA_TRUST_BUNDLE_SHA256
	);
	let tsaPolicyId: string | null = null;
	let tsaTrustBundleSha256: string | null = null;
	if (profileValue === 'pades-b-b') {
		if (tsaPolicyValue !== undefined || tsaTrustValue !== undefined) invalidConfiguration();
	} else {
		if (tsaPolicyValue === undefined || tsaTrustValue === undefined) invalidConfiguration();
		tsaPolicyId = requiredPolicy(tsaPolicyValue);
		tsaTrustBundleSha256 = requiredDigest(tsaTrustValue);
	}

	return {
		providerUrl,
		providerToken,
		authorizationTrust,
		validatorUrl,
		validatorToken,
		requestPolicy: {
			requestedProfile: profileValue,
			signerCertificateSha256,
			sealPolicyId,
			validationPolicyId,
			tsaPolicyId,
			tsaTrustBundleSha256
		}
	};
}

/**
 * Resolves only the public policy frozen by an explicit request. It does not
 * construct a provider, validator, object store, or worker drain, so API
 * reads can distinguish an intentionally disabled instance without opening
 * any remote connection.
 */
export function resolvePdfSealRequestPolicy(
	context: PdfSealRuntimeContext
): PdfSealRequestPolicy | null {
	const configuration: PdfSealRuntimeConfiguration | null = parsePdfSealRuntimeConfiguration(
		configurationEnvironment(context.platform?.env)
	);
	return configuration?.requestPolicy ?? null;
}

export async function resolvePdfSealRuntime(
	context: PdfSealRuntimeContext
): Promise<PdfSealRuntime | null> {
	const platformEnv = context.platform?.env;
	const configuration: PdfSealRuntimeConfiguration | null = parsePdfSealRuntimeConfiguration(
		configurationEnvironment(platformEnv)
	);
	if (configuration === null) return null;

	let jobs: PdfSealJobStore;
	let publications: PdfSealPublicationStore;
	let objects: ObjectStore;
	if (platformEnv !== undefined) {
		const database: D1Database | undefined = platformEnv.DB;
		const bucket: R2Bucket | undefined = platformEnv.OBJECTS;
		if (database === undefined || bucket === undefined) invalidConfiguration();
		jobs = new D1PdfSealJobStore(database);
		publications = new D1PdfSealPublicationStore(database);
		objects = new R2ObjectStore(bucket);
	} else {
		const databaseUrl: string | undefined = optionalTrimmed(env.DATABASE_URL);
		if (databaseUrl === undefined || !hasS3Configuration(env)) invalidConfiguration();
		const [jobAdapter, publicationAdapter, postgresRuntime, s3Runtime] = await Promise.all([
			import('$lib/adapters/db/postgres-pdf-seal-job-store'),
			import('$lib/adapters/db/postgres-pdf-seal-publication-store'),
			import('$lib/application/runtime/postgres-sql-runtime'),
			import('$lib/application/drafts/runtime-s3')
		]);
		const sql = postgresRuntime.resolvePostgresSql(databaseUrl);
		jobs = new jobAdapter.PostgresPdfSealJobStore(sql);
		publications = new publicationAdapter.PostgresPdfSealPublicationStore(sql);
		objects = s3Runtime.resolveS3ObjectStore({
			databaseUrl,
			endpoint: env.S3_ENDPOINT,
			region: env.S3_REGION,
			bucket: env.S3_BUCKET,
			accessKeyId: env.S3_ACCESS_KEY_ID,
			secretAccessKey: env.S3_SECRET_ACCESS_KEY,
			forcePathStyle: env.S3_FORCE_PATH_STYLE
		});
	}

	const providerService = platformEnv?.PDF_SEAL_PROVIDER_SERVICE;
	const validatorService = platformEnv?.PDF_SEAL_VALIDATOR_SERVICE;
	const provider: PdfSealProvider = new RemotePdfSealProvider({
		baseUrl: configuration.providerUrl,
		bearerToken: configuration.providerToken,
		authorizationTrust: configuration.authorizationTrust,
		maxResultBytes: MAX_SEALED_PDF_BYTES,
		fetch:
			providerService === undefined
				? undefined
				: (input, init) => providerService.fetch(input, init)
	});
	const validator: PdfSealValidator = new RemotePdfSealValidator({
		baseUrl: configuration.validatorUrl,
		bearerToken: configuration.validatorToken,
		maxSealedBytes: MAX_SEALED_PDF_BYTES,
		fetch:
			validatorService === undefined
				? undefined
				: (input, init) => validatorService.fetch(input, init)
	});
	const processor = new PdfSealService(jobs, objects, provider, validator);
	return {
		drainService: new PdfSealDrainService(processor, jobs, publications, objects),
		requestPolicy: configuration.requestPolicy
	};
}

function configurationEnvironment(
	platformEnv: Readonly<App.Platform>['env'] | undefined
): PdfSealRuntimeEnvironment {
	const values: PdfSealRuntimeEnvironment = {};
	for (const key of CONFIGURATION_KEYS) {
		const value: string | undefined = platformEnv === undefined ? env[key] : platformEnv[key];
		if (value !== undefined) values[key] = value;
	}
	return values;
}

function hasS3Configuration(values: Record<string, string | undefined>): boolean {
	return [
		values.S3_ENDPOINT,
		values.S3_REGION,
		values.S3_BUCKET,
		values.S3_ACCESS_KEY_ID,
		values.S3_SECRET_ACCESS_KEY,
		values.S3_FORCE_PATH_STYLE
	].some((value: string | undefined): boolean => value !== undefined && value.trim().length > 0);
}

function requiredExact(value: string | undefined): string {
	if (value === undefined || value.length === 0) invalidConfiguration();
	return value;
}

function requiredBearerToken(value: string | undefined): string {
	const exact: string = requiredExact(value);
	if (!BEARER_TOKEN_PATTERN.test(exact)) invalidConfiguration();
	return exact;
}

function requiredTrimmed(value: string | undefined): string {
	const normalized: string | undefined = optionalTrimmed(value);
	if (normalized === undefined) invalidConfiguration();
	return normalized;
}

function optionalTrimmed(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}

function requiredDigest(value: string | undefined): string {
	const normalized: string = requiredTrimmed(value);
	if (!SHA256_PATTERN.test(normalized)) invalidConfiguration();
	return normalized;
}

function requiredPublicKey(value: string | undefined): string {
	const normalized: string = requiredTrimmed(value);
	if (!AUTHORIZATION_PUBLIC_KEY_PATTERN.test(normalized)) invalidConfiguration();
	return normalized;
}

function requiredPolicy(value: string | undefined): string {
	const normalized: string = requiredTrimmed(value);
	if (!SAFE_POLICY_PATTERN.test(normalized)) invalidConfiguration();
	return normalized;
}

function requiredHttpsUrl(value: string | undefined): string {
	const normalized: string = requiredTrimmed(value);
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		invalidConfiguration();
	}
	if (
		parsed.protocol !== 'https:' ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0
	) {
		invalidConfiguration();
	}
	return normalized;
}

function invalidConfiguration(): never {
	throw new PdfSealRuntimeConfigurationError();
}
