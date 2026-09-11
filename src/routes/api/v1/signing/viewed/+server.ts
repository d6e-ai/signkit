import { resolveRecipientViewedApplication } from '$lib/application/signing/runtime';
import { createRecipientViewedHandler } from '$lib/http/recipient-viewed';
import { unsealRecipientSession } from '$lib/server/recipient-session';

export const POST = createRecipientViewedHandler(
	resolveRecipientViewedApplication,
	unsealRecipientSession
);
