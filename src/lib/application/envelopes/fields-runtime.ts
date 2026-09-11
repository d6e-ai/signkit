import { env } from '$env/dynamic/private';
import { resolveDraftPersistenceService } from '$lib/application/drafts/runtime';
import type { DraftPersistenceService } from '$lib/application/drafts/draft-persistence';
import { D1EnvelopeFieldStore } from '$lib/adapters/db/d1-envelope-field-store';
import { EnvelopeFieldApplication, type EnvelopeFieldApplicationPort } from './fields';

export interface EnvelopeFieldRuntimeContext {
	locals: App.Locals;
	platform?: Readonly<App.Platform>;
}

export async function resolveEnvelopeFieldApplication(
	context: EnvelopeFieldRuntimeContext
): Promise<EnvelopeFieldApplicationPort | null> {
	const drafts: DraftPersistenceService | null = await resolveDraftPersistenceService(context);
	if (drafts === null) return null;

	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		if (database === undefined) return null;
		return new EnvelopeFieldApplication(new D1EnvelopeFieldStore(database), drafts);
	}

	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl !== undefined && databaseUrl.trim().length > 0) {
		const { resolvePostgresEnvelopeFieldApplication } = await import('./runtime-postgres');
		return resolvePostgresEnvelopeFieldApplication(databaseUrl, drafts);
	}
	return null;
}
