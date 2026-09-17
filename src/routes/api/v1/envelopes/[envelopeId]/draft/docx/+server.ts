import { resolveDocxConversionService } from '$lib/application/documents/docx-conversion-runtime';
import { createDocxImportHandler } from '$lib/http/docx-import';

export const POST = createDocxImportHandler(resolveDocxConversionService);
