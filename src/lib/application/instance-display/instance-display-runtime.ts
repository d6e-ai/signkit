import { env } from '$env/dynamic/private';
import { D1InstanceDisplayStore } from '$lib/adapters/db/d1-instance-display-store';
import type { InstanceDisplayStore } from '$lib/ports/instance-display-store';
import { AesGcmInstanceDisplayPayloadSealer } from '$lib/security/instance-display-payload';
import {
	InstanceDisplayApplication,
	type InstanceDisplayApplicationPort
} from './instance-display-service';
import { InstanceDisplayMaintenanceService } from './instance-display-maintenance-service';

export interface InstanceDisplayRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveInstanceDisplayApplication(
	context: InstanceDisplayRuntimeContext
): Promise<InstanceDisplayApplicationPort | null> {
	const resolved = await resolveDisplayBindings(context);
	if (resolved === null) return null;
	return new InstanceDisplayApplication(resolved.store, resolved.sealer);
}

export async function resolveInstanceDisplayMaintenanceService(
	context: InstanceDisplayRuntimeContext
): Promise<InstanceDisplayMaintenanceService | null> {
	const resolved = await resolveDisplayBindings(context);
	if (resolved === null) return null;
	return new InstanceDisplayMaintenanceService(resolved.store, resolved.sealer);
}

export async function resolveInstanceDisplaySealer(
	context: InstanceDisplayRuntimeContext
): Promise<AesGcmInstanceDisplayPayloadSealer | null> {
	const encryptionKey: string | undefined = nonempty(
		context.platform?.env?.DELIVERY_ENCRYPTION_KEY ?? env.DELIVERY_ENCRYPTION_KEY
	);
	if (encryptionKey === undefined) return null;
	return new AesGcmInstanceDisplayPayloadSealer(
		encryptionKey,
		nonempty(
			context.platform?.env?.DELIVERY_ENCRYPTION_KEY_PREVIOUS ??
				env.DELIVERY_ENCRYPTION_KEY_PREVIOUS
		)
	);
}

async function resolveDisplayBindings(context: InstanceDisplayRuntimeContext): Promise<{
	store: InstanceDisplayStore;
	sealer: AesGcmInstanceDisplayPayloadSealer | null;
} | null> {
	const sealer: AesGcmInstanceDisplayPayloadSealer | null =
		await resolveInstanceDisplaySealer(context);
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return { store: new D1InstanceDisplayStore(database), sealer };
	}
	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const { resolvePostgresInstanceDisplayStore } = await import('./runtime-postgres');
	return { store: resolvePostgresInstanceDisplayStore(databaseUrl), sealer };
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
