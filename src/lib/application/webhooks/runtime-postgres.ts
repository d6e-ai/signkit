import { PostgresWebhookStore } from '$lib/adapters/db/postgres-webhook-store';
import { resolvePostgresSql } from '$lib/application/envelopes/runtime-postgres';
import { WebhookApplication, type WebhookApplicationPort } from './webhook-service';

export function resolvePostgresWebhookApplication(databaseUrl: string): WebhookApplicationPort {
	return new WebhookApplication(new PostgresWebhookStore(resolvePostgresSql(databaseUrl)));
}
