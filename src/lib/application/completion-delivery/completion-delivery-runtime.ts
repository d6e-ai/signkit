import { env } from '$env/dynamic/private';
import {
	CloudflareBindingMailSender,
	CloudflareRestMailSender
} from '$lib/adapters/mail/cloudflare-email';
import type { ObjectStore } from '$lib/ports/object-store';
import { AesGcmCompletionTokenSealer } from '$lib/security/completion-token-sealer';
import { CompletionDeliveryService } from './completion-delivery-service';
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
		const [{ D1CompletionDeliveryStore }, { R2ObjectStore }] = await Promise.all([
			import('$lib/adapters/db/d1-completion-delivery-store'),
			import('$lib/adapters/object/r2')
		]);
		return new PublicCompletionArtifactService(
			new D1CompletionDeliveryStore(database),
			new R2ObjectStore(bucket)
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
	const [{ PostgresCompletionDeliveryStore }, { resolvePostgresSql }, { resolveS3ObjectStore }] =
		await Promise.all([
			import('$lib/adapters/db/postgres-completion-delivery-store'),
			import('$lib/application/envelopes/runtime-postgres'),
			import('$lib/application/drafts/runtime-s3')
		]);
	const objects: ObjectStore = resolveS3ObjectStore({ databaseUrl, ...s3OnlyConfiguration });
	return new PublicCompletionArtifactService(
		new PostgresCompletionDeliveryStore(resolvePostgresSql(databaseUrl)),
		objects
	);
}

export async function resolveCompletionDeliveryService(
	context: CompletionDeliveryRuntimeContext
): Promise<CompletionDeliveryService | null> {
	const configuration: DeliveryConfiguration | null = deliveryConfiguration(context.platform?.env);
	if (configuration === null) return null;
	const sealer = new AesGcmCompletionTokenSealer(configuration.encryptionKey);

	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const email: SendEmail | undefined = context.platform.env.EMAIL;
		if (database === undefined || email === undefined) return null;
		const { D1CompletionDeliveryStore } =
			await import('$lib/adapters/db/d1-completion-delivery-store');
		return new CompletionDeliveryService(
			new D1CompletionDeliveryStore(database),
			sealer,
			new CloudflareBindingMailSender(email),
			configuration.publicOrigin,
			{ fromEmail: configuration.fromEmail, fromName: configuration.fromName }
		);
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	const accountId: string | undefined = nonempty(env.CLOUDFLARE_EMAIL_ACCOUNT_ID);
	const apiToken: string | undefined = nonempty(env.CLOUDFLARE_EMAIL_API_TOKEN);
	if (databaseUrl === undefined || accountId === undefined || apiToken === undefined) return null;
	const [{ PostgresCompletionDeliveryStore }, { resolvePostgresSql }] = await Promise.all([
		import('$lib/adapters/db/postgres-completion-delivery-store'),
		import('$lib/application/envelopes/runtime-postgres')
	]);
	return new CompletionDeliveryService(
		new PostgresCompletionDeliveryStore(resolvePostgresSql(databaseUrl)),
		sealer,
		new CloudflareRestMailSender(accountId, apiToken),
		configuration.publicOrigin,
		{ fromEmail: configuration.fromEmail, fromName: configuration.fromName }
	);
}

interface DeliveryConfiguration {
	encryptionKey: string;
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
	return { encryptionKey, publicOrigin, fromEmail, fromName };
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
