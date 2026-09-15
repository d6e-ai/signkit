import { resolveRecipientSentPdfApplication } from '$lib/application/signing/runtime';
import { createRecipientSentPdfHandler } from '$lib/http/recipient-sent-pdf';
import { unsealRecipientSession } from '$lib/server/recipient-session';

/**
 * Same-origin, cookie-authenticated delivery of one sent document PDF.
 *
 * The path names the non-secret UUIDv7 envelope ID and document ID so the
 * signing page can switch documents without putting a capability in the URL.
 * Authority still lives entirely in the envelope-scoped http-only recipient
 * session cookie. A path/cookie mismatch or a document ID outside the pinned
 * set fails closed as an opaque 404.
 */
export const GET = createRecipientSentPdfHandler(
	resolveRecipientSentPdfApplication,
	unsealRecipientSession
);
