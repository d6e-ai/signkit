import { resolveEnvelopeVoidApplication } from '$lib/application/envelopes/void-runtime';
import { createEnvelopeVoidHandler } from '$lib/http/envelope-void';

export const POST = createEnvelopeVoidHandler(resolveEnvelopeVoidApplication);
