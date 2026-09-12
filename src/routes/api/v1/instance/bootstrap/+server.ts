import { resolveInstanceApplication } from '$lib/application/instance/instance-runtime';
import { createInstanceBootstrapHandler } from '$lib/http/instance-bootstrap';

export const POST = createInstanceBootstrapHandler(resolveInstanceApplication);
