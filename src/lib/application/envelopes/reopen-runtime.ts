import { env } from '$env/dynamic/private';
import { D1EnvelopeReopenStore } from '$lib/adapters/db/d1-envelope-reopen-store';
import { EnvelopeReopenApplication, type EnvelopeReopenApplicationPort } from './reopen';

export interface EnvelopeReopenRuntimeContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export async function resolveEnvelopeReopenApplication(
	context: EnvelopeReopenRuntimeContext
): Promise<EnvelopeReopenApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new EnvelopeReopenApplication(new D1EnvelopeReopenStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl !== undefined && databaseUrl.trim().length > 0) {
		const { resolvePostgresEnvelopeReopenApplication } = await import('./runtime-postgres');
		return resolvePostgresEnvelopeReopenApplication(databaseUrl);
	}
	return null;
}
