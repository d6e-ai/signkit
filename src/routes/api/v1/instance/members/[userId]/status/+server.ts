import { resolveInstanceMemberApplication } from '$lib/application/instance/instance-runtime';
import {
	createInstanceMemberHttpHandlers,
	type InstanceMemberHttpHandlers
} from '$lib/http/instance-members';

const handlers: InstanceMemberHttpHandlers = createInstanceMemberHttpHandlers(
	resolveInstanceMemberApplication
);

export const POST = handlers.setStatus;
