import { env } from '$env/dynamic/private';
import { D1WebhookStore } from '$lib/adapters/db/d1-webhook-store';
import { WebhookApplication, type WebhookApplicationPort } from './webhook-service';

export interface WebhookRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveWebhookApplication(
	context: WebhookRuntimeContext
): Promise<WebhookApplicationPort | null> {
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		return database === undefined ? null : new WebhookApplication(new D1WebhookStore(database));
	}
	const databaseUrl: string | undefined = env.DATABASE_URL;
	if (databaseUrl === undefined || databaseUrl.trim().length === 0) return null;
	const { resolvePostgresWebhookApplication } = await import('./runtime-postgres');
	return resolvePostgresWebhookApplication(databaseUrl);
}
