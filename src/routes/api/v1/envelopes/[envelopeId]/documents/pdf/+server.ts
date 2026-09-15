import { resolveUploadedPdfUpload } from '$lib/application/documents/uploaded-pdf-runtime';
import { createPdfUploadHandler } from '$lib/http/envelope-pdf-upload';

export const POST = createPdfUploadHandler(resolveUploadedPdfUpload);
