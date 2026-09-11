import { resolveEnvelopeFieldApplication } from '$lib/application/envelopes/fields-runtime';
import { createEnvelopeFieldsHandler } from '$lib/http/envelope-fields';

export const POST = createEnvelopeFieldsHandler(resolveEnvelopeFieldApplication);
