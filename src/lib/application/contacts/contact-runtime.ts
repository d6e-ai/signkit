import { env } from '$env/dynamic/private';
import { D1ContactStore } from '$lib/adapters/db/d1-contact-store';
import { ContactApplication, type ContactApplicationPort } from './contact-service';

export interface ContactRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveContactApplication(
	context: ContactRuntimeContext
): Promise<ContactApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		return database === undefined ? null : new ContactApplication(new D1ContactStore(database));
	}
	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresContactApplication } = await import('./runtime-postgres');
	return resolvePostgresContactApplication(databaseUrl);
}
