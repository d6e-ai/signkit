import { resolveEnvelopeReadyApplication } from '$lib/application/envelopes/ready-runtime';
import { createEnvelopeReadyHandler } from '$lib/http/envelope-ready';

export const POST = createEnvelopeReadyHandler(resolveEnvelopeReadyApplication);
