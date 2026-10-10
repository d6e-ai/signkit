import { resolvePdfSealRuntime } from '$lib/application/pdf-seals/pdf-seal-runtime';
import { createPdfSealDrainHandler } from '$lib/http/pdf-seal-drain';

export const POST = createPdfSealDrainHandler(resolvePdfSealRuntime);
