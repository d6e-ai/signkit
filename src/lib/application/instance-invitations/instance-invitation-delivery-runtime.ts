import { env } from '$env/dynamic/private';
import { resolvePostgresSql } from '$lib/application/runtime/postgres-sql-runtime';
import { AesGcmInstanceInvitationDeliveryPayloadSealer } from '$lib/security/instance-invitation-delivery-payload';
import { consoleInvitationNotes } from '$lib/server/console-invitation-notes';
import {
	InstanceInvitationDeliveryService,
	type InstanceInvitationNotifier
} from './instance-invitation-delivery-service';

export interface InstanceInvitationDeliveryRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/**
 * The invitation outbox drain. Each pending invitation is delivered to D6E
 * Auth as a console note; only the durable store and the delivery encryption
 * key (to open the sealed recipient address) are required here, and a server
 * without a console URL or client credentials keeps the rows for retry.
 */
export async function resolveInstanceInvitationDeliveryService(
	context: InstanceInvitationDeliveryRuntimeContext
): Promise<InstanceInvitationDeliveryService | null> {
	const platformEnv: Readonly<App.Platform>['env'] | undefined = context.platform?.env;
	const encryptionKey: string | undefined = nonempty(
		platformEnv?.DELIVERY_ENCRYPTION_KEY ?? env.DELIVERY_ENCRYPTION_KEY
	);
	if (encryptionKey === undefined) return null;
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
