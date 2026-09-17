import { resolveDocxConversionService } from '$lib/application/documents/docx-conversion-runtime';
import { createDocxExportHandler } from '$lib/http/docx-export';

export const GET = createDocxExportHandler(resolveDocxConversionService);
