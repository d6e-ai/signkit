import {
	resolveEnvelopeAuthoringFieldsRead,
	resolveEnvelopeFieldApplication
} from '$lib/application/envelopes/fields-runtime';
import {
	createEnvelopeAuthoringFieldsHandler,
	createEnvelopeFieldsHandler
} from '$lib/http/envelope-fields';

export const GET = createEnvelopeAuthoringFieldsHandler(resolveEnvelopeAuthoringFieldsRead);
export const POST = createEnvelopeFieldsHandler(resolveEnvelopeFieldApplication);
