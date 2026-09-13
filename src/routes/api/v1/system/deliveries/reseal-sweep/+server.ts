import { resolveDeliveryResealSweepService } from '$lib/application/delivery/delivery-runtime';
import { createDeliveryResealSweepHandler } from '$lib/http/delivery-reseal-sweep';

export const POST = createDeliveryResealSweepHandler(resolveDeliveryResealSweepService);
