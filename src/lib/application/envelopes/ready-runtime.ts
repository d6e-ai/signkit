import { env } from '$env/dynamic/private';
import { D1EnvelopeReadyStore } from '$lib/adapters/db/d1-envelope-ready-store';
import { EnvelopeReadyApplication, type EnvelopeReadyApplicationPort } from './ready';

export interface EnvelopeReadyRuntimeContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export async function resolveEnvelopeReadyApplication(
	context: EnvelopeReadyRuntimeContext
): Promise<EnvelopeReadyApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new EnvelopeReadyApplication(new D1EnvelopeReadyStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl !== undefined && databaseUrl.trim().length > 0) {
		const { resolvePostgresEnvelopeReadyApplication } = await import('./runtime-postgres');
		return resolvePostgresEnvelopeReadyApplication(databaseUrl);
	}
	return null;
}
