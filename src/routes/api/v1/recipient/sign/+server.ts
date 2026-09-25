import { resolveRecipientSignedApplication } from '$lib/application/signing/runtime';
import { createRecipientSignedHandler } from '$lib/http/recipient-signed';
import { unsealRecipientSession } from '$lib/server/recipient-session';

export const POST = createRecipientSignedHandler(
	resolveRecipientSignedApplication,
	unsealRecipientSession,
	'bearer'
);
