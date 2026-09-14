import { resolveEnvelopeDocumentPdfApplication } from '$lib/application/documents/envelope-document-pdf-runtime';
import { createEnvelopeDocumentPdfHandler } from '$lib/http/envelope-document-pdf';

export const GET = createEnvelopeDocumentPdfHandler(resolveEnvelopeDocumentPdfApplication, 'pdf');
