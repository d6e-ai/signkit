import { resolveInstanceInvitationApplication } from '$lib/application/instance/instance-runtime';
import {
	createInstanceInvitationHttpHandlers,
	type InstanceInvitationHttpHandlers
} from '$lib/http/instance-invitations';

const handlers: InstanceInvitationHttpHandlers = createInstanceInvitationHttpHandlers(
	resolveInstanceInvitationApplication
);

export const POST = handlers.accept;
