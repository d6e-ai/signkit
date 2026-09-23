import { resolvePdfSealApiRuntime } from '$lib/application/pdf-seals/pdf-seal-api-runtime';
import { createPdfSealRequestHandler, createPdfSealStatusHandler } from '$lib/http/pdf-seal';

export const GET = createPdfSealStatusHandler(resolvePdfSealApiRuntime);
export const POST = createPdfSealRequestHandler(resolvePdfSealApiRuntime);
