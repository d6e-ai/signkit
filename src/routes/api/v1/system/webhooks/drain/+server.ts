import { resolveWebhookApplication } from '$lib/application/webhooks/webhook-runtime';
import { createWebhookDrainHandler } from '$lib/http/webhook-drain';

export const POST = createWebhookDrainHandler(resolveWebhookApplication);
