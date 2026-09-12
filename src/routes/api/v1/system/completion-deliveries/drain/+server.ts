import { resolveCompletionDeliveryService } from '$lib/application/completion-delivery/completion-delivery-runtime';
import { createCompletionDeliveryDrainHandler } from '$lib/http/completion-delivery-drain';

export const POST = createCompletionDeliveryDrainHandler(resolveCompletionDeliveryService);
