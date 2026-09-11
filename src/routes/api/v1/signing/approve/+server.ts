import { resolveRecipientApprovedApplication } from '$lib/application/signing/runtime';
import { createRecipientApprovedHandler } from '$lib/http/recipient-approved';
import { unsealRecipientSession } from '$lib/server/recipient-session';

export const POST = createRecipientApprovedHandler(
	resolveRecipientApprovedApplication,
	unsealRecipientSession
);
