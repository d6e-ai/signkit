import { resolveEnvelopeApplication } from '$lib/application/envelopes/runtime';
import { createEnvelopeHttpHandlers, type EnvelopeHttpHandlers } from '$lib/http/envelopes';

const handlers: EnvelopeHttpHandlers = createEnvelopeHttpHandlers(resolveEnvelopeApplication);

export const GET = handlers.list;
export const POST = handlers.create;
