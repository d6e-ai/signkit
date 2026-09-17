import { resolveDocxConversionService } from '$lib/application/documents/docx-conversion-runtime';
import { createDocxConversionDrainHandler } from '$lib/http/docx-conversion-drain';

export const POST = createDocxConversionDrainHandler(resolveDocxConversionService);
