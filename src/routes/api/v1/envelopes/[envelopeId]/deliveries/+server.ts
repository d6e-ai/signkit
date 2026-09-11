import { resolveDeliveryStatusService } from '$lib/application/delivery/delivery-runtime';
import { createDeliveryStatusHandler } from '$lib/http/delivery-status';

export const GET = createDeliveryStatusHandler(resolveDeliveryStatusService);
