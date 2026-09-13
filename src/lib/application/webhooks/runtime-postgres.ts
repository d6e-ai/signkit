import { PostgresWebhookStore } from '$lib/adapters/db/postgres-webhook-store';
import { resolvePostgresSql } from '$lib/application/envelopes/runtime-postgres';
import type { WebhookSigningSecretSealer } from '$lib/security/webhook-signing-secret';
import { WebhookApplication, type WebhookApplicationPort } from './webhook-service';

export function resolvePostgresWebhookApplication(
	databaseUrl: string,
	sealer: WebhookSigningSecretSealer
): WebhookApplicationPort {
	return new WebhookApplication(new PostgresWebhookStore(resolvePostgresSql(databaseUrl)), sealer);
}
