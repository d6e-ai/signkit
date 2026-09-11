import { env } from '$env/dynamic/private';
import { D1RecipientAccessStore } from '$lib/adapters/db/d1-recipient-access-store';
import { RecipientAccessService, type RecipientAccessApplicationPort } from './recipient-access';

export interface RecipientAccessRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveRecipientAccessApplication(
	context: RecipientAccessRuntimeContext
): Promise<RecipientAccessApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new RecipientAccessService(new D1RecipientAccessStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresRecipientAccessApplication } =
		await import('$lib/application/envelopes/runtime-postgres');
	return resolvePostgresRecipientAccessApplication(databaseUrl);
}
