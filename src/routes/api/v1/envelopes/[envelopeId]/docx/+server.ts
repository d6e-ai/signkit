import { resolveEnvelopeDocxExport } from '$lib/application/documents/docx-export-runtime';
import { createDocxExportHandler } from '$lib/http/docx-export';

export const GET = createDocxExportHandler(resolveEnvelopeDocxExport);
