import { resolveWebhookApplication } from '$lib/application/webhooks/webhook-runtime';
import { createWebhookHttpHandlers, type WebhookHttpHandlers } from '$lib/http/webhooks';

const handlers: WebhookHttpHandlers = createWebhookHttpHandlers(resolveWebhookApplication);

export const POST = handlers.revoke;
