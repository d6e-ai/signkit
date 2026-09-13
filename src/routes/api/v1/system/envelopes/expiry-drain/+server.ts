import { resolveEnvelopeExpiryDrainService } from '$lib/application/delivery/envelope-expiry-runtime';
import { createEnvelopeExpiryDrainHandler } from '$lib/http/envelope-expiry-drain';

export const POST = createEnvelopeExpiryDrainHandler(resolveEnvelopeExpiryDrainService);
