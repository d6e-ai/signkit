import { resolveSignatureAssetApplication } from '$lib/application/signing/runtime';
import { createSignatureAssetHandler } from '$lib/http/signature-assets';
import { unsealRecipientSession } from '$lib/server/recipient-session';

export const POST = createSignatureAssetHandler(
	resolveSignatureAssetApplication,
	unsealRecipientSession
);
