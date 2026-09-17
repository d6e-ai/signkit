import { env } from '$env/dynamic/private';
import { resolveNodeMailSender, resolveWorkerMailSender } from '$lib/application/mail/mail-runtime';
import { resolvePostgresSql } from '$lib/application/envelopes/runtime-postgres';
import type { MailSender } from '$lib/ports/mail-sender';
import { AesGcmInstanceInvitationDeliveryPayloadSealer } from '$lib/security/instance-invitation-delivery-payload';
import { InstanceInvitationDeliveryService } from './instance-invitation-delivery-service';

export interface InstanceInvitationDeliveryRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveInstanceInvitationDeliveryService(
	context: InstanceInvitationDeliveryRuntimeContext
): Promise<InstanceInvitationDeliveryService | null> {
	const platformEnv: Readonly<App.Platform>['env'] | undefined = context.platform?.env;
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
	)
		return null;
	const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(
		encryptionKey,
		nonempty(platformEnv?.DELIVERY_ENCRYPTION_KEY_PREVIOUS ?? env.DELIVERY_ENCRYPTION_KEY_PREVIOUS)
	);

	if (platformEnv !== undefined) {
		if (platformEnv.DB === undefined) return null;
		const mail: MailSender | null = await resolveWorkerMailSender(platformEnv, platformEnv.EMAIL);
		if (mail === null) return null;
		const { D1InstanceInvitationDeliveryStore } =
			await import('$lib/adapters/db/d1-instance-invitation-delivery-store');
		return new InstanceInvitationDeliveryService(
			new D1InstanceInvitationDeliveryStore(platformEnv.DB),
			sealer,
			mail,
			publicOrigin,
			{ fromEmail, fromName }
		);
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	const mail: MailSender | null = await resolveNodeMailSender(env);
	if (databaseUrl === undefined || mail === null) return null;
	const { PostgresInstanceInvitationDeliveryStore } =
		await import('$lib/adapters/db/postgres-instance-invitation-delivery-store');
	return new InstanceInvitationDeliveryService(
		new PostgresInstanceInvitationDeliveryStore(resolvePostgresSql(databaseUrl)),
		sealer,
		mail,
		publicOrigin,
		{ fromEmail, fromName }
	);
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
