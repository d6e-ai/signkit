import { resolveRecipientSentPdfApplication } from '$lib/application/signing/runtime';
import { createRecipientSentPdfHandler } from '$lib/http/recipient-sent-pdf';
import { unsealRecipientSession } from '$lib/server/recipient-session';

/**
 * Same-origin, cookie-authenticated delivery of the sent agreement PDF.
 *
 * The path names the non-secret UUIDv7 envelope ID so two tabs can request
 * different documents. Authority still lives entirely in the envelope-scoped
 * http-only recipient session cookie: no capability token appears in the URL,
 * in page data, or anywhere JavaScript can read it. A path/cookie mismatch
 * fails closed. The signing page reaches it with a credentialed same-origin
 * fetch and renders the bytes to a canvas; the response refuses framing
 * entirely.
 */
export const GET = createRecipientSentPdfHandler(
	resolveRecipientSentPdfApplication,
	unsealRecipientSession
);
