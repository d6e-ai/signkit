import { resolveMaintenanceBacklogPort } from '$lib/observability/maintenance-backlog-runtime';
import { createMaintenanceHealthHandler } from '$lib/http/maintenance-health';

export const GET = createMaintenanceHealthHandler(resolveMaintenanceBacklogPort);
