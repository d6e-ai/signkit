import { env } from '$env/dynamic/private';
import { resolveNodeMailSender, resolveWorkerMailSender } from '$lib/application/mail/mail-runtime';
import type { MailSender } from '$lib/ports/mail-sender';
import { AesGcmRecipientCapabilitySealer } from '$lib/security/delivery-capability';
import { DeliveryStatusService } from './delivery-status';
import { InvitationDeliveryService } from './delivery-service';
import { DeliveryResealSweepService } from './reseal-sweep-service';

export interface InvitationDeliveryRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveInvitationDeliveryService(
	context: InvitationDeliveryRuntimeContext
): Promise<InvitationDeliveryService | null> {
	const configuration: DeliveryConfiguration | null = deliveryConfiguration(context.platform?.env);
	if (configuration === null) return null;
	const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(
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
		const { D1DeliveryOutboxStore } = await import('$lib/adapters/db/d1-delivery-outbox-store');
		return new InvitationDeliveryService(
			new D1DeliveryOutboxStore(database),
			sealer,
			mailSender,
			configuration.publicOrigin,
			{ fromEmail: configuration.fromEmail, fromName: configuration.fromName }
		);
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	const mailSender: MailSender | null = await resolveNodeMailSender(env);
	if (databaseUrl === undefined || mailSender === null) return null;
	const [{ PostgresDeliveryOutboxStore }, { resolvePostgresSql }] = await Promise.all([
		import('$lib/adapters/db/postgres-delivery-outbox-store'),
		import('$lib/application/envelopes/runtime-postgres')
	]);
	return new InvitationDeliveryService(
		new PostgresDeliveryOutboxStore(resolvePostgresSql(databaseUrl)),
		sealer,
		mailSender,
		configuration.publicOrigin,
		{ fromEmail: configuration.fromEmail, fromName: configuration.fromName }
	);
}

export async function resolveDeliveryResealSweepService(
	context: InvitationDeliveryRuntimeContext
): Promise<DeliveryResealSweepService | null> {
	const encryptionKey: string | undefined = nonempty(
		context.platform?.env?.DELIVERY_ENCRYPTION_KEY ?? env.DELIVERY_ENCRYPTION_KEY
	);
	if (encryptionKey === undefined) return null;
	const previousEncryptionKey: string | undefined = nonempty(
		context.platform?.env?.DELIVERY_ENCRYPTION_KEY_PREVIOUS ?? env.DELIVERY_ENCRYPTION_KEY_PREVIOUS
	);
	const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(
		encryptionKey,
		previousEncryptionKey
	);

	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		const { D1DeliveryOutboxStore } = await import('$lib/adapters/db/d1-delivery-outbox-store');
		return new DeliveryResealSweepService(new D1DeliveryOutboxStore(database), sealer);
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const [{ PostgresDeliveryOutboxStore }, { resolvePostgresSql }] = await Promise.all([
		import('$lib/adapters/db/postgres-delivery-outbox-store'),
		import('$lib/application/envelopes/runtime-postgres')
	]);
	return new DeliveryResealSweepService(
		new PostgresDeliveryOutboxStore(resolvePostgresSql(databaseUrl)),
		sealer
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
	// Optional: the retiring key, kept only long enough for the bounded
	// reseal sweep to migrate outstanding ciphertext onto the active key.
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
