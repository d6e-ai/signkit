import { resolveInstanceDisplayMaintenanceService } from '$lib/application/instance-display/instance-display-runtime';
import { createInstanceDisplayMaintainHandler } from '$lib/http/instance-display-maintain';

export const POST = createInstanceDisplayMaintainHandler(resolveInstanceDisplayMaintenanceService);
