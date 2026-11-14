import { resolveInstanceDisplayApplication } from '$lib/application/instance-display/instance-display-runtime';
import { resolveInstanceInvitationApplication } from '$lib/application/instance/instance-runtime';
import {
	createInstanceInvitationHttpHandlers,
	type InstanceInvitationHttpHandlers
} from '$lib/http/instance-invitations';

const handlers: InstanceInvitationHttpHandlers = createInstanceInvitationHttpHandlers(
	resolveInstanceInvitationApplication,
	resolveInstanceDisplayApplication
);

export const GET = handlers.list;
export const POST = handlers.create;
