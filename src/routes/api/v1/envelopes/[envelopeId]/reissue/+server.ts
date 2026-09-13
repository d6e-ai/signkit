import { resolveEnvelopeReissueApplication } from '$lib/application/envelopes/reissue-runtime';
import { createEnvelopeReissueHandler } from '$lib/http/envelope-reissue';

export const POST = createEnvelopeReissueHandler(resolveEnvelopeReissueApplication);
