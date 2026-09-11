import { env } from '$env/dynamic/private';
import { D1EnvelopeSendStore } from '$lib/adapters/db/d1-envelope-send-store';
import { AesGcmRecipientCapabilitySealer } from '$lib/security/delivery-capability';
import { EnvelopeSendApplication, type EnvelopeSendApplicationPort } from './send';

export interface EnvelopeSendRuntimeContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export async function resolveEnvelopeSendApplication(
	context: EnvelopeSendRuntimeContext
): Promise<EnvelopeSendApplicationPort | null> {
	const encodedKey: string | undefined = env.DELIVERY_ENCRYPTION_KEY;
	if (encodedKey === undefined || encodedKey.trim().length === 0) return null;
	const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(encodedKey);
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new EnvelopeSendApplication(new D1EnvelopeSendStore(database), sealer);
	}
	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl !== undefined && databaseUrl.trim().length > 0) {
		const { resolvePostgresEnvelopeSendApplication } = await import('./runtime-postgres');
		return resolvePostgresEnvelopeSendApplication(databaseUrl, sealer);
	}
	return null;
}
