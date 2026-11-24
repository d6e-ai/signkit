import { env } from '$env/dynamic/private';
import { resolvePostgresSql } from '$lib/application/runtime/postgres-sql-runtime';
import { AesGcmInstanceInvitationDeliveryPayloadSealer } from '$lib/security/instance-invitation-delivery-payload';
import { consoleInvitationNotes } from '$lib/server/console-invitation-notes';
import { resolveConsoleUrl } from '$lib/server/console-url';
import { serverClientCredentials } from '$lib/server/d6e-auth';
import {
	InstanceInvitationDeliveryService,
	type InstanceInvitationNotifier
} from './instance-invitation-delivery-service';

export interface InstanceInvitationDeliveryRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/**
 * The invitation outbox drain. Each pending invitation is delivered to D6E
 * Auth as a console note, so it needs the durable store, the delivery
 * encryption key (to open the sealed recipient address), and the console
 * registration (console URL and client credentials). Without the registration
 * the drain is unavailable and claims nothing, so rows keep their attempts and
 * are delivered once the server is configured.
 */
export async function resolveInstanceInvitationDeliveryService(
	context: InstanceInvitationDeliveryRuntimeContext
): Promise<InstanceInvitationDeliveryService | null> {
	const platformEnv: Readonly<App.Platform>['env'] | undefined = context.platform?.env;
	const encryptionKey: string | undefined = nonempty(
		platformEnv?.DELIVERY_ENCRYPTION_KEY ?? env.DELIVERY_ENCRYPTION_KEY
	);
	if (encryptionKey === undefined) return null;
	if (resolveConsoleUrl(context.platform) === null || serverClientCredentials() === null) {
		return null;
	}
	const sealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(
		encryptionKey,
		nonempty(platformEnv?.DELIVERY_ENCRYPTION_KEY_PREVIOUS ?? env.DELIVERY_ENCRYPTION_KEY_PREVIOUS)
	);
	const notify: InstanceInvitationNotifier = (note) =>
		consoleInvitationNotes.note(note, { platform: context.platform });

	if (platformEnv !== undefined) {
		if (platformEnv.DB === undefined) return null;
		const { D1InstanceInvitationDeliveryStore } =
			await import('$lib/adapters/db/d1-instance-invitation-delivery-store');
		return new InstanceInvitationDeliveryService(
			new D1InstanceInvitationDeliveryStore(platformEnv.DB),
			sealer,
			notify
		);
	}

	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const { PostgresInstanceInvitationDeliveryStore } =
		await import('$lib/adapters/db/postgres-instance-invitation-delivery-store');
	return new InstanceInvitationDeliveryService(
		new PostgresInstanceInvitationDeliveryStore(resolvePostgresSql(databaseUrl)),
		sealer,
		notify
	);
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
