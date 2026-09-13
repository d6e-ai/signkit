import { env } from '$env/dynamic/private';
import { D1WebhookStore } from '$lib/adapters/db/d1-webhook-store';
import { AesGcmWebhookSigningSecretSealer } from '$lib/security/webhook-signing-secret';
import { WebhookApplication, type WebhookApplicationPort } from './webhook-service';

export interface WebhookRuntimeContext {
	platform?: Readonly<App.Platform>;
}

export async function resolveWebhookApplication(
	context: WebhookRuntimeContext
): Promise<WebhookApplicationPort | null> {
	const sealer: AesGcmWebhookSigningSecretSealer | null = webhookSigningSecretSealer(
		context.platform?.env
	);
	if (sealer === null) return null;
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		return database === undefined
			? null
			: new WebhookApplication(new D1WebhookStore(database), sealer);
	}
	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const { resolvePostgresWebhookApplication } = await import('./runtime-postgres');
	return resolvePostgresWebhookApplication(databaseUrl, sealer);
}

function webhookSigningSecretSealer(
	platformEnv: Readonly<App.Platform>['env'] | undefined
): AesGcmWebhookSigningSecretSealer | null {
	const encryptionKey: string | undefined = nonempty(
		platformEnv?.DELIVERY_ENCRYPTION_KEY ?? env.DELIVERY_ENCRYPTION_KEY
	);
	if (encryptionKey === undefined) return null;
	const previousEncryptionKey: string | undefined = nonempty(
		platformEnv?.DELIVERY_ENCRYPTION_KEY_PREVIOUS ?? env.DELIVERY_ENCRYPTION_KEY_PREVIOUS
	);
	return new AesGcmWebhookSigningSecretSealer(encryptionKey, previousEncryptionKey);
}

function nonempty(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized: string = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}
