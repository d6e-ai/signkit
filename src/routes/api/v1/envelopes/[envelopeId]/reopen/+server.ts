import { resolveEnvelopeReopenApplication } from '$lib/application/envelopes/reopen-runtime';
import { createEnvelopeReopenHandler } from '$lib/http/envelope-reopen';

export const POST = createEnvelopeReopenHandler(resolveEnvelopeReopenApplication);
