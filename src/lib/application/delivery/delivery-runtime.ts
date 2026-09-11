import { env } from '$env/dynamic/private';
import {
	CloudflareBindingMailSender,
	CloudflareRestMailSender
} from '$lib/adapters/mail/cloudflare-email';
import { AesGcmRecipientCapabilitySealer } from '$lib/security/delivery-capability';
import { DeliveryStatusService } from './delivery-status';
import { InvitationDeliveryService } from './delivery-service';

export interface InvitationDeliveryRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveInvitationDeliveryService(
	context: InvitationDeliveryRuntimeContext
): Promise<InvitationDeliveryService | null> {
	const configuration: DeliveryConfiguration | null = deliveryConfiguration(context.platform?.env);
	if (configuration === null) return null;
	const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(
		configuration.encryptionKey
	);

	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		const email: SendEmail | undefined = context.platform.env.EMAIL;
		if (database === undefined || email === undefined) return null;
		const { D1DeliveryOutboxStore } = await import('$lib/adapters/db/d1-delivery-outbox-store');
		return new InvitationDeliveryService(
			new D1DeliveryOutboxStore(database),
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
	const [{ PostgresDeliveryOutboxStore }, { resolvePostgresSql }] = await Promise.all([
		import('$lib/adapters/db/postgres-delivery-outbox-store'),
		import('$lib/application/envelopes/runtime-postgres')
	]);
	return new InvitationDeliveryService(
		new PostgresDeliveryOutboxStore(resolvePostgresSql(databaseUrl)),
		sealer,
		new CloudflareRestMailSender(accountId, apiToken),
		configuration.publicOrigin,
		{ fromEmail: configuration.fromEmail, fromName: configuration.fromName }
	);
}

export async function resolveDeliveryStatusService(
	context: InvitationDeliveryRuntimeContext
): Promise<DeliveryStatusService | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		const { D1DeliveryStatusStore } = await import('$lib/adapters/db/d1-delivery-status-store');
		return new DeliveryStatusService(new D1DeliveryStatusStore(database));
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const [{ PostgresDeliveryStatusStore }, { resolvePostgresSql }] = await Promise.all([
		import('$lib/adapters/db/postgres-delivery-status-store'),
		import('$lib/application/envelopes/runtime-postgres')
	]);
	return new DeliveryStatusService(
		new PostgresDeliveryStatusStore(resolvePostgresSql(databaseUrl))
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
