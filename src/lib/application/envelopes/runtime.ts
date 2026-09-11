import { env } from '$env/dynamic/private';
import { D1EnvelopeApplicationStore } from '$lib/adapters/db/d1-envelope-application-store';
import { EnvelopeApplication } from './service';
import type { EnvelopeApplicationPort } from './model';

export interface EnvelopeRuntimeContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

/** Resolve only durable stores configured for the active deployment target. */
export async function resolveEnvelopeApplication(
	context: EnvelopeRuntimeContext
): Promise<EnvelopeApplicationPort | null> {
	const database: D1Database | undefined = context.platform?.env?.DB;
	if (database !== undefined) {
		return new EnvelopeApplication(new D1EnvelopeApplicationStore(database));
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl !== undefined && databaseUrl.trim().length > 0) {
		const { resolvePostgresEnvelopeApplication } = await import('./runtime-postgres');
		return resolvePostgresEnvelopeApplication(databaseUrl);
	}

	return null;
}
