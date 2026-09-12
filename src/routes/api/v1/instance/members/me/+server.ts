import { resolveInstanceApplication } from '$lib/application/instance/instance-runtime';
import { createInstanceMemberMeHandler } from '$lib/http/instance-members';

export const GET = createInstanceMemberMeHandler(resolveInstanceApplication);
