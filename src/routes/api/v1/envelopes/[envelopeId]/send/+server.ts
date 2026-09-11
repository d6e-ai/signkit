import { resolveEnvelopeSendApplication } from '$lib/application/envelopes/send-runtime';
import { createEnvelopeSendHandler } from '$lib/http/envelope-send';

export const POST = createEnvelopeSendHandler(resolveEnvelopeSendApplication);
