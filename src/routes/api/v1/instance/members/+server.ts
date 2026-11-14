import { resolveInstanceDisplayApplication } from '$lib/application/instance-display/instance-display-runtime';
import { resolveInstanceMemberApplication } from '$lib/application/instance/instance-runtime';
import {
	createInstanceMemberHttpHandlers,
	type InstanceMemberHttpHandlers
} from '$lib/http/instance-members';

const handlers: InstanceMemberHttpHandlers = createInstanceMemberHttpHandlers(
	resolveInstanceMemberApplication,
	resolveInstanceDisplayApplication
);

export const GET = handlers.list;
