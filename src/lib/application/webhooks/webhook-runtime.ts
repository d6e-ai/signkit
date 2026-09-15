import { env } from '$env/dynamic/private';
import { D1WebhookStore } from '$lib/adapters/db/d1-webhook-store';
import {
	parseWebhookAllowedHosts,
	WEBHOOK_ALLOWED_HOSTS_ENV_VAR,
	type WebhookHostPolicy
} from '$lib/security/webhook-allowed-hosts';
import { AesGcmWebhookSigningSecretSealer } from '$lib/security/webhook-signing-secret';
import {
	WebhookApplication,
	type WebhookAllowedHostsResolver,
	type WebhookApplicationPort
} from './webhook-service';

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
	const allowedHostsResolver: WebhookAllowedHostsResolver = createWebhookAllowedHostsResolver(
		context.platform?.env
	);
	if (context.platform?.env !== undefined) {
		const database: D1Database | undefined = context.platform.env.DB;
		return database === undefined
			? null
			: new WebhookApplication(new D1WebhookStore(database), sealer, {
					allowedHostsResolver
				});
	}
	const databaseUrl: string | undefined = nonempty(env.DATABASE_URL);
	if (databaseUrl === undefined) return null;
	const { resolvePostgresWebhookApplication } = await import('./runtime-postgres');
	return resolvePostgresWebhookApplication(databaseUrl, sealer, allowedHostsResolver);
}

/**
 * Builds the deployer allowlist resolver for the application layer. The
 * resolver reads `SIGNKIT_WEBHOOK_ALLOWED_HOSTS` on every call so a changed
 * value takes effect on the next creation or delivery attempt without a
 * restart. Absent, blank, or invalid values resolve to `null`, which the
 * application treats as default-deny; diagnostics never echo the configured
 * value. Exported for focused runtime specs; production call sites go through
 * `resolveWebhookApplication`.
 */
export function createWebhookAllowedHostsResolver(
	platformEnv: Readonly<App.Platform>['env'] | undefined
): WebhookAllowedHostsResolver {
	return (): WebhookHostPolicy | null => {
		const raw: string | undefined =
			platformEnv?.[WEBHOOK_ALLOWED_HOSTS_ENV_VAR] ?? env[WEBHOOK_ALLOWED_HOSTS_ENV_VAR];
		try {
			return parseWebhookAllowedHosts(raw);
		} catch (error: unknown) {
			console.error(
				JSON.stringify({
					event: 'webhook_allowed_hosts_invalid',
					message: error instanceof Error ? error.message : 'UnknownError'
				})
			);
			return null;
		}
	};
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
