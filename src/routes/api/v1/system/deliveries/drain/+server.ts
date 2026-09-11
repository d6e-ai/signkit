import { resolveInvitationDeliveryService } from '$lib/application/delivery/delivery-runtime';
import { createDeliveryDrainHandler } from '$lib/http/delivery-drain';

export const POST = createDeliveryDrainHandler(resolveInvitationDeliveryService);
