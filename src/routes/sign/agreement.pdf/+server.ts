import { resolveRecipientSentPdfApplication } from '$lib/application/signing/runtime';
import { createRecipientSentPdfHandler } from '$lib/http/recipient-sent-pdf';
import { unsealRecipientSession } from '$lib/server/recipient-session';

/**
 * Same-origin, cookie-authenticated delivery of the sent agreement PDF.
 *
 * The path carries no token and no identifier, so it is safe in a print
 * dialog or a browser history entry: authority lives entirely in the
 * http-only recipient session cookie. The signing page reaches it with a
 * credentialed same-origin fetch and renders the bytes to a canvas; the
 * response refuses framing entirely.
 */
export const GET = createRecipientSentPdfHandler(
	resolveRecipientSentPdfApplication,
	unsealRecipientSession
);
