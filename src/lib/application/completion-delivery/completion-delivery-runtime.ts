import { env } from '$env/dynamic/private';
import { resolveNodeMailSender, resolveWorkerMailSender } from '$lib/application/mail/mail-runtime';
import type { MailSender } from '$lib/ports/mail-sender';
import type { ObjectStore } from '$lib/ports/object-store';
import { AesGcmCompletionTokenSealer } from '$lib/security/completion-token-sealer';
import { CompletionDeliveryResealSweepService } from './completion-reseal-sweep-service';
import { CompletionDeliveryService } from './completion-delivery-service';
import {
	CompletionPdfAttachmentReader,
	MissingCompletionPdfAttachmentReader,
	type CompletionPdfAttachmentReaderPort
} from './completion-pdf-attachment-reader';
import { PublicCompletionArtifactService } from './public-completion-artifact';

export interface CompletionDeliveryRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolvePublicCompletionArtifactService(
	context: CompletionDeliveryRuntimeContext
): Promise<PublicCompletionArtifactService | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const bucket: R2Bucket | undefined = context.platform.env.OBJECTS;
		if (database === undefined || bucket === undefined) return null;
		const [{ D1CompletionDeliveryStore }, { D1CompletionArtifactPdfStore }, { R2ObjectStore }] =
			await Promise.all([
				import('$lib/adapters/db/d1-completion-delivery-store'),
				import('$lib/adapters/db/d1-completion-artifact-pdf-store'),
				import('$lib/adapters/object/r2')
			]);
		return new PublicCompletionArtifactService(
			new D1CompletionDeliveryStore(database),
			new R2ObjectStore(bucket),
			new D1CompletionArtifactPdfStore(database)
		);
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const s3OnlyConfiguration = {
		endpoint: env.S3_ENDPOINT,
		region: env.S3_REGION,
		bucket: env.S3_BUCKET,
		accessKeyId: env.S3_ACCESS_KEY_ID,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY,
		forcePathStyle: env.S3_FORCE_PATH_STYLE
	};
	if (
		Object.values(s3OnlyConfiguration).every((value: string | undefined): boolean => !value?.trim())
	) {
		return null;
	}
	const [
		{ PostgresCompletionDeliveryStore },
		{ PostgresCompletionArtifactPdfStore },
		{ resolvePostgresSql },
		{ resolveS3ObjectStore }
	] = await Promise.all([
		import('$lib/adapters/db/postgres-completion-delivery-store'),
		import('$lib/adapters/db/postgres-completion-artifact-pdf-store'),
		import('$lib/application/envelopes/runtime-postgres'),
		import('$lib/application/drafts/runtime-s3')
	]);
	let objects: ObjectStore;
	try {
		objects = resolveS3ObjectStore({ databaseUrl, ...s3OnlyConfiguration });
	} catch {
		// Partial or invalid storage configuration (for example, a leftover
		// S3_FORCE_PATH_STYLE with no other S3 variable set) must resolve to
		// "not configured" rather than throwing out of this resolver.
		return null;
	}
	return new PublicCompletionArtifactService(
		new PostgresCompletionDeliveryStore(resolvePostgresSql(databaseUrl)),
		objects,
		new PostgresCompletionArtifactPdfStore(resolvePostgresSql(databaseUrl))
	);
}

export async function resolveCompletionDeliveryService(
	context: CompletionDeliveryRuntimeContext
): Promise<CompletionDeliveryService | null> {
	const configuration: DeliveryConfiguration | null = deliveryConfiguration(context.platform?.env);
	if (configuration === null) return null;
	const sealer = new AesGcmCompletionTokenSealer(
		configuration.encryptionKey,
		configuration.previousEncryptionKey
	);

	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const mailSender: MailSender | null = await resolveWorkerMailSender(
			context.platform.env,
			context.platform.env.EMAIL
		);
		if (database === undefined || mailSender === null) return null;
		const { D1CompletionDeliveryStore } =
			await import('$lib/adapters/db/d1-completion-delivery-store');
		const pdfAttachmentReader: CompletionPdfAttachmentReaderPort =
			await resolveWorkerCompletionPdfAttachmentReader(context.platform.env, database);
		return new CompletionDeliveryService(
			new D1CompletionDeliveryStore(database),
			sealer,
			mailSender,
			configuration.publicOrigin,
			{ fromEmail: configuration.fromEmail, fromName: configuration.fromName },
			undefined,
			undefined,
			undefined,
			pdfAttachmentReader
		);
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	const mailSender: MailSender | null = await resolveNodeMailSender(env);
	if (databaseUrl === undefined || mailSender === null) return null;
	const [{ PostgresCompletionDeliveryStore }, { resolvePostgresSql }] = await Promise.all([
		import('$lib/adapters/db/postgres-completion-delivery-store'),
		import('$lib/application/envelopes/runtime-postgres')
	]);
	const pdfAttachmentReader: CompletionPdfAttachmentReaderPort =
		await resolveNodeCompletionPdfAttachmentReader(databaseUrl);
	return new CompletionDeliveryService(
		new PostgresCompletionDeliveryStore(resolvePostgresSql(databaseUrl)),
		sealer,
		mailSender,
		configuration.publicOrigin,
		{ fromEmail: configuration.fromEmail, fromName: configuration.fromName },
		undefined,
		undefined,
		undefined,
		pdfAttachmentReader
	);
}

/**
 * No new required secret or provider: a bucket-less D1 deployment (no
 * `OBJECTS` binding) does not need R2 to run completion delivery at all. But
 * once this attachment feature is live, that gap must not be mistaken for
 * "PDF not published yet" — a `MissingCompletionPdfAttachmentReader` fails
 * every read closed as retryable, so completion delivery surfaces the missing
 * configuration as an operational failure rather than silently sending
 * link-only mail forever.
 */
async function resolveWorkerCompletionPdfAttachmentReader(
	workerEnv: Readonly<App.Platform>['env'],
	database: D1Database
): Promise<CompletionPdfAttachmentReaderPort> {
	const bucket: R2Bucket | undefined = workerEnv?.OBJECTS;
	if (bucket === undefined) return new MissingCompletionPdfAttachmentReader();
	const [{ D1CompletionArtifactPdfStore }, { R2ObjectStore }] = await Promise.all([
		import('$lib/adapters/db/d1-completion-artifact-pdf-store'),
		import('$lib/adapters/object/r2')
	]);
	return new CompletionPdfAttachmentReader(
		new D1CompletionArtifactPdfStore(database),
		new R2ObjectStore(bucket)
	);
}

/** Mirrors `resolveWorkerCompletionPdfAttachmentReader`: no S3 configuration fails closed as retryable, never link-only. */
async function resolveNodeCompletionPdfAttachmentReader(
	databaseUrl: string
): Promise<CompletionPdfAttachmentReaderPort> {
	const s3OnlyConfiguration = {
		endpoint: env.S3_ENDPOINT,
		region: env.S3_REGION,
		bucket: env.S3_BUCKET,
		accessKeyId: env.S3_ACCESS_KEY_ID,
		secretAccessKey: env.S3_SECRET_ACCESS_KEY,
		forcePathStyle: env.S3_FORCE_PATH_STYLE
	};
	if (
		Object.values(s3OnlyConfiguration).every((value: string | undefined): boolean => !value?.trim())
	) {
		return new MissingCompletionPdfAttachmentReader();
	}
	const [
		{ PostgresCompletionArtifactPdfStore },
		{ resolvePostgresSql: resolveSql },
		{ resolveS3ObjectStore }
	] = await Promise.all([
		import('$lib/adapters/db/postgres-completion-artifact-pdf-store'),
		import('$lib/application/envelopes/runtime-postgres'),
		import('$lib/application/drafts/runtime-s3')
	]);
	let objects: ObjectStore;
	try {
		objects = resolveS3ObjectStore({ databaseUrl, ...s3OnlyConfiguration });
	} catch {
		// Partial or invalid storage configuration must enter durable retry
		// handling, not abort the whole drain before deliveries are claimed.
		return new MissingCompletionPdfAttachmentReader();
	}
	return new CompletionPdfAttachmentReader(
		new PostgresCompletionArtifactPdfStore(resolveSql(databaseUrl)),
		objects
	);
}

export async function resolveCompletionDeliveryResealSweepService(
	context: CompletionDeliveryRuntimeContext
): Promise<CompletionDeliveryResealSweepService | null> {
	const encryptionKey: string | undefined = nonempty(
		context.platform?.env?.DELIVERY_ENCRYPTION_KEY ?? env.DELIVERY_ENCRYPTION_KEY
	);
	if (encryptionKey === undefined) return null;
	const previousEncryptionKey: string | undefined = nonempty(
		context.platform?.env?.DELIVERY_ENCRYPTION_KEY_PREVIOUS ?? env.DELIVERY_ENCRYPTION_KEY_PREVIOUS
	);
	const sealer = new AesGcmCompletionTokenSealer(encryptionKey, previousEncryptionKey);

	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		const { D1CompletionDeliveryStore } =
			await import('$lib/adapters/db/d1-completion-delivery-store');
		return new CompletionDeliveryResealSweepService(
			new D1CompletionDeliveryStore(database),
			sealer
		);
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const [{ PostgresCompletionDeliveryStore }, { resolvePostgresSql }] = await Promise.all([
		import('$lib/adapters/db/postgres-completion-delivery-store'),
		import('$lib/application/envelopes/runtime-postgres')
	]);
	return new CompletionDeliveryResealSweepService(
		new PostgresCompletionDeliveryStore(resolvePostgresSql(databaseUrl)),
		sealer
	);
}

interface DeliveryConfiguration {
	encryptionKey: string;
	previousEncryptionKey: string | undefined;
	publicOrigin: string;
	fromEmail: string;
	fromName: string;
}

function deliveryConfiguration(
	platformEnv: Readonly<App.Platform>['env'] | undefined
): DeliveryConfiguration | null {
	const encryptionKey: string | undefined = nonempty(
		platformEnv?.DELIVERY_ENCRYPTION_KEY ?? env.DELIVERY_ENCRYPTION_KEY
	);
	const previousEncryptionKey: string | undefined = nonempty(
		platformEnv?.DELIVERY_ENCRYPTION_KEY_PREVIOUS ?? env.DELIVERY_ENCRYPTION_KEY_PREVIOUS
	);
	const publicOrigin: string | undefined = nonempty(
		platformEnv?.SIGNKIT_PUBLIC_ORIGIN ?? env.SIGNKIT_PUBLIC_ORIGIN
	);
	const fromEmail: string | undefined = nonempty(
		platformEnv?.SIGNKIT_EMAIL_FROM ?? env.SIGNKIT_EMAIL_FROM
	);
	const fromName: string | undefined = nonempty(
		platformEnv?.SIGNKIT_EMAIL_FROM_NAME ?? env.SIGNKIT_EMAIL_FROM_NAME
	);
	if (
		encryptionKey === undefined ||
		publicOrigin === undefined ||
		fromEmail === undefined ||
		fromName === undefined
	) {
		return null;
	}
	return { encryptionKey, previousEncryptionKey, publicOrigin, fromEmail, fromName };
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
