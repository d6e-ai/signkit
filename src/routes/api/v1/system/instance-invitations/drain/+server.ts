import { resolveInstanceInvitationDeliveryService } from '$lib/application/instance-invitations/instance-invitation-delivery-runtime';
import { createInstanceInvitationDeliveryDrainHandler } from '$lib/http/instance-invitation-delivery-drain';

export const POST = createInstanceInvitationDeliveryDrainHandler(
	resolveInstanceInvitationDeliveryService
);
