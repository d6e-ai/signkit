import { resolveOrphanCollector } from '$lib/application/maintenance/orphan-collector-runtime';
import { createOrphanSweepHandler } from '$lib/http/orphan-sweep';

export const POST = createOrphanSweepHandler(resolveOrphanCollector);
