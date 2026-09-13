import { env } from '$env/dynamic/private';
import { D1RecipientCapabilityReissueStore } from '$lib/adapters/db/d1-recipient-capability-reissue-store';
import { AesGcmRecipientCapabilitySealer } from '$lib/security/delivery-capability';
import {
	RecipientCapabilityReissueApplication,
	type RecipientCapabilityReissueApplicationPort
} from '$lib/application/signing/recipient-capability-reissue';

export interface EnvelopeReissueRuntimeContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export async function resolveEnvelopeReissueApplication(
	context: EnvelopeReissueRuntimeContext
): Promise<RecipientCapabilityReissueApplicationPort | null> {
	const encodedKey: string | undefined = env.DELIVERY_ENCRYPTION_KEY;
	if (encodedKey === undefined || encodedKey.trim().length === 0) return null;
	const sealer: AesGcmRecipientCapabilitySealer = new AesGcmRecipientCapabilitySealer(encodedKey);
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new RecipientCapabilityReissueApplication(
			new D1RecipientCapabilityReissueStore(database),
			sealer
		);
	}
	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl !== undefined && databaseUrl.trim().length > 0) {
		const { resolvePostgresEnvelopeReissueApplication } = await import('./runtime-postgres');
		return resolvePostgresEnvelopeReissueApplication(databaseUrl, sealer);
	}
	return null;
}
