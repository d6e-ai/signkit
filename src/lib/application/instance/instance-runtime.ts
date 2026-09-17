import { env } from '$env/dynamic/private';
import { D1InstanceStore } from '$lib/adapters/db/d1-instance-store';
import {
	InstanceInvitationApplication,
	type InstanceInvitationApplicationPort
} from '$lib/application/instance-invitations/instance-invitation-service';
import {
	InstanceMemberApplication,
	type InstanceMemberApplicationPort
} from '$lib/application/instance-members/instance-member-service';
import { InstanceApplication, type InstanceApplicationPort } from './instance-service';
import { AesGcmInstanceInvitationDeliveryPayloadSealer } from '$lib/security/instance-invitation-delivery-payload';

export interface InstanceRuntimeContext {
	platform?: Readonly<App.Platform>;
}

/**
 * Resolve instance application only for a durable store configured for the
 * active deployment target: the D1 binding on Cloudflare, otherwise PostgreSQL
 * from DATABASE_URL. The PostgreSQL path stays behind a dynamic import so the
 * Node driver is never pulled into the Worker bundle.
 */
export async function resolveInstanceApplication(
	context: InstanceRuntimeContext
): Promise<InstanceApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		return database === undefined ? null : new InstanceApplication(new D1InstanceStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresInstanceApplication } = await import('./runtime-postgres');
	return resolvePostgresInstanceApplication(databaseUrl);
}

/**
 * Resolve the instance invitation application only for a durable store
 * configured for the active deployment target: the D1 binding on Cloudflare,
 * otherwise PostgreSQL from DATABASE_URL. The PostgreSQL path stays behind a
 * dynamic import so the Node driver is never pulled into the Worker bundle.
 */
export async function resolveInstanceInvitationApplication(
	context: InstanceRuntimeContext
): Promise<InstanceInvitationApplicationPort | null> {
	const encryptionKey: string | undefined =
		context.platform?.env?.DELIVERY_ENCRYPTION_KEY ?? env.DELIVERY_ENCRYPTION_KEY;
	if (encryptionKey === undefined || encryptionKey.trim().length === 0) return null;
	const previousEncryptionKey: string | undefined =
		context.platform?.env?.DELIVERY_ENCRYPTION_KEY_PREVIOUS ?? env.DELIVERY_ENCRYPTION_KEY_PREVIOUS;
	const payloadSealer = new AesGcmInstanceInvitationDeliveryPayloadSealer(
		encryptionKey,
		previousEncryptionKey
	);
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		return database === undefined
			? null
			: new InstanceInvitationApplication({ store: new D1InstanceStore(database), payloadSealer });
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresInstanceInvitationApplication } = await import('./runtime-postgres');
	return resolvePostgresInstanceInvitationApplication(databaseUrl, payloadSealer);
}

/**
 * Resolve the instance member administration application only for a durable
 * store configured for the active deployment target: the D1 binding on
 * Cloudflare, otherwise PostgreSQL from DATABASE_URL. The PostgreSQL path
 * stays behind a dynamic import so the Node driver is never pulled into the
 * Worker bundle.
 */
export async function resolveInstanceMemberApplication(
	context: InstanceRuntimeContext
): Promise<InstanceMemberApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		return database === undefined
			? null
			: new InstanceMemberApplication(new D1InstanceStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresInstanceMemberApplication } = await import('./runtime-postgres');
	return resolvePostgresInstanceMemberApplication(databaseUrl);
}
