import { env } from '$env/dynamic/private';
import { D1EnvelopeVoidStore } from '$lib/adapters/db/d1-envelope-void-store';
import { EnvelopeVoidApplication, type EnvelopeVoidApplicationPort } from './void';

export interface EnvelopeVoidRuntimeContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export async function resolveEnvelopeVoidApplication(
	context: EnvelopeVoidRuntimeContext
): Promise<EnvelopeVoidApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		return database === undefined
			? null
			: new EnvelopeVoidApplication(new D1EnvelopeVoidStore(database));
	}
	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresEnvelopeVoidApplication } = await import('./runtime-postgres');
	return resolvePostgresEnvelopeVoidApplication(databaseUrl);
}
