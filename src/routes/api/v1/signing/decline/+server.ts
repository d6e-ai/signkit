import { resolveRecipientDeclinedApplication } from '$lib/application/signing/runtime';
import { createRecipientDeclinedHandler } from '$lib/http/recipient-declined';
import { unsealRecipientSession } from '$lib/server/recipient-session';

export const POST = createRecipientDeclinedHandler(
	resolveRecipientDeclinedApplication,
	unsealRecipientSession
);
