import { resolveRecipientSentPdfApplication } from '$lib/application/signing/runtime';
import { createRecipientSentPdfHandler } from '$lib/http/recipient-sent-pdf';
import { unsealRecipientSession } from '$lib/server/recipient-session';

export const GET = createRecipientSentPdfHandler(
	resolveRecipientSentPdfApplication,
	unsealRecipientSession,
	'bearer'
);
