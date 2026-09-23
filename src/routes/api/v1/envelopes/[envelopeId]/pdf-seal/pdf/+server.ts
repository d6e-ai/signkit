import { resolvePdfSealDownloadApplication } from '$lib/application/pdf-seals/pdf-seal-download-runtime';
import { createPdfSealDownloadHandler } from '$lib/http/pdf-seal-download';

const handler = createPdfSealDownloadHandler(resolvePdfSealDownloadApplication);

export const GET = handler;
export const HEAD = handler;
