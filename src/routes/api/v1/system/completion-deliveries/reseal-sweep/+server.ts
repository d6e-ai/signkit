import { resolveCompletionDeliveryResealSweepService } from '$lib/application/completion-delivery/completion-delivery-runtime';
import { createCompletionDeliveryResealSweepHandler } from '$lib/http/completion-delivery-reseal-sweep';

export const POST = createCompletionDeliveryResealSweepHandler(
	resolveCompletionDeliveryResealSweepService
);
